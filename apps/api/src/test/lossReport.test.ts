import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

/**
 * Loss-reasons report: lost deals grouped by their (structured) reason, ranked by
 * lost value — the systemic-blocker view a manager reviews over time.
 */

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

async function lostDeal(ref: string, reason: string, amount: number) {
  return prisma.deal.create({
    data: {
      reference: ref, name: `Deal ${ref}`, accountId: fx.customer.id, pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
      amount, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: amount, probability: 0, closeDate: new Date(),
      ownerId: fx.rep.id, status: 'LOST', lostReason: reason, closedAt: new Date(),
    },
  });
}

describe('loss-reasons report', () => {
  it('groups by reason, ranks by lost value, and buckets blanks as Uncategorised', async () => {
    await lostDeal('L-1', 'Price', 100_000);
    await lostDeal('L-2', 'Price', 50_000);
    await lostDeal('L-3', 'No budget', 20_000);
    await lostDeal('L-4', '', 5_000); // no reason → Uncategorised

    const res = await request(app, fx.admin).get('/api/reports/loss-reasons?format=json');
    assert.equal(res.status, 200);
    const body = res.body as { rows: Array<{ reason: string; deals: number; value: number; share: number }>; summary: Array<[string, string]> };

    assert.equal(body.rows[0].reason, 'Price', 'highest lost value first');
    assert.equal(body.rows[0].deals, 2);
    assert.equal(body.rows[0].value, 150_000);
    assert.ok(body.rows.some((r) => r.reason === 'Uncategorised'), 'blank reason bucketed');
    assert.equal(body.rows.reduce((s, r) => s + r.deals, 0), 4);

    const lostDeals = body.summary.find((s) => s[0] === 'Lost deals');
    assert.equal(lostDeals?.[1], '4');
  });
});
