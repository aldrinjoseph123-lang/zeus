import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';
import { alertOnNewSignIn } from '../auth/loginAlerts.js';
import { clearSessionCache } from '../auth/sessionStore.js';

/**
 * "Was this you?" — the half of the sessions work that goes looking, rather than
 * waiting to be looked at. What matters as much as firing is staying quiet: a first
 * sign-in, or a familiar laptop in a familiar country, must say nothing at all, or the
 * alert becomes noise nobody reads.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => { await resetDatabase(); clearSessionCache(); fx = await seedFixtures(app); });

const day = 86_400_000;

/** A past sign-in, straight into the table, so history can be set precisely. */
async function past(userId: string, device: string, country: string, daysAgo: number) {
  return prisma.session.create({
    data: { kind: 'internal', userId, device, country, city: 'Dubai', ip: '94.207.1.1', expiresAt: new Date(Date.now() + day), createdAt: new Date(Date.now() - daysAgo * day) },
  });
}
/** The sign-in under judgement. */
async function arriving(userId: string, device: string, country: string | null) {
  return prisma.session.create({
    data: { kind: 'internal', userId, device, country, city: country === 'NG' ? 'Lagos' : 'Dubai', isp: 'Some Telecom', ip: '102.89.33.7', expiresAt: new Date(Date.now() + day) },
  });
}
const alerts = () => prisma.notification.findMany({ where: { type: { in: ['login_new_device', 'login_new_country'] } }, orderBy: { createdAt: 'desc' } });

describe('login alerts: when to stay quiet', () => {
  it('says nothing about a first sign-in — there is nothing to compare it to', async () => {
    // Fixture cookies come with a session row of their own; a genuinely first sign-in has none.
    await prisma.session.deleteMany({ where: { userId: fx.rep.id } });
    const s = await arriving(fx.rep.id, 'Chrome on macOS', 'AE');
    await alertOnNewSignIn(s.id);
    assert.equal((await alerts()).length, 0);
  });

  it('says nothing about a familiar device in a familiar country', async () => {
    await past(fx.rep.id, 'Chrome on macOS', 'AE', 10);
    const s = await arriving(fx.rep.id, 'Chrome on macOS', 'AE');
    await alertOnNewSignIn(s.id);
    assert.equal((await alerts()).length, 0);
  });

  it('says nothing when the location could not be worked out', async () => {
    await past(fx.rep.id, 'Chrome on macOS', 'AE', 10);
    const s = await arriving(fx.rep.id, 'Chrome on macOS', null);
    await alertOnNewSignIn(s.id);
    assert.equal((await alerts()).length, 0, 'an unknown country is not a new one');
  });

  it('says nothing about an administrator previewing the portal', async () => {
    await past(fx.rep.id, 'Chrome on macOS', 'AE', 5);
    const s = await prisma.session.create({
      data: { kind: 'portal', userId: fx.rep.id, viewingAsId: fx.admin.id, device: 'Firefox on Linux', country: 'NG', expiresAt: new Date(Date.now() + day) },
    });
    await alertOnNewSignIn(s.id);
    assert.equal((await alerts()).length, 0, 'that is somebody looking on purpose');
  });

  it('treats a device last used more than three months ago as new again', async () => {
    await past(fx.rep.id, 'Chrome on macOS', 'AE', 10);
    await past(fx.rep.id, 'Safari on iPhone', 'AE', 120);
    const s = await arriving(fx.rep.id, 'Safari on iPhone', 'AE');
    await alertOnNewSignIn(s.id);
    const [alert] = await alerts();
    assert.ok(alert, 'outside the window it is unfamiliar again');
    assert.equal(alert.type, 'login_new_device');
  });
});

describe('login alerts: when to speak', () => {
  it('tells the person and the administrators about a new country, once', async () => {
    await past(fx.rep.id, 'Chrome on macOS', 'AE', 3);
    const s = await arriving(fx.rep.id, 'Chrome on macOS', 'NG');
    await alertOnNewSignIn(s.id);

    const rows = await alerts();
    assert.ok(rows.length >= 2, 'the person, plus the administrators');
    assert.ok(rows.every((r) => r.type === 'login_new_country'), 'one kind of alert, not two');
    const recipients = new Set(rows.map((r) => r.userId));
    assert.ok(recipients.has(fx.rep.id), 'the person whose account it is');
    assert.ok(recipients.has(fx.admin.id), 'and the administrators');
    assert.match(rows[0].title, /country not used before/);
    assert.match(String(rows[0].body), /Lagos|NG/, 'the message says where');
    assert.equal(rows[0].link, '/settings/profile', 'straight to where they can end it');
  });

  it('a new device in a known country is the quieter of the two events', async () => {
    await past(fx.rep.id, 'Chrome on macOS', 'AE', 3);
    const s = await arriving(fx.rep.id, 'Safari on iPhone', 'AE');
    await alertOnNewSignIn(s.id);
    const rows = await alerts();
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((r) => r.type === 'login_new_device'));
    assert.match(rows[0].title, /device not used before/);
  });

  it('a new device in a new country is still one alert, and says both', async () => {
    await past(fx.rep.id, 'Chrome on macOS', 'AE', 3);
    const s = await arriving(fx.rep.id, 'Firefox on Linux', 'NG');
    await alertOnNewSignIn(s.id);
    const rows = await alerts();
    assert.ok(rows.every((r) => r.type === 'login_new_country'), 'the louder signal names it');
    assert.match(rows[0].title, /a new device, in a country not used before/);
  });

  it('one person\'s history is not another\'s', async () => {
    await past(fx.admin.id, 'Firefox on Linux', 'NG', 3);
    await past(fx.rep.id, 'Chrome on macOS', 'AE', 3);
    // The rep arrives on the device and country only the admin has used.
    const s = await arriving(fx.rep.id, 'Firefox on Linux', 'NG');
    await alertOnNewSignIn(s.id);
    assert.ok((await alerts()).length >= 1, 'familiar to somebody else is still new to them');
  });

  it('a portal user is mailed directly, and the administrators told in-app', async () => {
    const account = await request(app, fx.admin).post('/api/accounts', { name: 'Alerted Partner', type: 'PARTNER', ignoreDuplicates: true });
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'Pat', lastName: 'Partner', email: 'pat@alerted.example', accountId: (account.body as { id: string }).id, ignoreDuplicates: true });
    const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: (contact.body as { id: string }).id });
    const portalUserId = (granted.body as { id: string }).id;

    await prisma.session.create({ data: { kind: 'portal', portalUserId, device: 'Chrome on Windows', country: 'AE', expiresAt: new Date(Date.now() + day), createdAt: new Date(Date.now() - 2 * day) } });
    const s = await prisma.session.create({ data: { kind: 'portal', portalUserId, device: 'Chrome on Windows', country: 'NG', city: 'Lagos', expiresAt: new Date(Date.now() + day) } });
    await alertOnNewSignIn(s.id);

    // No mailbox is configured in the suite, so the send fails — and the email log is
    // exactly where that failure has to show up rather than vanishing.
    const mail = await prisma.emailLog.findFirst({ where: { to: { has: 'pat@alerted.example' }, subject: { contains: 'Was this you' } } });
    assert.ok(mail, 'the attempt to warn them is recorded');
    assert.match(mail.subject, /Was this you/);
    const rows = await alerts();
    assert.ok(rows.some((r) => r.userId === fx.admin.id), 'administrators hear about it in-app');
    assert.ok(rows.every((r) => r.title.includes('(portal)')));
  });
});
