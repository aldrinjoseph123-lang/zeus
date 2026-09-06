import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';
import { PORTAL_COOKIE, signPortalToken } from '../portal/session.js';

/**
 * Portal foundation. The rules under test are the ones the whole portal stands on:
 * off by default; the only writes are the auth routes; sign-in needs a password that
 * was set from a link; revocation and a customer's lapsed subscription close the door
 * on the next request; an internal session is not a portal session.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetDatabase();
  fx = await seedFixtures(app);
  await setSetting('portal.enabled', true, 'portal');
  invalidateSettings();
});

const id = (res: { body: unknown }) => (res.body as { id: string }).id;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** A TestUser-shaped carrier for a portal cookie; request() only reads .cookie. */
const asPortal = (cookie: string): TestUser => ({ id: '', email: '', name: '', roleName: '', cookie });

async function partnerContact(email = 'pat@partner.example') {
  const account = await request(app, fx.admin).post('/api/accounts', { name: 'Channel Partner LLC', type: 'PARTNER', ignoreDuplicates: true });
  const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'Pat', lastName: 'Partner', email, accountId: id(account), ignoreDuplicates: true });
  return { accountId: id(account), contactId: id(contact), email };
}

/** Grant, then do what the emailed link would let the person do — set a password. */
async function grantWithPassword(contactId: string, password = 'correct-horse-battery-staple') {
  const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  const portalUserId = id(granted);
  const token = randomBytes(32).toString('hex');
  await prisma.portalUser.update({ where: { id: portalUserId }, data: { linkTokenHash: sha256(token), linkExpiresAt: new Date(Date.now() + 60_000) } });
  const set = await request(app).post('/api/portal/auth/set-password', { token, password });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  return { portalUserId, token };
}

async function signIn(email: string, password: string) {
  const res = await request(app).post('/api/portal/auth/login', { email, password });
  const cookie = String(res.raw.headers['set-cookie'] ?? '').match(new RegExp(`${PORTAL_COOKIE}=[^;]+`))?.[0] ?? '';
  return { status: res.status, cookie };
}

describe('portal: switched off by default', () => {
  it('answers 503 to everything, auth included, until an admin turns it on', async () => {
    await setSetting('portal.enabled', false, 'portal'); invalidateSettings();
    assert.equal((await request(app).get('/api/portal/me')).status, 503);
    assert.equal((await request(app).post('/api/portal/auth/login', { email: 'x@y.example', password: 'whatever' })).status, 503);
  });
});

describe('portal: access is granted, not implied', () => {
  it('a contact under a partner account cannot sign in until an admin grants access', async () => {
    const { email } = await partnerContact();
    const link = await request(app).post('/api/portal/auth/link', { email });
    assert.equal(link.status, 200);
    assert.match(String((link.body as { message: string }).message), /If your email is registered/);
    assert.equal((await signIn(email, 'anything-at-all-12')).status, 401);
  });

  it('the link request answers identically for a known and an unknown address', async () => {
    const { contactId, email } = await partnerContact();
    await request(app, fx.admin).post('/api/portal-admin/users', { contactId });
    const known = await request(app).post('/api/portal/auth/link', { email });
    const unknown = await request(app).post('/api/portal/auth/link', { email: 'nobody@nowhere.example' });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(known.body, unknown.body);
  });

  it('grant fails closed when the email is shared by another contact', async () => {
    const { contactId, accountId } = await partnerContact('shared@partner.example');
    await request(app, fx.admin).post('/api/contacts', { firstName: 'Other', lastName: 'Person', email: 'Shared@partner.example', accountId, ignoreDuplicates: true });
    const res = await request(app, fx.admin).post('/api/portal-admin/users', { contactId });
    assert.equal(res.status, 400);
    assert.match(String((res.body as { error: string }).error), /other contact/);
  });

  it('a contact with no email, or at a prospect, cannot be granted', async () => {
    const noEmail = await request(app, fx.admin).post('/api/contacts', { firstName: 'No', lastName: 'Mail', accountId: (await partnerContact()).accountId, ignoreDuplicates: true });
    assert.equal((await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(noEmail) })).status, 400);
    const prospect = await request(app, fx.admin).post('/api/accounts', { name: 'Just Looking', type: 'PROSPECT', ignoreDuplicates: true });
    const pc = await request(app, fx.admin).post('/api/contacts', { firstName: 'P', lastName: 'C', email: 'pc@prospect.example', accountId: id(prospect), ignoreDuplicates: true });
    assert.equal((await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(pc) })).status, 400);
  });

  it('portal administration is closed to a role without the portal module', async () => {
    assert.equal((await request(app, fx.rep).get('/api/portal-admin/users')).status, 403);
    assert.equal((await request(app, fx.rep).post('/api/portal-admin/users', { contactId: 'x' })).status, 403);
  });
});

