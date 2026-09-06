import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';
import { PORTAL_COOKIE } from '../portal/session.js';

/**
 * The customer screen: the services they own and when each renews, scoped to their
 * account, allowlisted so no cost, price or vendor leaks; only live-ish states show.
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
const asPortal = (cookie: string): TestUser => ({ id: '', email: '', name: '', roleName: '', cookie });
const day = 86_400_000;
const endingIn = (days: number) => new Date(Date.now() + days * day);

/** A customer with one contact who has portal access and a password — but only signs in with a live subscription. */
async function customer(name: string, email: string) {
  const account = await request(app, fx.admin).post('/api/accounts', { name, type: 'CUSTOMER', ignoreDuplicates: true });
  const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'C', lastName: name, email, accountId: id(account), ignoreDuplicates: true });
  const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(contact) });
  await prisma.portalUser.update({ where: { id: id(granted) }, data: { passwordHash: await import('bcryptjs').then((b) => b.default.hash('correct-horse-battery-staple', 10)) } });
  return { accountId: id(account), portalUserId: id(granted) };
}
async function signIn(email: string) {
  const res = await request(app).post('/api/portal/auth/login', { email, password: 'correct-horse-battery-staple' });
  const cookie = String(res.raw.headers['set-cookie'] ?? '').match(new RegExp(`${PORTAL_COOKIE}=[^;]+`))?.[0] ?? '';
  return { status: res.status, cookie };
}
/** Create a subscription directly, so status and dates can be set precisely. */
async function sub(accountId: string, data: Partial<{ status: string; endDate: Date; startDate: Date; description: string; quantity: number; unit: string; unitPrice: number; unitCost: number }>) {
  const ref = 'ZEU-SUB-' + randomBytes(3).toString('hex');
  return prisma.subscription.create({ data: {
    reference: ref, accountId, description: data.description ?? 'Managed detection', quantity: data.quantity ?? 10, unit: data.unit ?? 'endpoint',
    unitPrice: data.unitPrice ?? 120, unitCost: data.unitCost ?? 70, termValue: 1200, startDate: data.startDate ?? endingIn(-300), endDate: data.endDate ?? endingIn(60),
    termMonths: 12, status: (data.status ?? 'ACTIVE') as never,
  } });
}

type Row = { reference: string; description: string; product: string | null; quantity: number; unit: string; endDate: string; daysLeft: number; status: string };

describe('portal: the customer screen', () => {
  it('shows the account\'s live services, allowlisted, soonest renewal first', async () => {
    const c = await customer('Acme Corp', 'ops@acme.example');
    await sub(c.accountId, { description: 'MDR', quantity: 40, unit: 'endpoint', endDate: endingIn(90), unitPrice: 200, unitCost: 120 });
    await sub(c.accountId, { description: 'Email security', quantity: 40, unit: 'mailbox', endDate: endingIn(20) });
    // Another customer's subscription must never appear here.
    const other = await customer('Other Corp', 'ops@other.example');
    await sub(other.accountId, { description: 'Theirs', endDate: endingIn(5) });

    const { status, cookie } = await signIn('ops@acme.example');
    assert.equal(status, 200);
    const rows = (await request(app, asPortal(cookie)).get('/api/portal/subscriptions')).body as Row[];
    assert.equal(rows.length, 2, 'only Acme\'s two');
    assert.deepEqual(rows.map((r) => r.description), ['Email security', 'MDR'], 'soonest renewal first');
    assert.equal(rows[1].quantity, 40);
    assert.equal(rows[1].unit, 'endpoint');
    assert.equal(rows[1].daysLeft, 90);
    // No economics.
    assert.doesNotMatch(JSON.stringify(rows), /unitCost|unitPrice|termValue|120|200|vendor|ownerId/);
  });

  it('shows LAPSED for 30 days then drops it; never CANCELLED or RENEWED', async () => {
    const c = await customer('Acme Corp', 'ops@acme.example');
    await sub(c.accountId, { description: 'live', status: 'ACTIVE', endDate: endingIn(45) });        // keep alive for sign-in
    await sub(c.accountId, { description: 'expiring', status: 'EXPIRING', endDate: endingIn(10) });
    await sub(c.accountId, { description: 'just lapsed', status: 'LAPSED', endDate: endingIn(-10) });
    await sub(c.accountId, { description: 'long lapsed', status: 'LAPSED', endDate: endingIn(-45) });
    await sub(c.accountId, { description: 'cancelled', status: 'CANCELLED', endDate: endingIn(30) });
    await sub(c.accountId, { description: 'renewed', status: 'RENEWED', endDate: endingIn(30) });

    const { cookie } = await signIn('ops@acme.example');
    const rows = (await request(app, asPortal(cookie)).get('/api/portal/subscriptions')).body as Row[];
    assert.deepEqual(rows.map((r) => r.description).sort(), ['expiring', 'just lapsed', 'live'], 'active, expiring, recently-lapsed only');
  });

  it('a partner gets 404 here; an outsider 401', async () => {
    const account = await request(app, fx.admin).post('/api/accounts', { name: 'Partner Co', type: 'PARTNER', ignoreDuplicates: true });
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'P', lastName: 'P', email: 'p@partner.example', accountId: id(account), ignoreDuplicates: true });
    const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(contact) });
    await prisma.portalUser.update({ where: { id: id(granted) }, data: { passwordHash: await import('bcryptjs').then((b) => b.default.hash('correct-horse-battery-staple', 10)) } });
    const { cookie } = await signIn('p@partner.example');
    assert.equal((await request(app, asPortal(cookie)).get('/api/portal/subscriptions')).status, 404);
    assert.equal((await request(app).get('/api/portal/subscriptions')).status, 401);
  });
});
