import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';
import { PORTAL_COOKIE } from '../portal/session.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { clearSessionCache, deviceFromUA, pruneSessions, revokeSession } from '../auth/sessionStore.js';

/**
 * Sessions as rows. The point of the whole phase is that a signed cookie is no longer
 * enough on its own: the row behind it must still be live, which is what makes signing
 * out, deactivating and revoking take effect on the very next request instead of
 * whenever the token happened to expire.
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
  clearSessionCache(); // ids repeat across tests; a stale entry would answer for a new row
  fx = await seedFixtures(app);
});

const asCookie = (cookie: string): TestUser => ({ id: '', email: '', name: '', roleName: '', cookie });
const cookieFrom = (res: { raw: { headers: Record<string, unknown> } }, name: string) =>
  String(res.raw.headers['set-cookie'] ?? '').match(new RegExp(`${name}=[^;]+`))?.[0] ?? '';

/** Sign in for real, so the cookie carries a session id the way a browser's would. */
async function signIn(email: string, password: string) {
  const res = await request(app).post('/api/auth/login', { email, password });
  return { status: res.status, cookie: cookieFrom(res, SESSION_COOKIE) };
}
const PASSWORD = 'Passw0rd!Test';

describe('sessions: a sign-in becomes a row', () => {
  it('records the sign-in, and the cookie stops working the moment the row is revoked', async () => {
    const { status, cookie } = await signIn(fx.admin.email, PASSWORD);
    assert.equal(status, 200);

    // The fixture cookie has a row too, so take the one this sign-in just made.
    const row = await prisma.session.findFirstOrThrow({ where: { userId: fx.admin.id }, orderBy: { createdAt: 'desc' } });
    assert.equal(row.kind, 'internal');
    assert.equal(row.revokedAt, null);
    assert.ok(row.expiresAt > new Date(), 'expiry mirrors the token');
    assert.ok(row.device, 'the device is recorded from the user agent');

    assert.equal((await request(app, asCookie(cookie)).get('/api/auth/me')).status, 200);
    await revokeSession(row.id, 'admin');
    assert.equal((await request(app, asCookie(cookie)).get('/api/auth/me')).status, 401, 'the same cookie is now refused');
  });

  it('signing out ends the session, not just the browser copy', async () => {
    const { cookie } = await signIn(fx.admin.email, PASSWORD);
    assert.equal((await request(app, asCookie(cookie)).post('/api/auth/logout', {})).status, 200);

    const row = await prisma.session.findFirstOrThrow({ where: { userId: fx.admin.id, revokedAt: { not: null } } });
    assert.ok(row.revokedAt, 'the row is closed');
    assert.equal(row.revokedBy, 'self');
    // The cookie the browser was told to drop still exists in a copy somewhere; it must not work.
    assert.equal((await request(app, asCookie(cookie)).get('/api/auth/me')).status, 401);
  });

  it('changing a password ends the other sessions but not the one doing it', async () => {
    const first = await signIn(fx.admin.email, PASSWORD);
    const second = await signIn(fx.admin.email, PASSWORD);

    const res = await request(app, asCookie(second.cookie)).post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'a-brand-new-password-9' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal((await request(app, asCookie(second.cookie)).get('/api/auth/me')).status, 200, 'the session that changed it survives');
    assert.equal((await request(app, asCookie(first.cookie)).get('/api/auth/me')).status, 401, 'the other one is out');
    const ended = await prisma.session.findFirstOrThrow({ where: { userId: fx.admin.id, revokedBy: 'password_change' } });
    assert.ok(ended.revokedAt);
  });

  it('deactivating someone ends the tabs they already have open', async () => {
    const rep = await signIn(fx.rep.email, PASSWORD);
    assert.equal((await request(app, asCookie(rep.cookie)).get('/api/auth/me')).status, 200);

    assert.equal((await request(app, fx.admin).del(`/api/users/${fx.rep.id}`)).status, 200);
    assert.equal((await request(app, asCookie(rep.cookie)).get('/api/auth/me')).status, 401);
    assert.ok(await prisma.session.findFirst({ where: { userId: fx.rep.id, revokedBy: 'deactivated' } }), 'their sessions are closed');
  });

  it('a token carrying no session id still works — nobody is thrown out by the deploy', async () => {
    const { signSessionToken } = await import('../auth/session.js');
    const before = await prisma.session.count();
    const legacy = `${SESSION_COOKIE}=${await signSessionToken(fx.admin.id, 12)}`;
    assert.equal((await request(app, asCookie(legacy)).get('/api/auth/me')).status, 200);
    assert.equal(await prisma.session.count(), before, 'and it creates no row of its own');
  });

  it('prunes only what has been over for a while', async () => {
    const old = await prisma.session.create({ data: { kind: 'internal', userId: fx.admin.id, expiresAt: new Date(Date.now() - 40 * 86_400_000) } });
    const recent = await prisma.session.create({ data: { kind: 'internal', userId: fx.admin.id, expiresAt: new Date(Date.now() - 2 * 86_400_000) } });
    const live = await prisma.session.create({ data: { kind: 'internal', userId: fx.admin.id, expiresAt: new Date(Date.now() + 86_400_000) } });

    assert.equal(await pruneSessions(30), 1, 'only the long-expired one goes');
    assert.equal(await prisma.session.findUnique({ where: { id: old.id } }), null);
    // A session that ended last week is still worth showing, and a live one is untouched.
    assert.ok(await prisma.session.findUnique({ where: { id: recent.id } }));
    assert.ok(await prisma.session.findUnique({ where: { id: live.id } }));
  });

  it('reads a device out of a user agent, and admits when it cannot', () => {
    assert.equal(deviceFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'Chrome on macOS');
    assert.equal(deviceFromUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'), 'Safari on iPhone');
    assert.equal(deviceFromUA(undefined), 'Unknown device');
  });
});

describe('sessions: the portal side', () => {
  beforeEach(async () => { await setSetting('portal.enabled', true, 'portal'); invalidateSettings(); });

  const id = (res: { body: unknown }) => (res.body as { id: string }).id;
  const PORTAL_PASSWORD = 'correct-horse-battery-staple';

  async function partnerWithAccess(email = 'pat@partner.example') {
    const account = await request(app, fx.admin).post('/api/accounts', { name: 'Partner Co', type: 'PARTNER', ignoreDuplicates: true });
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'Pat', lastName: 'Partner', email, accountId: id(account), ignoreDuplicates: true });
    const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(contact) });
    await prisma.portalUser.update({ where: { id: id(granted) }, data: { passwordHash: await import('bcryptjs').then((b) => b.default.hash(PORTAL_PASSWORD, 10)) } });
    const login = await request(app).post('/api/portal/auth/login', { email, password: PORTAL_PASSWORD });
    return { portalUserId: id(granted), cookie: cookieFrom(login, PORTAL_COOKIE) };
  }

  it('a portal sign-in is a row too, and revoking access ends it at once', async () => {
    const pat = await partnerWithAccess();
    const row = await prisma.session.findFirstOrThrow({ where: { portalUserId: pat.portalUserId } });
    assert.equal(row.kind, 'portal');
    assert.equal((await request(app, asCookie(pat.cookie)).get('/api/portal/me')).status, 200);

    assert.equal((await request(app, fx.admin).post(`/api/portal-admin/users/${pat.portalUserId}/revoke`, {})).status, 200);
    assert.equal((await request(app, asCookie(pat.cookie)).get('/api/portal/me')).status, 401, 'the live session ends with the access');
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: row.id } })).revokedBy, 'portal_revoked');
  });

  it('signing out of the portal ends its row', async () => {
    const pat = await partnerWithAccess();
    assert.equal((await request(app, asCookie(pat.cookie)).post('/api/portal/auth/logout', {})).status, 200);
    assert.equal((await prisma.session.findFirstOrThrow({ where: { portalUserId: pat.portalUserId } })).revokedBy, 'self');
    assert.equal((await request(app, asCookie(pat.cookie)).get('/api/portal/me')).status, 401);
  });

  it('a preview is a session, attributed to the admin behind it', async () => {
    const pat = await partnerWithAccess();
    const view = await request(app, fx.admin).post(`/api/portal-admin/users/${pat.portalUserId}/view-as`, {});
    assert.equal(view.status, 200);
    const token = String((view.body as { url: string }).url).split('token=')[1];
    const started = await request(app).post('/api/portal/auth/view-as', { token });
    assert.equal(started.status, 200);

    const preview = await prisma.session.findFirstOrThrow({ where: { viewingAsId: fx.admin.id } });
    assert.equal(preview.kind, 'portal');
    assert.equal(preview.portalUserId, pat.portalUserId);
    assert.ok(preview.expiresAt.getTime() - Date.now() < 45 * 60_000, 'a preview is short');
  });
});