describe('portal: link → password → sign-in', () => {
  it('the link sets a password once; a reused or short attempt is refused', async () => {
    const { contactId, email } = await partnerContact('patricia@partner.example');
    const { token } = await grantWithPassword(contactId);
    assert.equal((await request(app).post('/api/portal/auth/set-password', { token, password: 'another-long-password-1' })).status, 400, 'single use');
    const { portalUserId } = { portalUserId: (await prisma.portalUser.findUniqueOrThrow({ where: { email } })).id };
    const fresh = randomBytes(32).toString('hex');
    await prisma.portalUser.update({ where: { id: portalUserId }, data: { linkTokenHash: sha256(fresh), linkExpiresAt: new Date(Date.now() + 60_000) } });
    const short = await request(app).post('/api/portal/auth/set-password', { token: fresh, password: 'short' });
    assert.equal(short.status, 400);
    assert.match(String((short.body as { error: string }).error), /at least 12/);
    // Long enough is not enough: one character class, or built from the address, is refused — and the link survives the refusal.
    const letters = await request(app).post('/api/portal/auth/set-password', { token: fresh, password: 'onlylettersinhere' });
    assert.equal(letters.status, 400); assert.match(String((letters.body as { error: string }).error), /numbers or symbols/);
    const local = email.split('@')[0];
    const fromEmail = await request(app).post('/api/portal/auth/set-password', { token: fresh, password: `${local}-2026!!` });
    assert.equal(fromEmail.status, 400); assert.match(String((fromEmail.body as { error: string }).error), /email address/);
    assert.equal((await request(app).post('/api/portal/auth/set-password', { token: fresh, password: 'Strong-enough-pass-9' })).status, 200, 'link still usable after refusals');
  });

  it('signs in with the password, reads /me through an allowlist, and cannot write', async () => {
    const { contactId, email } = await partnerContact();
    await grantWithPassword(contactId, 'correct-horse-battery-staple');
    const { status, cookie } = await signIn(email, 'correct-horse-battery-staple');
    assert.equal(status, 200);
    assert.ok(cookie.startsWith(`${PORTAL_COOKIE}=`), 'portal cookie issued');

    const me = await request(app, asPortal(cookie)).get('/api/portal/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.body, { name: 'Pat Partner', email, account: { name: 'Channel Partner LLC', type: 'PARTNER' } });

    assert.equal((await request(app, asPortal(cookie)).post('/api/portal/me', {})).status, 405);
    assert.equal((await request(app).get('/api/portal/me')).status, 401);

    const read = await prisma.auditLog.findFirst({ where: { action: 'portal_read', entity: 'PortalUser' } });
    assert.ok(read, 'portal reads are logged');
    assert.equal(read.userId, null);
  });

  it('an internal session is not a portal session', async () => {
    assert.equal((await request(app, fx.admin).get('/api/portal/me')).status, 401);
  });

  it('locks the account after repeated wrong passwords', async () => {
    await setSetting('portal.lockout.attempts', 3, 'portal'); invalidateSettings();
    const { contactId, email } = await partnerContact();
    await grantWithPassword(contactId, 'correct-horse-battery-staple');
    for (let i = 0; i < 3; i++) assert.equal((await signIn(email, 'wrong-password-attempt')).status, 401);
    assert.equal((await signIn(email, 'correct-horse-battery-staple')).status, 401, 'right password refused while locked');
    const pu = await prisma.portalUser.findUniqueOrThrow({ where: { email } });
    assert.ok(pu.lockedUntil && pu.lockedUntil > new Date());
  });
});

describe('portal: the door closes on the next request', () => {
  it('revoke, then restore', async () => {
    const { contactId, email } = await partnerContact();
    const { portalUserId } = await grantWithPassword(contactId);
    const { cookie } = await signIn(email, 'correct-horse-battery-staple');
    assert.equal((await request(app, asPortal(cookie)).get('/api/portal/me')).status, 200);

    assert.equal((await request(app, fx.admin).post(`/api/portal-admin/users/${portalUserId}/revoke`, {})).status, 200);
    assert.equal((await request(app, asPortal(cookie)).get('/api/portal/me')).status, 401, 'same cookie, now refused');

    assert.equal((await request(app, fx.admin).post(`/api/portal-admin/users/${portalUserId}/restore`, {})).status, 200);
    assert.equal((await request(app, asPortal(cookie)).get('/api/portal/me')).status, 200);
  });

  it('a customer qualifies only while a subscription is live', async () => {
    const customer = await request(app, fx.admin).post('/api/accounts', { name: 'Paying Customer', type: 'CUSTOMER', ignoreDuplicates: true });
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'Cus', lastName: 'Tomer', email: 'cus@customer.example', accountId: id(customer), ignoreDuplicates: true });
    const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(contact) });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    // Nothing running yet, so even the set-password link would refuse — plant the password
    // directly to prove the sign-in gate itself, not the link.
    await prisma.portalUser.update({ where: { id: id(granted) }, data: { passwordHash: await bcrypt.hash('correct-horse-battery-staple', 10) } });
    assert.equal((await signIn('cus@customer.example', 'correct-horse-battery-staple')).status, 401, 'no live subscription → no sign-in');

    const sub = await request(app, fx.admin).post('/api/subscriptions', { accountId: id(customer), description: 'MDR', quantity: 1, unitPrice: 1000, termMonths: 12, startDate: new Date().toISOString().slice(0, 10) });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const { status, cookie } = await signIn('cus@customer.example', 'correct-horse-battery-staple');
    assert.equal(status, 200, 'live subscription → sign-in');
    const me = await request(app, asPortal(cookie)).get('/api/portal/me');
    assert.equal((me.body as { account: { type: string } }).account.type, 'CUSTOMER');

    await request(app, fx.admin).post(`/api/subscriptions/${id(sub)}/cancel`, { reason: 'test' });
    assert.equal((await request(app, asPortal(cookie)).get('/api/portal/me')).status, 401, 'cancelled → refused on the next request');
  });

  it('a forged or internal-issuer token is refused', async () => {
    const { contactId } = await partnerContact();
    const { portalUserId } = await grantWithPassword(contactId);
    const good = await signPortalToken(portalUserId, 5);
    assert.equal((await request(app, asPortal(`${PORTAL_COOKIE}=${good}`)).get('/api/portal/me')).status, 200);
    assert.equal((await request(app, asPortal(`${PORTAL_COOKIE}=${good.slice(0, -4)}xxxx`)).get('/api/portal/me')).status, 401);
  });
});

