import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import {
  migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures,
} from './harness.js';

/**
 * Integration tests.
 *
 * The unit self-checks prove the arithmetic. These prove the things only the HTTP layer
 * can get wrong: that a permission is actually enforced on the route rather than merely
 * hidden in the UI, that a locked document really refuses to move, and that a workflow
 * survives being driven from outside.
 */

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});

after(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  fx = await seedFixtures(app);
});

/** A deal owned by whoever is passed, at the first stage. */
async function makeDeal(owner: { id: string }, over: Partial<{ name: string; amount: number; cost: number }> = {}) {
  const deal = await prisma.deal.create({
    data: {
      reference: `T-${Math.random().toString(36).slice(2, 8)}`,
      name: over.name ?? 'Test deal',
      accountId: fx.customer.id,
      pipelineId: fx.pipeline.id,
      stageId: fx.pipeline.stages[0].id,
      amount: over.amount ?? 100_000,
      cost: over.cost ?? 60_000,
      vatRate: 5,
      vatAmount: (over.amount ?? 100_000) * 0.05,
      totalAmount: (over.amount ?? 100_000) * 1.05,
      probability: 10,
      closeDate: new Date(Date.now() + 30 * 86_400_000),
      ownerId: owner.id,
    },
  });
  return deal;
}

