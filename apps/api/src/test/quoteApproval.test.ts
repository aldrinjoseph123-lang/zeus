import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

/**
 * Every quote must be approved by a manager/admin before it can be sent. A rep may
 * submit but not approve; sending is blocked until APPROVED.
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

async function draftQuote() {
  return prisma.quote.create({
    data: { number: `Q-${Math.random().toString(36).slice(2, 7)}`, accountId: fx.customer.id, preparedById: fx.rep.id, subtotal: 1000, total: 1000, status: 'DRAFT' },
  });
}

describe('quote approval', () => {
  it('blocks send until approved, and only a manager can approve', async () => {
    const q = await draftQuote();

    // Cannot send a draft, un-approved quote.
    assert.equal((await request(app, fx.admin).post(`/api/quotes/${q.id}/status`, { status: 'SENT' })).status, 400);

    // Rep submits for approval.
    const submit = await request(app, fx.rep).post(`/api/approvals/quotes/${q.id}/submit`, {});
    assert.equal(submit.status, 200);
    assert.equal((await prisma.quote.findUnique({ where: { id: q.id } }))?.approvalStatus, 'PENDING');

    // A rep cannot approve.
    assert.equal((await request(app, fx.rep).post(`/api/approvals/quotes/${q.id}/approve`, {})).status, 403);

    // A manager approves.
    const approve = await request(app, fx.manager).post(`/api/approvals/quotes/${q.id}/approve`, {});
    assert.equal(approve.status, 200);
    assert.equal((await prisma.quote.findUnique({ where: { id: q.id } }))?.approvalStatus, 'APPROVED');

    // Now it can be sent.
    assert.equal((await request(app, fx.admin).post(`/api/quotes/${q.id}/status`, { status: 'SENT' })).status, 200);
  });

  it('shows a pending quote in the approvals queue', async () => {
    const q = await draftQuote();
    await request(app, fx.rep).post(`/api/approvals/quotes/${q.id}/submit`, {});
    const pending = await request(app, fx.manager).get('/api/approvals/pending');
    const body = pending.body as Array<{ entity: string; id: string }>;
    assert.ok(body.some((r) => r.entity === 'quotes' && r.id === q.id), 'quote appears in the manager queue');
  });
});
