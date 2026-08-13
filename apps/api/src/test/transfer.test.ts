import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

/**
 * Offboarding transfer: reassign a leaving user's records to another, per module,
 * reversibly. Admin-only; guarded against self-transfer and inactive recipients.
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

describe('offboarding transfer', () => {
  it('previews how many records the leaving user owns', async () => {
    await makeDeal(fx.rep, 'T-1');
    const res = await request(app, fx.admin).get(`/api/users/${fx.rep.id}/transfer/preview`);
    assert.equal(res.status, 200);
    const body = res.body as { counts: Record<string, number> };
    assert.ok(body.counts.accounts >= 1, 'rep owns the seeded customer account');
    assert.equal(body.counts.deals, 1);
  });

  it('reassigns the selected modules and reverses exactly', async () => {
    const d = await makeDeal(fx.rep, 'T-2');

    const res = await request(app, fx.admin).post(`/api/users/${fx.rep.id}/transfer`, {
      toUserId: fx.otherRep.id, modules: ['accounts', 'deals'], deactivate: true,
    });
    assert.equal(res.status, 200);
    const body = res.body as { jobId: string; counts: Record<string, number>; total: number };
    assert.equal(body.counts.deals, 1);
    assert.equal((await prisma.deal.findUnique({ where: { id: d.id } }))?.ownerId, fx.otherRep.id, 'deal moved');
    assert.equal((await prisma.account.findUnique({ where: { id: fx.customer.id } }))?.ownerId, fx.otherRep.id, 'account moved');
    assert.equal((await prisma.user.findUnique({ where: { id: fx.rep.id } }))?.isActive, false, 'leaving user deactivated');

    // Reverse restores ownership and reactivates.
    const rev = await request(app, fx.admin).post(`/api/transfers/${body.jobId}/reverse`, {});
    assert.equal(rev.status, 200);
    assert.equal((await prisma.deal.findUnique({ where: { id: d.id } }))?.ownerId, fx.rep.id, 'deal returned');
    assert.equal((await prisma.user.findUnique({ where: { id: fx.rep.id } }))?.isActive, true, 'user reactivated');
    // A second reverse is refused.
    assert.equal((await request(app, fx.admin).post(`/api/transfers/${body.jobId}/reverse`, {})).status, 400);
  });

  it('guards: self-transfer, no modules, and non-admins', async () => {
    assert.equal((await request(app, fx.admin).post(`/api/users/${fx.rep.id}/transfer`, { toUserId: fx.rep.id, modules: ['deals'] })).status, 400);
    assert.equal((await request(app, fx.admin).post(`/api/users/${fx.rep.id}/transfer`, { toUserId: fx.otherRep.id, modules: [] })).status, 400);
    assert.equal((await request(app, fx.rep).post(`/api/users/${fx.rep.id}/transfer`, { toUserId: fx.otherRep.id, modules: ['deals'] })).status, 403);
  });

  it('exports the user book as a JSON download', async () => {
    const res = await request(app, fx.admin).get(`/api/users/${fx.rep.id}/export`);
    assert.equal(res.status, 200);
    assert.match(res.raw.headers['content-type'] as string, /application\/json/);
    const book = JSON.parse(res.raw.body as string) as { accounts: unknown[] };
    assert.ok(Array.isArray(book.accounts));
  });
});
