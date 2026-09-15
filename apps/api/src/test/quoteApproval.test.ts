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

  it('tells the approver the margin and the markup they are signing', async () => {
    const created = await request(app, fx.admin).post('/api/quotes', {
      accountId: fx.customer.id, lines: [{ description: 'FortiGate', quantity: 1, vendorUnitCost: 100, markupPct: 20 }],
    });
    const id = (created.body as { id: string }).id;
    await request(app, fx.admin).post(`/api/approvals/quotes/${id}/submit`, {});

    const queue = (await request(app, fx.manager).get('/api/approvals/pending')).body as Array<{ id: string; marginAmount?: number; marginPct?: number; markupPct?: number }>;
    const row = queue.find((r) => r.id === id)!;
    assert.equal(row.markupPct!.toFixed(1), '20.0', '100 sold at 120 is 20% on cost');
    assert.equal(row.marginPct!.toFixed(1), '16.7', 'and 16.7% on sell');
    assert.equal(row.marginAmount, 20, 'the same 20 either way');
  });

  it('shows a pending quote in the approvals queue', async () => {
    const q = await draftQuote();
    await request(app, fx.rep).post(`/api/approvals/quotes/${q.id}/submit`, {});
    const pending = await request(app, fx.manager).get('/api/approvals/pending');
    const body = pending.body as Array<{ entity: string; id: string }>;
    assert.ok(body.some((r) => r.entity === 'quotes' && r.id === q.id), 'quote appears in the manager queue');
  });
});

/**
 * A sign-off is on the prices it was given.
 *
 * Until 15 Sep 2026 an approved quote stayed approved through any edit, so a rep could get
 * a manager's yes and then change the prices before sending — and the worksheet exported
 * as "approved" carried figures nobody had seen. The user's rule: a change to what the
 * customer pays, or to what it costs us, voids the approval; a change to the words does not.
 */
describe('a price change voids the approval', () => {
  /** A quote with real lines, prepared by the rep, submitted and approved. */
  async function approvedQuote() {
    const created = await request(app, fx.rep).post('/api/quotes', {
      accountId: fx.customer.id,
      lines: [{ description: 'Firewall', quantity: 2, unitPrice: 1000 }],
    });
    const id = (created.body as { id: string }).id;
    assert.equal((await request(app, fx.rep).post(`/api/approvals/quotes/${id}/submit`, {})).status, 200);
    assert.equal((await request(app, fx.manager).post(`/api/approvals/quotes/${id}/approve`, {})).status, 200);
    return id;
  }
  const statusOf = async (id: string) => (await prisma.quote.findUniqueOrThrow({ where: { id } })).approvalStatus;

  it('changing a price sends it back for approval, and sending is blocked again', async () => {
    const id = await approvedQuote();
    const res = await request(app, fx.rep).patch(`/api/quotes/${id}`, { lines: [{ description: 'Firewall', quantity: 2, unitPrice: 800 }] });
    assert.equal(res.status, 200);
    assert.equal(await statusOf(id), 'NOT_REQUIRED');
    assert.match((await prisma.quote.findUniqueOrThrow({ where: { id } })).approvalNote ?? '', /prices changed/);
    assert.equal((await request(app, fx.rep).post(`/api/quotes/${id}/status`, { status: 'SENT' })).status, 400, 'the old yes no longer lets it out');
  });

  it('so does a change of quantity, discount or VAT', async () => {
    for (const change of [
      { lines: [{ description: 'Firewall', quantity: 3, unitPrice: 1000 }] },
      { discountPct: 10 },
      { vatRate: 0 },
    ]) {
      const id = await approvedQuote();
      await request(app, fx.rep).patch(`/api/quotes/${id}`, change);
      assert.equal(await statusOf(id), 'NOT_REQUIRED', `${JSON.stringify(change)} should void the approval`);
    }
  });

  it('rewording the notes, the terms or a description keeps it', async () => {
    const id = await approvedQuote();
    await request(app, fx.rep).patch(`/api/quotes/${id}`, { notes: 'Delivery in two weeks', terms: 'Net 30' });
    await request(app, fx.rep).patch(`/api/quotes/${id}`, { lines: [{ description: 'Firewall appliance', quantity: 2, unitPrice: 1000 }] });
    assert.equal(await statusOf(id), 'APPROVED');
  });

  it('a pending request is withdrawn too, so the manager does not approve prices that have gone', async () => {
    const created = await request(app, fx.rep).post('/api/quotes', { accountId: fx.customer.id, lines: [{ description: 'Firewall', quantity: 1, unitPrice: 1000 }] });
    const id = (created.body as { id: string }).id;
    await request(app, fx.rep).post(`/api/approvals/quotes/${id}/submit`, {});
    await request(app, fx.rep).patch(`/api/quotes/${id}`, { lines: [{ description: 'Firewall', quantity: 1, unitPrice: 1200 }] });
    assert.equal(await statusOf(id), 'NOT_REQUIRED');
    const queue = (await request(app, fx.manager).get('/api/approvals/pending')).body as Array<{ id: string }>;
    assert.ok(!queue.some((r) => r.id === id));
  });

  it('a new default markup on the worksheet counts, though no line was sent', async () => {
    const created = await request(app, fx.admin).post('/api/quotes', {
      accountId: fx.customer.id, defaultMarkupPct: 20, lines: [{ description: 'FortiGate', quantity: 1, vendorUnitCost: 1000 }],
    });
    const id = (created.body as { id: string }).id;
    await request(app, fx.admin).post(`/api/approvals/quotes/${id}/submit`, {});
    await request(app, fx.manager).post(`/api/approvals/quotes/${id}/approve`, {});
    await request(app, fx.admin).patch(`/api/quotes/${id}`, { defaultMarkupPct: 25 });
    assert.equal(await statusOf(id), 'NOT_REQUIRED');
    assert.equal((await request(app, fx.admin).get(`/api/quotes/${id}/worksheet.xlsx`)).status, 400, 'and the worksheet cannot be downloaded as approved');
  });
});
