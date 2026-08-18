import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, resetDatabase, seedFixtures, type Fixtures } from './harness.js';
import { createSubscription, sweepRenewals, wonDealsWithoutRenewal } from '../services/renewals.js';

/**
 * A deal can close won without anything ever entering the renewal pipeline — no
 * invoice raised, or an invoice with no termed line. Past the grace period this is a
 * gap worth chasing, and the sweep should tell the owner about it exactly once.
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

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function wonDeal(ref: string, closedAt: Date) {
  return prisma.deal.create({
    data: {
      reference: ref, name: `Deal ${ref}`, accountId: fx.customer.id, pipelineId: fx.pipeline.id,
      stageId: fx.pipeline.stages[0].id, amount: 10_000, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: 10_000,
      probability: 100, closeDate: closedAt, ownerId: fx.rep.id, status: 'WON' as never, closedAt,
    },
  });
}

describe('renewal gap watch-list', () => {
  it('flags a won deal past the grace period with no entitlement, and nothing else', async () => {
    const stale = await wonDeal('G-1', daysAgo(30)); // past the 14-day default grace
    await wonDeal('G-2', daysAgo(2)); // too recent — invoice likely still pending
    const covered = await wonDeal('G-3', daysAgo(30));
    await createSubscription({
      accountId: fx.customer.id, description: 'Covered', quantity: 1, unitPrice: 100,
      startDate: new Date(), termMonths: 12, sourceDealId: covered.id,
    });

    const gaps = await wonDealsWithoutRenewal();
    assert.deepEqual(gaps.map((d) => d.id), [stale.id]);
  });

  it('sweep notifies the owner once, and does not repeat on a second run', async () => {
    const deal = await wonDeal('G-4', daysAgo(20));

    const first = await sweepRenewals();
    assert.equal(first.gaps, 1);

    const notifications = await prisma.notification.findMany({ where: { type: 'renewal_gap' } });
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].userId, fx.rep.id);
    assert.equal(notifications[0].link, `/deals/${deal.id}`);

    const second = await sweepRenewals();
    assert.equal(second.gaps, 0);
    assert.equal((await prisma.notification.findMany({ where: { type: 'renewal_gap' } })).length, 1);
  });
});
