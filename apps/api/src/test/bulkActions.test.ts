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

describe('bulk actions: accounts', () => {
  it('reassigns everything the caller can touch, skips the rest', async () => {
    const own = await prisma.account.create({ data: { name: 'Own', ownerId: fx.rep.id } });
    const outsideTeam = await prisma.account.create({ data: { name: 'Outside team', ownerId: fx.otherRep.id } });

    const res = await request(app, fx.rep).post('/api/accounts/bulk-assign', { ids: [own.id, outsideTeam.id], ownerId: fx.rep.id });
    assert.equal(res.status, 200);
    assert.equal((res.body as { updated: number }).updated, 1);
    assert.equal((res.body as { skipped: number }).skipped, 1);
  });

  it('blocks deleting an account with an open deal, but not the rest of the batch', async () => {
    const blocked = await prisma.account.create({ data: { name: 'Has an open deal', ownerId: fx.admin.id } });
    const clear = await prisma.account.create({ data: { name: 'Clear to delete', ownerId: fx.admin.id } });
    await prisma.deal.create({
      data: {
        reference: 'BLK-1', name: 'Blocking deal', accountId: blocked.id, pipelineId: fx.pipeline.id,
        stageId: fx.pipeline.stages[0].id, amount: 100, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: 100,
        probability: 10, closeDate: new Date(), status: 'OPEN', ownerId: fx.admin.id,
      },
    });

    const res = await request(app, fx.admin).post('/api/accounts/bulk-delete', { ids: [blocked.id, clear.id] });
    assert.equal(res.status, 200);
    assert.equal((res.body as { deleted: number }).deleted, 1);
    assert.equal((res.body as { skipped: number }).skipped, 1);

    const blockedAfter = await prisma.account.findFirst({ where: { id: blocked.id } });
    assert.equal(blockedAfter?.deletedAt, null, 'the open deal held this one back');
    const clearAfter = await prisma.account.findFirst({ where: { id: clear.id } });
    assert.ok(clearAfter?.deletedAt, 'this one had nothing blocking it');
  });
});

describe('bulk actions: contacts', () => {
  it('reassigns everything the caller owns, then deletes', async () => {
    const own = await prisma.contact.create({ data: { firstName: 'A', lastName: 'One', ownerId: fx.rep.id } });
    const notMine = await prisma.contact.create({ data: { firstName: 'B', lastName: 'Two', ownerId: fx.otherRep.id } });

    // 'own' update scope: rep can reassign what they own (to anyone), not what they don't.
    const assign = await request(app, fx.rep).post('/api/contacts/bulk-assign', { ids: [own.id, notMine.id], ownerId: fx.otherRep.id });
    assert.equal(assign.status, 200);
    assert.equal((assign.body as { updated: number }).updated, 1);
    assert.equal((assign.body as { skipped: number }).skipped, 1);

    const del = await request(app, fx.admin).post('/api/contacts/bulk-delete', { ids: [own.id, notMine.id] });
    assert.equal((del.body as { deleted: number }).deleted, 2);
    assert.equal(await prisma.contact.count({ where: { deletedAt: null } }), 0);
  });
});

describe('bulk actions: leads', () => {
  it('reassigns and deletes', async () => {
    const a = await prisma.lead.create({ data: { firstName: 'A', lastName: 'One', company: 'Acme', ownerId: fx.rep.id } });
    const b = await prisma.lead.create({ data: { firstName: 'B', lastName: 'Two', company: 'Acme', ownerId: fx.rep.id } });

    const assign = await request(app, fx.admin).post('/api/leads/bulk-assign', { ids: [a.id, b.id], ownerId: fx.manager.id });
    assert.equal(assign.status, 200);
    assert.equal((assign.body as { updated: number }).updated, 2);

    const del = await request(app, fx.admin).post('/api/leads/bulk-delete', { ids: [a.id, b.id] });
    assert.equal((del.body as { deleted: number }).deleted, 2);
  });

  it('requires at least one id', async () => {
    const res = await request(app, fx.admin).post('/api/leads/bulk-assign', { ids: [], ownerId: fx.admin.id });
    assert.equal(res.status, 400);
  });
});
