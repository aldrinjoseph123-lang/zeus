import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

/**
 * Bulk deal actions must honour per-row scope: a rep bulk-selecting cannot reach a
 * deal they could not touch individually. A mixed selection skips what is not theirs
 * instead of failing whole.
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

async function makeDeal(owner: { id: string }, ref: string) {
  return prisma.deal.create({
    data: {
      reference: ref, name: `Deal ${ref}`, accountId: fx.customer.id, pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
      amount: 1000, cost: 600, vatRate: 5, vatAmount: 50, totalAmount: 1050, probability: 10,
      closeDate: new Date(Date.now() + 30 * 86_400_000), ownerId: owner.id,
    },
  });
}

describe('bulk deal actions', () => {
  it('admin bulk-assigns every selected deal', async () => {
    const a = await makeDeal(fx.rep, 'B-1');
    const b = await makeDeal(fx.rep, 'B-2');
    const res = await request(app, fx.admin).post('/api/deals/bulk-assign', { ids: [a.id, b.id], ownerId: fx.otherRep.id });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { updated: 2, skipped: 0 });
    assert.equal((await prisma.deal.findUnique({ where: { id: a.id } }))?.ownerId, fx.otherRep.id);
  });

  it('skips rows a scoped rep may not touch, applies the rest', async () => {
    const mine = await makeDeal(fx.rep, 'B-3');
    const theirs = await makeDeal(fx.otherRep, 'B-4');
    const res = await request(app, fx.rep).post('/api/deals/bulk-assign', { ids: [mine.id, theirs.id], ownerId: fx.rep.id });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { updated: 1, skipped: 1 }, 'the other rep\'s deal must be skipped, not reassigned');
    assert.equal((await prisma.deal.findUnique({ where: { id: theirs.id } }))?.ownerId, fx.otherRep.id);
  });

  it('bulk-deletes (soft) and 400s an empty selection', async () => {
    const d = await makeDeal(fx.rep, 'B-5');
    const del = await request(app, fx.admin).post('/api/deals/bulk-delete', { ids: [d.id] });
    assert.equal(del.status, 200);
    assert.deepEqual(del.body, { deleted: 1, skipped: 0 });
    assert.ok((await prisma.deal.findUnique({ where: { id: d.id } }))?.deletedAt, 'soft-deleted');
    assert.equal((await request(app, fx.admin).post('/api/deals/bulk-delete', { ids: [] })).status, 400);
  });
});
