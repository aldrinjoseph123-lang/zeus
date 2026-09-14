import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateTestDatabase, prisma, resetDatabase } from './harness.js';
import { componentStatuses } from '../services/systemStatus.js';

/**
 * What the status page calls "down" after a network blip.
 *
 * Found in production on 14 Sep 2026: the router's DNS dropped lookups for an afternoon.
 * Two alert emails failed at 15:00 and email then showed red until 15:00 the next day,
 * even though the 16:00 mail went. A Teams card failed at 16:00, so Teams was marked
 * broken, and that raised a "Teams alerts is down" alert which posted fine a second
 * later. Both components reported the past as if it were now.
 */

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); });

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

/** Microsoft answers everything; `teamsHost` decides whether the Teams host answers. */
async function network(teamsHost: 'up' | 'down') {
  const { saveM365, resetTokenCache } = await import('../services/graph.js');
  await saveM365({ tenantId: 't', clientId: 'c', senderUpn: 'zeus@example.com' } as never, 'secret');
  resetTokenCache();
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('webhook.office.com') && teamsHost === 'down') throw new TypeError('fetch failed');
    if (url.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
}

const component = async (key: string) => (await componentStatuses()).find((c) => c.key === key)!;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe('outbound email', () => {
  it('a failed send followed by one that went is a blip that is over', async () => {
    await network('up');
    await prisma.emailLog.createMany({
      data: [
        { subject: 'Bot protection is down', status: 'FAILED', error: 'fetch failed', createdAt: minutesAgo(60) },
        { subject: 'Bot protection is down', status: 'SENT', createdAt: minutesAgo(1) },
      ],
    });
    const email = await component('email');
    assert.equal(email.ok, true, email.detail);
  });

  it('the most recent send failing is still down', async () => {
    await network('up');
    await prisma.emailLog.createMany({
      data: [
        { subject: 'Quote', status: 'SENT', createdAt: minutesAgo(60) },
        { subject: 'Quote', status: 'FAILED', error: 'Mail.Send not consented', createdAt: minutesAgo(1) },
      ],
    });
    const email = await component('email');
    assert.equal(email.ok, false);
    assert.match(email.detail, /Mail.Send not consented/);
  });
});

describe('Teams alerts', () => {
  const hook = (lastError: string) => prisma.teamsWebhook.create({
    data: { name: 'zeus', url: 'https://example.webhook.office.com/webhookb2/abc', isDefault: true, lastError },
  });

  it('a post that never reached Teams is forgotten once the host answers again', async () => {
    await network('up');
    await hook('fetch failed');
    const teams = await component('teams');
    assert.equal(teams.ok, true, 'without this, one blip holds Teams down until some other alert posts');
  });

  it('while the host still does not answer, it is down', async () => {
    await network('down');
    await hook('fetch failed');
    assert.equal((await component('teams')).ok, false);
  });

  it('an error Teams sent back stays down however reachable the host is', async () => {
    await network('up');
    await hook('Teams webhook failed (404): channel not found');
    assert.equal((await component('teams')).ok, false, 'a deleted channel answers fine and still swallows every alert');
  });
});
