import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateTestDatabase, prisma, resetDatabase, seedFixtures, type Fixtures } from './harness.js';
import { weeklyDealMovement, mondayOf } from '../services/snapshots.js';

/**
 * Week-over-week movement: compare the two most recent weekly snapshots and classify
 * each deal — advanced (stage up), grew/shrank (amount), won/lost (left the pipeline),
 * or new (first seen this week).
 */

let app: import('fastify').FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

async function makeDeal(ref: string, stageIndex: number, amount: number, status: 'OPEN' | 'WON' | 'LOST' = 'OPEN') {
  return prisma.deal.create({
    data: {
      reference: ref, name: `Deal ${ref}`, accountId: fx.customer.id, pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[stageIndex].id,
      amount, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: amount, probability: 10, closeDate: new Date(),
      ownerId: fx.rep.id, status: status as never,
    },
  });
}

describe('weekly deal movement', () => {
  it('needs two weeks before it compares', async () => {
    const one = await weeklyDealMovement(new Date());
    assert.equal(one.rows.length, 0);
  });

  it('classifies advanced, won, and new', async () => {
    const now = new Date();
    const thisWeek = mondayOf(now);
    const lastWeek = mondayOf(new Date(now.getTime() - 7 * 86_400_000));
    const s0 = fx.pipeline.stages[0];
    const s1 = fx.pipeline.stages[1];

    // D1: was in stage 0 last week, moved to stage 1 this week → Advanced.
    const d1 = await makeDeal('M-1', 1, 1500);
    // D2: was open last week, won this week (absent from this week's snapshot) → Won.
    const d2 = await makeDeal('M-2', 0, 2000, 'WON');
    // D3: only appears this week → New.
    const d3 = await makeDeal('M-3', 0, 500);

    await prisma.dealSnapshot.createMany({
      data: [
        { dealId: d1.id, weekOf: lastWeek, stageId: s0.id, ownerId: fx.rep.id, amount: 1000, status: 'OPEN', stageOrder: 0 },
        { dealId: d2.id, weekOf: lastWeek, stageId: s0.id, ownerId: fx.rep.id, amount: 2000, status: 'OPEN', stageOrder: 0 },
        { dealId: d1.id, weekOf: thisWeek, stageId: s1.id, ownerId: fx.rep.id, amount: 1500, status: 'OPEN', stageOrder: 1 },
        { dealId: d3.id, weekOf: thisWeek, stageId: s0.id, ownerId: fx.rep.id, amount: 500, status: 'OPEN', stageOrder: 0 },
      ],
    });

    const { rows } = await weeklyDealMovement(now);
    const change = (ref: string) => rows.find((r) => r.reference === ref)?.change;
    assert.equal(change('M-1'), 'Advanced');
    assert.equal(change('M-2'), 'Won');
    assert.equal(change('M-3'), 'New');
  });
});
