import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';
import { saveTurnstile } from '../portal/requests.js';
import { clearSessionCache } from '../auth/sessionStore.js';

/**
 * The bot check in front of the staff sign-in.
 *
 * The thing worth proving is not that it blocks — it is that it cannot lock the team
 * out of their own CRM. It stays off until deliberately switched on, Microsoft sign-in
 * never sees it, and an outage at Cloudflare lets people in while saying so in the log.
 * Only an actual refusal stops anybody.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); globalThis.fetch = realFetch; });
beforeEach(async () => { await resetDatabase(); clearSessionCache(); fx = await seedFixtures(app); globalThis.fetch = realFetch; });

const realFetch = globalThis.fetch;
const PASSWORD = 'Passw0rd!Test';

/** Answer for Cloudflare's siteverify without leaving the machine. */
function cloudflareSays(outcome: 'yes' | 'no' | 'down') {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (!String(input instanceof Request ? input.url : input).includes('siteverify')) return realFetch(input as never);
    if (outcome === 'down') throw new Error('unreachable');
    return new Response(JSON.stringify({ success: outcome === 'yes' }), { status: 200 });
  }) as typeof fetch;
}

async function turnOn() {
  await saveTurnstile('0xSITEKEY', '0xSECRET');
  await setSetting('auth.turnstileOnLogin', true, 'auth');
  invalidateSettings();
}
const signIn = (body: Record<string, unknown>) => request(app).post('/api/auth/login', { email: fx.admin.email, password: PASSWORD, ...body });

describe('bot check on the staff sign-in: staying out of the way', () => {
  it('is off until switched on, even once the keys are saved', async () => {
    await saveTurnstile('0xSITEKEY', '0xSECRET');
    invalidateSettings();
    assert.equal((await signIn({})).status, 200, 'configuring the portal form must not gate the whole team');

    const config = (await request(app).get('/api/auth/config')).body as { turnstileSiteKey: string | null };
    assert.equal(config.turnstileSiteKey, null, 'and the page draws no widget it does not need');
  });

  it('tells the page its site key once it is on', async () => {
    await turnOn();
    const config = (await request(app).get('/api/auth/config')).body as { turnstileSiteKey: string | null };
    assert.equal(config.turnstileSiteKey, '0xSITEKEY');
  });

  it('lets people in when Cloudflare cannot be reached, and says so', async () => {
    await turnOn();
    cloudflareSays('down');
    assert.equal((await signIn({ turnstileToken: 'whatever' })).status, 200, 'their outage is not our lockout');
    const logged = await prisma.systemLog.findFirst({ where: { source: 'auth', message: { contains: 'Turnstile could not be reached' } } });
    assert.ok(logged, 'and it is not silent about having skipped the check');
    assert.equal(logged.level, 'warn');
  });
});

describe('bot check on the staff sign-in: doing its job', () => {
  it('refuses a sign-in Cloudflare rejects, before the password is even considered', async () => {
    await turnOn();
    cloudflareSays('no');
    const res = await signIn({ turnstileToken: 'forged' });
    assert.equal(res.status, 400);
    assert.match(String((res.body as { error: string }).error), /bot check/i);

    // Refused on the check, not on the credentials: the right password got the same
    // answer, and no failed-password attempt was recorded against the account.
    const failures = await prisma.auditLog.count({ where: { action: 'login_failed', entityId: fx.admin.id } });
    assert.equal(failures, 0, 'a bot cannot burn through somebody\'s lockout budget');
  });

  it('records the refusal so a flood is visible in the audit trail', async () => {
    await turnOn();
    cloudflareSays('no');
    await signIn({ turnstileToken: 'forged' });
    const row = await prisma.auditLog.findFirst({ where: { action: 'login_failed' }, orderBy: { at: 'desc' } });
    assert.ok(row);
    assert.match(String(row.summary), /bot check refused/);
  });

  it('a missing token is a refusal — the widget cannot simply be left out', async () => {
    await turnOn();
    cloudflareSays('yes');
    assert.equal((await signIn({})).status, 400);
  });

  it('lets a genuine sign-in through and issues the session', async () => {
    await turnOn();
    cloudflareSays('yes');
    const res = await signIn({ turnstileToken: 'a-real-one' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(await prisma.session.findFirst({ where: { userId: fx.admin.id, revokedAt: null } }));
  });

  it('still refuses the wrong password once the check passes', async () => {
    await turnOn();
    cloudflareSays('yes');
    const res = await request(app).post('/api/auth/login', { email: fx.admin.email, password: 'not-the-password', turnstileToken: 'a-real-one' });
    assert.equal(res.status, 401, 'the bot check is a door in front of the lock, not instead of it');
  });
});
