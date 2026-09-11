import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * What a partner can sell, and who renews what.
 *
 * Enablement informs and never blocks — Zeus refuses in exactly one place, partner
 * protection, and a second gate built on the newest and least-checked data here would
 * stop real business to protect a record someone forgot to renew.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

async function partner(name = 'Alpha Distribution') {
  return prisma.account.create({ data: { name, type: 'PARTNER', ownerId: fx.admin.id, channelManagerId: fx.admin.id } });
}

describe('enablement', () => {
  it('records a partner against a vendor, expiring in a year by default', async () => {
    const p = await partner();
    const res = await request(app, fx.admin).put(`/api/partners/${p.id}/enablement/${fx.vendor.id}`, {});
    assert.equal(res.status, 200);

    const saved = await prisma.partnerEnablement.findFirstOrThrow({ where: { partnerId: p.id } });
    const months = (saved.expiresAt.getTime() - saved.enabledAt.getTime()) / 86_400_000;
    assert.ok(months > 360 && months < 370, 'a year unless the vendor says otherwise');
  });

  it('re-enabling renews the record rather than stacking a second one', async () => {
    const p = await partner();
    await request(app, fx.admin).put(`/api/partners/${p.id}/enablement/${fx.vendor.id}`, {});
    await request(app, fx.admin).put(`/api/partners/${p.id}/enablement/${fx.vendor.id}`, {
      expiresAt: inDays(500).toISOString(),
    });
    const rows = await prisma.partnerEnablement.findMany({ where: { partnerId: p.id } });
    assert.equal(rows.length, 1, 'the training sessions belong in the engagement log, not here');
    assert.ok(rows[0].expiresAt.getTime() > inDays(400).getTime());
  });

  it('reports live, expiring and expired separately', async () => {
    const p = await partner();
    const vendors = await Promise.all([
      prisma.account.create({ data: { name: 'Vendor Live', type: 'VENDOR' } }),
      prisma.account.create({ data: { name: 'Vendor Soon', type: 'VENDOR' } }),
      prisma.account.create({ data: { name: 'Vendor Lapsed', type: 'VENDOR' } }),
    ]);
    const at = [inDays(300), inDays(10), inDays(-5)];
    for (const [i, v] of vendors.entries()) {
      await prisma.partnerEnablement.create({
        data: { partnerId: p.id, vendorId: v.id, enabledAt: new Date(), expiresAt: at[i] },
      });
    }

    const body = (await request(app, fx.admin).get(`/api/partners/${p.id}/enablement`)).body as {
      rows: Array<{ vendor: { name: string }; state: string }>;
    };
    const state = (name: string) => body.rows.find((r) => r.vendor.name === name)!.state;
    assert.equal(state('Vendor Live'), 'live');
    assert.equal(state('Vendor Soon'), 'expiring', 'expiring and expired want different reactions');
    assert.equal(state('Vendor Lapsed'), 'expired');
  });

  it('refuses to enable a partner on something that is not a vendor', async () => {
    const p = await partner();
    const res = await request(app, fx.admin).put(`/api/partners/${p.id}/enablement/${fx.customer.id}`, {});
    assert.equal(res.status, 404);
  });
});

