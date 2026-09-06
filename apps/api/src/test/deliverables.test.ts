import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';
import { PORTAL_COOKIE } from '../portal/session.js';
import { unusedEntitlements } from '../services/deliverables.js';
import { runDataHealthChecks } from '../services/dataHealth.js';

/**
 * Deliverables — the "two VAPTs a year, one used, one left" shape. Included minus the
 * sum of deliveries is remaining, derived not stored; the integrity sweep catches
 * over-use and date/status mismatches; the customer sees included/used/remaining
 * through the allowlist, never the internal notes.
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
const at = (days: number) => new Date(Date.now() + days * day);

async function subscription(accountId: string, endInDays = 300) {
  return prisma.subscription.create({ data: {
    reference: 'ZEU-SUB-' + randomBytes(3).toString('hex'), accountId, description: 'MDR + VAPT', quantity: 1, unit: 'contract',
    unitPrice: 50000, unitCost: 30000, termValue: 50000, startDate: at(-60), endDate: at(endInDays), termMonths: 12, status: 'ACTIVE',
  } });
}

describe('deliverables: included / used / remaining', () => {
  it('draws down as deliveries are added, and the sweep catches over-use', async () => {
    const sub = await subscription(fx.customer.id);
    const ent = await request(app, fx.admin).post(`/api/subscriptions/${sub.id}/entitlements`, { label: 'VAPT assessment', quantity: 2, unit: 'assessment', validTo: at(300).toISOString() });
    assert.equal(ent.status, 201, JSON.stringify(ent.body));

    let list = (await request(app, fx.admin).get(`/api/subscriptions/${sub.id}/entitlements`)).body as Array<{ included: number; used: number; remaining: number; deliveries: unknown[] }>;
    assert.deepEqual([list[0].included, list[0].used, list[0].remaining], [2, 0, 2]);

    const d1 = await request(app, fx.admin).post(`/api/entitlements/${id(ent)}/deliveries`, { quantity: 1, status: 'DELIVERED', reference: 'VAPT-H1-report' });
    assert.equal(d1.status, 201);
    await request(app, fx.admin).post(`/api/entitlements/${id(ent)}/deliveries`, { quantity: 1, status: 'SCHEDULED', scheduledFor: at(120).toISOString() });

    list = (await request(app, fx.admin).get(`/api/subscriptions/${sub.id}/entitlements`)).body as typeof list;
    assert.deepEqual([list[0].included, list[0].used, list[0].remaining], [2, 2, 0], 'one delivered + one scheduled = fully spoken for');
    assert.equal(list[0].deliveries.length, 2);

    // A third delivery over-uses it — the sweep flags it (the API does not block; over-use is a judgment call).
    await request(app, fx.admin).post(`/api/entitlements/${id(ent)}/deliveries`, { quantity: 1, status: 'DELIVERED' });
    const report = await runDataHealthChecks();
    const finding = report.findings.find((f) => f.check === 'deliverables_consistent');
    assert.ok(finding && finding.count >= 1, 'over-delivery is a finding');
  });

  it('the sweep flags a delivered row with no date, and a scheduled row gone past', async () => {
    const sub = await subscription(fx.customer.id);
    const ent = await prisma.entitlement.create({ data: { subscriptionId: sub.id, label: 'Support hours', quantity: 40, unit: 'hour', validFrom: at(-60), validTo: at(300) } });
    await prisma.delivery.create({ data: { entitlementId: ent.id, quantity: 8, status: 'DELIVERED', deliveredAt: null } });
    await prisma.delivery.create({ data: { entitlementId: ent.id, quantity: 8, status: 'SCHEDULED', scheduledFor: at(-3) } });
    const report = await runDataHealthChecks();
    const finding = report.findings.find((f) => f.check === 'deliverables_consistent');
    assert.ok(finding && finding.count >= 2, `expected two problems, got ${finding?.count}`);
  });

  it('marking a delivery DELIVERED stamps the date automatically', async () => {
    const sub = await subscription(fx.customer.id);
    const ent = await request(app, fx.admin).post(`/api/subscriptions/${sub.id}/entitlements`, { label: 'Training', quantity: 3, unit: 'session' });
    const d = await request(app, fx.admin).post(`/api/entitlements/${id(ent)}/deliveries`, { quantity: 1, status: 'SCHEDULED', scheduledFor: at(2).toISOString() });
    const patched = await request(app, fx.admin).patch(`/api/deliveries/${id(d)}`, { status: 'DELIVERED' });
    assert.equal(patched.status, 200);
    assert.ok((patched.body as { deliveredAt: string | null }).deliveredAt, 'delivered date stamped');
  });

  it('unusedEntitlements finds value with time running out, ignores spent or far-off', async () => {
    const sub = await subscription(fx.customer.id, 40);
    const soon = await prisma.entitlement.create({ data: { subscriptionId: sub.id, label: 'VAPT', quantity: 2, unit: 'assessment', validFrom: at(-60), validTo: at(40) } });
    await prisma.delivery.create({ data: { entitlementId: soon.id, quantity: 1, status: 'DELIVERED', deliveredAt: at(-5) } });
    // Spent: valid soon but nothing remaining.
    const spent = await prisma.entitlement.create({ data: { subscriptionId: sub.id, label: 'Onboarding', quantity: 1, unit: 'session', validFrom: at(-60), validTo: at(30) } });
    await prisma.delivery.create({ data: { entitlementId: spent.id, quantity: 1, status: 'DELIVERED', deliveredAt: at(-10) } });
    // Far off: remaining but a long way out.
    await prisma.entitlement.create({ data: { subscriptionId: sub.id, label: 'Later', quantity: 5, unit: 'hour', validFrom: at(-60), validTo: at(200) } });

    const flagged = await unusedEntitlements(60);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].label, 'VAPT');
    assert.equal(flagged[0].remaining, 1);
  });
});

describe('deliverables: the customer view', () => {
  async function customerCookie(accountId: string, email: string) {
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'C', lastName: 'C', email, accountId, ignoreDuplicates: true });
    const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(contact) });
    await prisma.portalUser.update({ where: { id: id(granted) }, data: { passwordHash: await import('bcryptjs').then((b) => b.default.hash('correct-horse-battery-staple', 10)) } });
    const login = await request(app).post('/api/portal/auth/login', { email, password: 'correct-horse-battery-staple' });
    return String(login.raw.headers['set-cookie']).match(new RegExp(`${PORTAL_COOKIE}=[^;]+`))![0];
  }

  it('shows included/used/remaining and dated deliveries, never the notes, only for their own subscription', async () => {
    const mine = await request(app, fx.admin).post('/api/accounts', { name: 'Mine Co', type: 'CUSTOMER', ignoreDuplicates: true });
    const sub = await subscription(id(mine));
    const ent = await prisma.entitlement.create({ data: { subscriptionId: sub.id, label: 'VAPT assessment', quantity: 2, unit: 'assessment', validFrom: at(-60), validTo: at(300), notes: 'internal only' } });
    await prisma.delivery.create({ data: { entitlementId: ent.id, quantity: 1, status: 'DELIVERED', deliveredAt: at(-30), reference: 'H1 report', notes: 'secret note' } });

    const cookie = await customerCookie(id(mine), 'ops@mine.example');
    const rows = (await request(app, asPortal(cookie)).get(`/api/portal/subscriptions/${sub.id}/entitlements`)).body as Array<{ label: string; included: number; used: number; remaining: number; deliveries: Array<{ status: string; reference: string | null }> }>;
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].included, rows[0].used, rows[0].remaining], [2, 1, 1]);
    assert.equal(rows[0].deliveries[0].status, 'DELIVERED');
    assert.doesNotMatch(JSON.stringify(rows), /internal only|secret note/);

    // Another customer's subscription id is a 404, not a peek.
    const theirs = await request(app, fx.admin).post('/api/accounts', { name: 'Theirs Co', type: 'CUSTOMER', ignoreDuplicates: true });
    const theirSub = await subscription(id(theirs));
    assert.equal((await request(app, asPortal(cookie)).get(`/api/portal/subscriptions/${theirSub.id}/entitlements`)).status, 404);
  });
});
