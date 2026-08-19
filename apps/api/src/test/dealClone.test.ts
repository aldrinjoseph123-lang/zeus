import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

async function makeDeal(overrides: Partial<{ ownerId: string; stageIndex: number; status: 'OPEN' | 'WON' | 'LOST' }> = {}) {
  return prisma.deal.create({
    data: {
      reference: 'SRC-1', name: 'Original deal', accountId: fx.customer.id, pipelineId: fx.pipeline.id,
      stageId: fx.pipeline.stages[overrides.stageIndex ?? 1].id, amount: 5000, cost: 3000, vatRate: 5, vatAmount: 250,
      totalAmount: 5250, probability: 25, closeDate: new Date(Date.now() + 5 * 86_400_000),
      ownerId: overrides.ownerId ?? fx.rep.id, status: (overrides.status ?? 'OPEN') as never,
      description: 'Some notes', source: 'LinkedIn',
    },
  });
}

describe('deal clone', () => {
  it('copies the commercial shape into a fresh open deal, owned by whoever cloned it', async () => {
    const source = await makeDeal({ ownerId: fx.rep.id });

    const res = await request(app, fx.admin).post(`/api/deals/${source.id}/clone`, {});
    assert.equal(res.status, 201);
    const body = res.body as { id: string; reference: string; name: string; status: string; amount: string | number; owner: { id: string } | null; stage: { id: string } };

    assert.notEqual(body.id, source.id);
    assert.notEqual(body.reference, source.reference);
    assert.equal(body.name, 'Original deal (Copy)');
    assert.equal(body.status, 'OPEN');
    assert.equal(Number(body.amount), 5000);
    assert.equal(body.owner?.id, fx.admin.id, 'owned by the cloner, not the source owner');
    assert.equal(body.stage.id, fx.pipeline.stages[0].id, 'resets to the pipeline\'s first stage, not the source\'s stage');
  });

  it('a rep cannot clone a deal outside their scope', async () => {
    const source = await makeDeal({ ownerId: fx.otherRep.id });
    const res = await request(app, fx.rep).post(`/api/deals/${source.id}/clone`, {});
    assert.equal(res.status, 403);
  });

  it('404s a deal that does not exist', async () => {
    const res = await request(app, fx.admin).post('/api/deals/does-not-exist/clone', {});
    assert.equal(res.status, 404);
  });

  it('creates its own stage-history entry, independent of the source', async () => {
    const source = await makeDeal();
    const res = await request(app, fx.admin).post(`/api/deals/${source.id}/clone`, {});
    const history = await prisma.stageHistory.findMany({ where: { dealId: (res.body as { id: string }).id } });
    assert.equal(history.length, 1);
  });
});