describe('enablement informs the deal, and never blocks it', () => {
  async function dealWithQuotedVendor(partnerId: string | null) {
    const deal = await prisma.deal.create({
      data: {
        reference: `ZEU-D-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
        name: 'Endpoint rollout', accountId: fx.customer.id,
        pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
        amount: 40_000, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: 40_000,
        probability: 50, ownerId: fx.admin.id, closeDate: inDays(30), partnerAccountId: partnerId,
      },
    });
    const product = await prisma.product.create({
      data: { sku: `SKU-${Math.random().toString(36).slice(2, 7)}`, name: 'XDR seat', vendorId: fx.vendor.id, listPrice: 100, cost: 60 },
    });
    const quote = await prisma.quote.create({
      data: {
        number: `Q-${Math.random().toString(36).slice(2, 7)}`, accountId: fx.customer.id, dealId: deal.id,
        status: 'DRAFT', issueDate: new Date(), subtotal: 100, vatAmount: 5, total: 105, preparedById: fx.admin.id,
      },
    });
    await prisma.quoteLine.create({
      data: { quoteId: quote.id, productId: product.id, description: 'XDR seat', quantity: 1, unitPrice: 100, lineTotal: 100 },
    });
    return deal;
  }

  it('flags a quoted vendor the partner is not enabled on', async () => {
    const p = await partner();
    const deal = await dealWithQuotedVendor(p.id);
    const res = await request(app, fx.admin).get(`/api/deals/${deal.id}`);
    assert.equal(res.status, 200, 'informing must never stop the page loading');
    assert.deepEqual((res.body as { notEnabledFor?: string[] }).notEnabledFor, [fx.vendor.name]);
  });

  it('says nothing once the partner is enabled', async () => {
    const p = await partner();
    const deal = await dealWithQuotedVendor(p.id);
    await prisma.partnerEnablement.create({
      data: { partnerId: p.id, vendorId: fx.vendor.id, enabledAt: new Date(), expiresAt: inDays(200) },
    });
    const res = await request(app, fx.admin).get(`/api/deals/${deal.id}`);
    assert.equal((res.body as { notEnabledFor?: string[] }).notEnabledFor, undefined);
  });

  it('an expired enablement is not an enablement', async () => {
    const p = await partner();
    const deal = await dealWithQuotedVendor(p.id);
    await prisma.partnerEnablement.create({
      data: { partnerId: p.id, vendorId: fx.vendor.id, enabledAt: inDays(-400), expiresAt: inDays(-30) },
    });
    const res = await request(app, fx.admin).get(`/api/deals/${deal.id}`);
    assert.deepEqual((res.body as { notEnabledFor?: string[] }).notEnabledFor, [fx.vendor.name],
      'lapsed is the whole reason the expiry exists');
  });

  it('says nothing about a deal with no partner on it', async () => {
    const deal = await dealWithQuotedVendor(null);
    const res = await request(app, fx.admin).get(`/api/deals/${deal.id}`);
    assert.equal((res.body as { notEnabledFor?: string[] }).notEnabledFor, undefined);
  });
});

describe('who services the renewal', () => {
  /**
   * The design said twice that a subscription could not know its partner, so the renewal
   * book would start empty and fill only from new terms. Both times a case-sensitive
   * search had missed `sourceDealId`, which every creation path sets. This pins the thing
   * that was wrongly believed impossible.
   */
  it('inherits the partner from the deal that sold it', async () => {
    const p = await partner();
    const deal = await prisma.deal.create({
      data: {
        reference: 'ZEU-D-INHERIT', name: 'Sold through Alpha', accountId: fx.customer.id,
        pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
        amount: 10_000, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: 10_000,
        probability: 100, ownerId: fx.admin.id, closeDate: new Date(), partnerAccountId: p.id,
      },
    });

    const res = await request(app, fx.admin).post('/api/subscriptions', {
      accountId: fx.customer.id, description: 'XDR, 100 seats', quantity: 100, unitPrice: 120,
      startDate: new Date().toISOString(), termMonths: 12, sourceDealId: deal.id,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: (res.body as { id: string }).id } });
    assert.equal(sub.partnerAccountId, p.id);
  });

  it('can be reassigned, because customers do change reseller', async () => {
    const [alpha, beta] = [await partner('Alpha'), await partner('Beta')];
    const created = await request(app, fx.admin).post('/api/subscriptions', {
      accountId: fx.customer.id, description: 'Direct at first', quantity: 1, unitPrice: 500,
      startDate: new Date().toISOString(), termMonths: 12, partnerAccountId: alpha.id,
    });
    assert.equal(created.status, 201);
    const id = (created.body as { id: string }).id;

    const moved = await request(app, fx.admin).patch(`/api/subscriptions/${id}`, { partnerAccountId: beta.id });
    assert.equal(moved.status, 200);
    assert.equal((await prisma.subscription.findUniqueOrThrow({ where: { id } })).partnerAccountId, beta.id);
  });

  it('stays unassigned when there is no deal to inherit from', async () => {
    const res = await request(app, fx.admin).post('/api/subscriptions', {
      accountId: fx.customer.id, description: 'Typed in by hand', quantity: 1, unitPrice: 200,
      startDate: new Date().toISOString(), termMonths: 12,
    });
    assert.equal(res.status, 201);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: (res.body as { id: string }).id } });
    assert.equal(sub.partnerAccountId, null, 'a guess here would be worse than a blank');
  });
});