describe('sessions: the screens behind them', () => {
  it('an administrator sees everyone, marked with which one is theirs', async () => {
    const { cookie } = await signIn(fx.admin.email, PASSWORD);
    await signIn(fx.rep.email, PASSWORD);

    const rows = (await request(app, asCookie(cookie)).get('/api/sessions')).body as Array<{ who: string; isCurrent: boolean; active: boolean; device: string; where: string }>;
    assert.ok(rows.length >= 2);
    assert.ok(rows.some((r) => r.who === 'rep'), 'the rep is in the list');
    assert.equal(rows.filter((r) => r.isCurrent).length, 1, 'exactly one row is this session');
    const mine = rows.find((r) => r.isCurrent)!;
    assert.ok(mine.active, 'just signed in, so active');
    assert.ok(mine.device.length > 0);
    assert.ok(mine.where.length > 0, 'always says something, even if only the address');
  });

  it('a rep sees only their own devices, and cannot list everyone', async () => {
    const rep = await signIn(fx.rep.email, PASSWORD);
    await signIn(fx.admin.email, PASSWORD);

    assert.equal((await request(app, asCookie(rep.cookie)).get('/api/sessions')).status, 403);
    const mine = (await request(app, asCookie(rep.cookie)).get('/api/sessions/mine')).body as Array<{ who: string; isCurrent: boolean }>;
    assert.ok(mine.length >= 1);
    assert.ok(mine.every((r) => r.who === 'rep'), 'nobody else appears');
    assert.equal(mine.filter((r) => r.isCurrent).length, 1);
  });

  it('signing out the others leaves exactly this one', async () => {
    const first = await signIn(fx.rep.email, PASSWORD);
    const second = await signIn(fx.rep.email, PASSWORD);

    const res = await request(app, asCookie(second.cookie)).post('/api/sessions/mine/sign-out-others', {});
    assert.equal(res.status, 200);
    assert.ok((res.body as { ended: number }).ended >= 1);

    assert.equal((await request(app, asCookie(second.cookie)).get('/api/auth/me')).status, 200, 'the one that asked survives');
    assert.equal((await request(app, asCookie(first.cookie)).get('/api/auth/me')).status, 401);
    const left = (await request(app, asCookie(second.cookie)).get('/api/sessions/mine')).body as unknown[];
    assert.equal(left.length, 1);
  });

  it('an administrator can end someone else\'s; a rep cannot, and nobody ends the one they are using', async () => {
    const rep = await signIn(fx.rep.email, PASSWORD);
    const admin = await signIn(fx.admin.email, PASSWORD);
    const repRow = await prisma.session.findFirstOrThrow({ where: { userId: fx.rep.id, revokedAt: null }, orderBy: { createdAt: 'desc' } });
    const adminRow = await prisma.session.findFirstOrThrow({ where: { userId: fx.admin.id, revokedAt: null }, orderBy: { createdAt: 'desc' } });

    assert.equal((await request(app, asCookie(rep.cookie)).del(`/api/sessions/${adminRow.id}`)).status, 403, 'a rep cannot reach into someone else\'s');
    assert.equal((await request(app, asCookie(admin.cookie)).del(`/api/sessions/${adminRow.id}`)).status, 400, 'not the one you are holding');

    assert.equal((await request(app, asCookie(admin.cookie)).del(`/api/sessions/${repRow.id}`)).status, 200);
    assert.equal((await request(app, asCookie(rep.cookie)).get('/api/auth/me')).status, 401, 'the rep is out at once');
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: repRow.id } })).revokedBy, 'admin');
    assert.equal((await request(app, asCookie(admin.cookie)).del(`/api/sessions/${repRow.id}`)).status, 400, 'already ended');
  });

  it('a portal preview says whose eyes it really is', async () => {
    const { cookie } = await signIn(fx.admin.email, PASSWORD);
    await setSetting('portal.enabled', true, 'portal');
    invalidateSettings();
    const account = await request(app, fx.admin).post('/api/accounts', { name: 'Preview Co', type: 'PARTNER', ignoreDuplicates: true });
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'Peek', lastName: 'Partner', email: 'peek@partner.example', accountId: (account.body as { id: string }).id, ignoreDuplicates: true });
    const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: (contact.body as { id: string }).id });
    const view = await request(app, fx.admin).post(`/api/portal-admin/users/${(granted.body as { id: string }).id}/view-as`, {});
    const token = String((view.body as { url: string }).url).split('token=')[1];
    await request(app).post('/api/portal/auth/view-as', { token });

    const rows = (await request(app, asCookie(cookie)).get('/api/sessions?kind=portal')).body as Array<{ previewBy: string | null; who: string }>;
    const preview = rows.find((r) => r.previewBy);
    assert.ok(preview, 'the preview is listed');
    assert.equal(preview.previewBy, 'admin');
    assert.equal(preview.who, 'Peek Partner', 'shown as the contact, flagged as a preview');
  });
});