describe('portal: view as (an admin previewing the portal as a contact)', () => {
  it('mints a short-lived hand-off, the portal exchanges it, and every read names the admin', async () => {
    const { contactId, email } = await partnerContact();
    const { portalUserId } = await grantWithPassword(contactId);

    const minted = await request(app, fx.admin).post(`/api/portal-admin/users/${portalUserId}/view-as`, {});
    assert.equal(minted.status, 200, JSON.stringify(minted.body));
    const url = new URL((minted.body as { url: string }).url);
    assert.equal(url.pathname, '/view-as');
    const token = url.searchParams.get('token')!;

    const exchange = await request(app).post('/api/portal/auth/view-as', { token });
    assert.equal(exchange.status, 200, JSON.stringify(exchange.body));
    const cookie = String(exchange.raw.headers['set-cookie'] ?? '').match(new RegExp(`${PORTAL_COOKIE}=[^;]+`))![0];

    const me = await request(app, asPortal(cookie)).get('/api/portal/me');
    assert.equal(me.status, 200);
    assert.equal((me.body as { email: string; viewingAs?: string }).email, email);
    assert.equal((me.body as { viewingAs?: string }).viewingAs, fx.admin.name);

    const read = await prisma.auditLog.findFirst({ where: { action: 'portal_read', entityId: portalUserId }, orderBy: { at: 'desc' } });
    assert.match(read?.summary ?? '', new RegExp(`viewed by ${fx.admin.name}`));

    assert.equal((await request(app).post('/api/portal/auth/view-as', { token: token.slice(0, -3) + 'xyz' })).status, 400, 'a tampered token is refused');
  });

  it('works while the portal is switched off, so it can be set up before outsiders see it', async () => {
    const { contactId } = await partnerContact();
    const { portalUserId } = await grantWithPassword(contactId);
    await setSetting('portal.enabled', false, 'portal'); invalidateSettings();
    const minted = await request(app, fx.admin).post(`/api/portal-admin/users/${portalUserId}/view-as`, {});
    const token = new URL((minted.body as { url: string }).url).searchParams.get('token')!;
    const exchange = await request(app).post('/api/portal/auth/view-as', { token });
    assert.equal(exchange.status, 200, 'preview exchange bypasses the kill switch');
    const cookie = String(exchange.raw.headers['set-cookie'] ?? '').match(new RegExp(`${PORTAL_COOKIE}=[^;]+`))![0];
    assert.equal((await request(app, asPortal(cookie)).get('/api/portal/me')).status, 200, 'preview reads bypass it too');
    assert.equal((await request(app).get('/api/portal/me')).status, 503, 'everyone else still gets 503');
  });

  it('only a role with the portal module can mint a preview', async () => {
    const { contactId } = await partnerContact();
    const { portalUserId } = await grantWithPassword(contactId);
    assert.equal((await request(app, fx.rep).post(`/api/portal-admin/users/${portalUserId}/view-as`, {})).status, 403);
  });
});