async function makeInvoice(lines: Array<{ description: string; quantity: number; unitPrice: number; termMonths?: number }>) {
  const res = await request(app, fx.admin).post('/api/invoices', {
    accountId: fx.customer.id,
    lines: lines.map((l) => ({ ...l, unitCost: 0, discountPct: 0, taxable: true, vatRate: 5 })),
  });
  assert.equal(res.status, 201, `invoice create failed: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; number: string; total: string; status: string };
}

// ── the front door ────────────────────────────────────────────────────────────

describe('authentication', () => {
  it('refuses anonymous traffic to the API', async () => {
    const res = await request(app).get('/api/deals');
    assert.equal(res.status, 401);
    assert.match(res.body.error, /sign in/i);
  });

  it('lets the health check through without a session', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
  });

  it('signs in with the right password', async () => {
    const res = await request(app).post('/api/auth/login', { email: fx.rep.email, password: 'Passw0rd!Test' });
    assert.equal(res.status, 200);
    assert.ok(String(res.raw.headers['set-cookie']).includes('zeus_session='), 'login must set the session cookie');
  });

  it('does not let an attacker tell a wrong password from an unknown address', async () => {
    // The two cases must be indistinguishable, or the login form becomes a way to
    // enumerate who has an account.
    const wrongPassword = await request(app).post('/api/auth/login', { email: fx.rep.email, password: 'nope' });
    const unknownEmail = await request(app).post('/api/auth/login', { email: 'ghost@test.local', password: 'nope' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownEmail.status, wrongPassword.status);
    assert.equal(unknownEmail.body.error, wrongPassword.body.error);
  });
});

// ── RBAC, enforced on the route rather than hidden in the UI ──────────────────

describe('permissions', () => {
  it('hides another rep\'s deal from a rep scoped to their own', async () => {
    await makeDeal(fx.otherRep, { name: 'Not yours' });
    const mine = await makeDeal(fx.rep, { name: 'Mine' });

    const res = await request(app, fx.rep).get('/api/deals');
    assert.equal(res.status, 200);
    const names = res.body.data.map((d: { name: string }) => d.name);
    assert.ok(names.includes('Mine'));
    assert.ok(!names.includes('Not yours'), 'a rep must not see a deal outside their scope');
    assert.equal(res.body.data.length, 1);
    assert.ok(mine.id);
  });

  it('lets a manager see every deal', async () => {
    await makeDeal(fx.otherRep);
    await makeDeal(fx.rep);
    const res = await request(app, fx.manager).get('/api/deals');
    assert.equal(res.body.data.length, 2);
  });

  it('strips cost and margin for a role that may not see them', async () => {
    await makeDeal(fx.rep, { amount: 100_000, cost: 60_000 });

    const repView = await request(app, fx.rep).get('/api/deals');
    assert.equal(repView.body.data[0].cost, undefined, 'cost must not reach a rep');

    const managerView = await request(app, fx.manager).get('/api/deals');
    assert.equal(Number(managerView.body.data[0].cost), 60_000);
  });

  it('refuses a write to a field the role cannot see, even when posted directly', async () => {
    const deal = await makeDeal(fx.rep, { cost: 60_000 });
    const res = await request(app, fx.rep).patch(`/api/deals/${deal.id}`, { cost: 1 });
    // The write is ignored rather than applied; the stored cost must not move.
    const after = await prisma.deal.findUnique({ where: { id: deal.id } });
    assert.equal(Number(after?.cost), 60_000, `a hidden field was written: ${JSON.stringify(res.body)}`);
  });

  it('stops a rep reaching settings and users', async () => {
    assert.equal((await request(app, fx.rep).get('/api/users')).status, 403);
    assert.equal((await request(app, fx.rep).put('/api/settings', { 'finance.vatRate': 0 })).status, 403);
  });
});

// ── money: the rules that protect a filed document ────────────────────────────

describe('invoices', () => {
  it('computes VAT per line and totals to the fil', async () => {
    const invoice = await makeInvoice([
      { description: 'Line A', quantity: 3, unitPrice: 33.33 },
      { description: 'Line B', quantity: 7, unitPrice: 12.49 },
    ]);
    // 99.99 + 87.43 = 187.42 net, 5% = 9.37, total 196.79
    assert.equal(Number(invoice.total).toFixed(2), '196.79');
  });

  it('locks the figures once the invoice is issued', async () => {
    const invoice = await makeInvoice([{ description: 'Licence', quantity: 1, unitPrice: 1000 }]);
    await request(app, fx.admin).post(`/api/approvals/invoices/${invoice.id}/submit`);
    await request(app, fx.manager).post(`/api/approvals/invoices/${invoice.id}/approve`);
    assert.equal((await request(app, fx.admin).post(`/api/invoices/${invoice.id}/status`, { status: 'SENT' })).status, 200);

    const edit = await request(app, fx.admin).patch(`/api/invoices/${invoice.id}`, {
      accountId: fx.customer.id,
      lines: [{ description: 'Sneaky', quantity: 1, unitPrice: 5, unitCost: 0, discountPct: 0, taxable: true, vatRate: 5 }],
    });
    assert.equal(edit.status, 400);
    assert.match(edit.body.error, /issued|credit note/i);

    const after = await prisma.invoice.findUnique({ where: { id: invoice.id } });
    assert.equal(Number(after?.total).toFixed(2), '1050.00', 'an issued invoice changed its total');
  });

  it('refuses to delete an issued invoice so the number stays in the sequence', async () => {
    const invoice = await makeInvoice([{ description: 'Licence', quantity: 1, unitPrice: 500 }]);
    await request(app, fx.admin).post(`/api/approvals/invoices/${invoice.id}/submit`);
    await request(app, fx.manager).post(`/api/approvals/invoices/${invoice.id}/approve`);
    await request(app, fx.admin).post(`/api/invoices/${invoice.id}/status`, { status: 'SENT' });

    const res = await request(app, fx.admin).del(`/api/invoices/${invoice.id}`);
    assert.equal(res.status, 400);
    assert.ok(await prisma.invoice.findUnique({ where: { id: invoice.id } }));
  });
});

// ── approvals: the gate has to hold from outside the UI ───────────────────────

describe('approvals', () => {
  it('blocks a deal closing won until a manager signs it off', async () => {
    const deal = await makeDeal(fx.rep);
    const won = fx.pipeline.stages.find((s) => s.isWon)!;

    const blocked = await request(app, fx.rep).post(`/api/deals/${deal.id}/stage`, { stageId: won.id });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /approval/i);

    await request(app, fx.rep).post(`/api/approvals/deals/${deal.id}/submit`);
    const stillBlocked = await request(app, fx.rep).post(`/api/deals/${deal.id}/stage`, { stageId: won.id });
    assert.equal(stillBlocked.status, 400, 'pending approval must still block the close');

    assert.equal((await request(app, fx.manager).post(`/api/approvals/deals/${deal.id}/approve`)).status, 200);
    const allowed = await request(app, fx.rep).post(`/api/deals/${deal.id}/stage`, { stageId: won.id });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.status, 'WON');
  });

  it('refuses to let a rep approve anything', async () => {
    const deal = await makeDeal(fx.rep);
    await request(app, fx.rep).post(`/api/approvals/deals/${deal.id}/submit`);

    const res = await request(app, fx.rep).post(`/api/approvals/deals/${deal.id}/approve`);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /sales manager|cannot approve/i);
  });

  it('demands a reason when rejecting', async () => {
    const deal = await makeDeal(fx.rep);
    await request(app, fx.rep).post(`/api/approvals/deals/${deal.id}/submit`);
    const res = await request(app, fx.manager).post(`/api/approvals/deals/${deal.id}/reject`, {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /why/i);
  });
});

// ── renewals ──────────────────────────────────────────────────────────────────

describe('renewals', () => {
  it('turns termed invoice lines into entitlements when the invoice is issued', async () => {
    const invoice = await makeInvoice([
      { description: 'EDR licence', quantity: 100, unitPrice: 210, termMonths: 12 },
      { description: 'One-off hardware', quantity: 1, unitPrice: 5000 },
    ]);
    await request(app, fx.admin).post(`/api/approvals/invoices/${invoice.id}/submit`);
    await request(app, fx.manager).post(`/api/approvals/invoices/${invoice.id}/approve`);
    await request(app, fx.admin).post(`/api/invoices/${invoice.id}/status`, { status: 'SENT' });

    const subs = await prisma.subscription.findMany();
    assert.equal(subs.length, 1, 'only the termed line becomes an entitlement');
    assert.equal(subs[0].description, 'EDR licence');
    assert.equal(Number(subs[0].termValue), 21_000);
  });

  it('rolls the term forward when the renewal is won, without a gap', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    const created = await request(app, fx.admin).post('/api/subscriptions', {
      accountId: fx.customer.id,
      description: 'MDR service',
      quantity: 1,
      unitPrice: 50_000,
      startDate: start.toISOString(),
      termMonths: 12,
    });
    assert.equal(created.status, 201);
    const sub = created.body as { id: string; endDate: string };
    assert.equal(sub.endDate.slice(0, 10), '2026-12-31', 'cover ends the day before the anniversary');

    const renewal = await request(app, fx.admin).post(`/api/subscriptions/${sub.id}/renew`);
    assert.equal(renewal.status, 200);

    const dealId = (renewal.body as { id: string }).id;
    await request(app, fx.admin).post(`/api/approvals/deals/${dealId}/submit`);
    await request(app, fx.manager).post(`/api/approvals/deals/${dealId}/approve`);
    const won = fx.pipeline.stages.find((s) => s.isWon)!;
    assert.equal((await request(app, fx.admin).post(`/api/deals/${dealId}/stage`, { stageId: won.id })).status, 200);

    const all = await prisma.subscription.findMany({ orderBy: { startDate: 'asc' } });
    assert.equal(all.length, 2);
    assert.equal(all[0].status, 'RENEWED');
    assert.equal(all[1].status, 'ACTIVE');
    assert.equal(all[1].startDate.toISOString().slice(0, 10), '2027-01-01', 'the next term starts the day after cover ended');
    assert.equal(all[1].endDate.toISOString().slice(0, 10), '2027-12-31');
  });

  it('opens one renewal deal however many times it is asked', async () => {
    const created = await request(app, fx.admin).post('/api/subscriptions', {
      accountId: fx.customer.id, description: 'Firewall support', quantity: 1, unitPrice: 9000,
      startDate: new Date().toISOString(), termMonths: 12,
    });
    const id = (created.body as { id: string }).id;
    const first = await request(app, fx.admin).post(`/api/subscriptions/${id}/renew`);
    const second = await request(app, fx.admin).post(`/api/subscriptions/${id}/renew`);
    assert.equal(first.body.id, second.body.id, 'a second request must not open a second deal');
    assert.equal(await prisma.deal.count({ where: { source: 'Renewal' } }), 1);
  });
});

// ── undo ──────────────────────────────────────────────────────────────────────

describe('undo', () => {
  it('restores a deleted account and refuses to do it twice', async () => {
    const account = await prisma.account.create({ data: { name: 'Undo Me', type: 'PROSPECT', ownerId: fx.rep.id } });

    const removed = await request(app, fx.admin).del(`/api/accounts/${account.id}`);
    assert.equal(removed.status, 200);
    const undoId = (removed.body as { undoId: string }).undoId;
    assert.ok(undoId, 'a delete must hand back something to undo');
    assert.ok((await prisma.account.findUnique({ where: { id: account.id } }))?.deletedAt);

    assert.equal((await request(app, fx.admin).post(`/api/undo/${undoId}`)).status, 200);
    assert.equal((await prisma.account.findUnique({ where: { id: account.id } }))?.deletedAt, null);

    const again = await request(app, fx.admin).post(`/api/undo/${undoId}`);
    assert.equal(again.status, 400);
    assert.match(again.body.error, /already been undone/i);
  });

  it('puts back the values an edit changed', async () => {
    const account = await prisma.account.create({ data: { name: 'Before', type: 'PROSPECT', industry: 'Retail' } });
    await request(app, fx.admin).patch(`/api/accounts/${account.id}`, { name: 'After', industry: 'Government' });

    const recent = await request(app, fx.admin).get('/api/undo/recent');
    assert.equal(recent.status, 200);
    const entry = (recent.body as Array<{ id: string; kind: string }>)[0];
    assert.equal(entry.kind, 'update');

    assert.equal((await request(app, fx.admin).post(`/api/undo/${entry.id}`)).status, 200);
    const after = await prisma.account.findUnique({ where: { id: account.id } });
    assert.equal(after?.name, 'Before');
    assert.equal(after?.industry, 'Retail');
  });
});

// ── duplicate detection ───────────────────────────────────────────────────────

describe('duplicate detection', () => {
  it('flags a second account on the same corporate domain', async () => {
    const res = await request(app, fx.admin).post('/api/accounts', {
      name: 'Test Customer FZ-LLC',
      type: 'PROSPECT',
      website: 'https://www.testcustomer.ae',
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.details.domain, 'testcustomer.ae');
    assert.ok(res.body.details.matches.length >= 1);
  });

  it('lets the caller through once they have seen the warning', async () => {
    const res = await request(app, fx.admin).post('/api/accounts', {
      name: 'Test Customer FZ-LLC',
      type: 'PROSPECT',
      website: 'https://www.testcustomer.ae',
      ignoreDuplicates: true,
    });
    assert.equal(res.status, 201);
  });
});
