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

  it('leaves the money it is not hiding readable', async () => {
    // Masking rebuilt every object it walked, which turned a Prisma Decimal into its
    // internal {s, e, d} — so a rep's own deal arrived with an unreadable amount and
    // every money figure on the screen rendered blank.
    await makeDeal(fx.rep, { amount: 888_000, cost: 60_000 });

    const res = await request(app, fx.rep).get('/api/deals');
    const deal = res.body.data[0];
    assert.equal(deal.cost, undefined, 'cost is hidden from this role');
    assert.equal(Number(deal.amount), 888_000, `amount must survive masking, got ${JSON.stringify(deal.amount)}`);
    assert.equal(Number(deal.totalAmount).toFixed(2), '932400.00');
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

  it('will not issue a tax invoice without our own TRN on it', async () => {
    // Article 59 requires the supplier's TRN on the face of a tax invoice. It is our own
    // data, always fixable, so issuing without it is never the better option.
    await request(app, fx.admin).put('/api/settings', { 'company.trn': '' });
    const invoice = await makeInvoice([{ description: 'Licence', quantity: 1, unitPrice: 1000 }]);
    await request(app, fx.admin).post(`/api/approvals/invoices/${invoice.id}/submit`);
    await request(app, fx.manager).post(`/api/approvals/invoices/${invoice.id}/approve`);

    const blocked = await request(app, fx.admin).post(`/api/invoices/${invoice.id}/status`, { status: 'SENT' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /TRN/i);

    await request(app, fx.admin).put('/api/settings', { 'company.trn': '100123456700003' });
    const issued = await request(app, fx.admin).post(`/api/invoices/${invoice.id}/status`, { status: 'SENT' });
    assert.equal(issued.status, 200);
    const stored = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    assert.equal(stored.supplierTrn, '100123456700003', 'the TRN must be snapshotted at issue');
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

// ── vendor price book ─────────────────────────────────────────────────────────

describe('price book', () => {
  async function makeProduct(sku: string, cost: number) {
    return prisma.product.create({
      data: { sku, name: `Product ${sku}`, unit: 'licence', listPrice: cost * 2, cost, vendorId: fx.vendor.id },
    });
  }

  it('falls back to the catalogue cost when no vendor price is loaded', async () => {
    const product = await makeProduct('SKU-FALLBACK', 100);
    const res = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    assert.equal(res.status, 200);
    assert.equal(res.body.cost, 100);
    assert.equal(res.body.source, 'catalogue');
  });

  it('prefers the vendor price over the catalogue cost', async () => {
    const product = await makeProduct('SKU-VENDOR', 100);
    await request(app, fx.manager).post('/api/price-book', {
      productId: product.id, vendorId: fx.vendor.id, cost: 80,
    });
    const res = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    assert.equal(res.body.cost, 80);
    assert.equal(res.body.source, 'price-book');
  });

  it('takes the quantity break that applies, not the cheapest on file', async () => {
    const product = await makeProduct('SKU-TIERS', 100);
    for (const [minQuantity, cost] of [[1, 90], [50, 75], [500, 60]] as const) {
      await request(app, fx.manager).post('/api/price-book', { productId: product.id, vendorId: fx.vendor.id, cost, minQuantity });
    }

    const one = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    const fifty = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=60`);
    const bulk = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1000`);

    assert.equal(one.body.cost, 90, 'a single unit must not get the bulk price');
    assert.equal(fifty.body.cost, 75);
    assert.equal(bulk.body.cost, 60);
  });

  it('ignores a price list that has expired', async () => {
    const product = await makeProduct('SKU-EXPIRED', 100);
    await request(app, fx.manager).post('/api/price-book', {
      productId: product.id, vendorId: fx.vendor.id, cost: 40,
      validTo: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const res = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    assert.equal(res.body.cost, 100, 'an expired price must not be used');
    assert.equal(res.body.source, 'catalogue');
  });

  it('gives a deal its special price, and never leaks it to another deal', async () => {
    const product = await makeProduct('SKU-SPA', 100);
    const registered = await makeDeal(fx.rep, { name: 'Registered deal' });
    const other = await makeDeal(fx.rep, { name: 'Someone else' });

    await request(app, fx.manager).post('/api/price-book', { productId: product.id, vendorId: fx.vendor.id, cost: 80 });
    await request(app, fx.manager).post('/api/price-book', {
      productId: product.id, vendorId: fx.vendor.id, cost: 55, dealId: registered.id,
    });

    const onDeal = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1&dealId=${registered.id}`);
    assert.equal(onDeal.body.cost, 55);
    assert.equal(onDeal.body.source, 'special');

    const elsewhere = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1&dealId=${other.id}`);
    assert.equal(elsewhere.body.cost, 80, 'a special price must not reach a different deal');

    const noDeal = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    assert.equal(noDeal.body.cost, 80);
  });

  it('converts a vendor price billed in dollars into the currency of the document', async () => {
    const product = await makeProduct('SKU-USD', 100);
    await request(app, fx.manager).post('/api/price-book', {
      productId: product.id, vendorId: fx.vendor.id, cost: 100, listPrice: 200, currency: 'USD',
    });

    const res = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    // The dirham is pegged at 3.6725; USD 100 is AED 367.25, not AED 100.
    assert.equal(res.body.cost, 367.25);
    assert.equal(res.body.currency, 'AED');
    assert.equal(res.body.sourceCost, 100, 'the figure the vendor quoted has to survive');
    assert.equal(res.body.sourceCurrency, 'USD');
    assert.equal(res.body.rate, 3.6725);
    assert.equal(res.body.rateMissing, false);
    assert.equal(res.body.listPrice, 734.5, 'the list price converts too, or the discount is nonsense');
  });

  it('leaves a price alone when it is already in the document currency', async () => {
    const product = await makeProduct('SKU-AED', 100);
    await request(app, fx.manager).post('/api/price-book', {
      productId: product.id, vendorId: fx.vendor.id, cost: 80, currency: 'AED',
    });

    const res = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    assert.equal(res.body.cost, 80);
    assert.equal(res.body.rate, 1);
    assert.equal(res.body.sourceCost, 80);
  });

  it('gives a dollar order the dollar price, with no conversion', async () => {
    const product = await makeProduct('SKU-USD-PO', 100);
    await request(app, fx.manager).post('/api/price-book', {
      productId: product.id, vendorId: fx.vendor.id, cost: 100, currency: 'USD',
    });

    const res = await request(app, fx.manager)
      .get(`/api/price-book/resolve?productId=${product.id}&quantity=1&currency=USD`);
    assert.equal(res.body.cost, 100, 'a USD order pays the USD price');
    assert.equal(res.body.currency, 'USD');
    assert.equal(res.body.rate, 1);
  });

  it('refuses to pass an unconvertible price off as dirhams', async () => {
    const product = await makeProduct('SKU-NORATE', 100);
    await request(app, fx.manager).post('/api/price-book', {
      productId: product.id, vendorId: fx.vendor.id, cost: 90, currency: 'GBP',
    });

    const res = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    // The danger is a silent 90, which reads as AED 90 and overstates margin by ~4x.
    assert.equal(res.body.rateMissing, true, 'a missing rate must be declared, not assumed to be 1');
    assert.equal(res.body.rate, null);
    assert.equal(res.body.currency, 'GBP', 'the figure is still the vendor’s, so it must say so');
    assert.match(res.body.reason, /no AED rate on file for GBP/);
  });

  it('honours a rate that has been edited in settings', async () => {
    const product = await makeProduct('SKU-EURO', 100);
    await request(app, fx.manager).post('/api/price-book', {
      productId: product.id, vendorId: fx.vendor.id, cost: 100, currency: 'EUR',
    });
    await request(app, fx.admin).put('/api/settings', { 'finance.exchangeRates': { USD: 3.6725, EUR: 4 } });

    const res = await request(app, fx.manager).get(`/api/price-book/resolve?productId=${product.id}&quantity=1`);
    assert.equal(res.body.cost, 400);
    assert.equal(res.body.rate, 4);
  });

  it('keeps the price book report away from that role too', async () => {
    // The screen returned 403 and the report handed over every buy price. A report is
    // just another way to ask the same question.
    const product = await prisma.product.create({
      data: { sku: 'SKU-REPORT', name: 'Reported thing', unit: 'licence', listPrice: 100, cost: 60, vendorId: fx.vendor.id },
    });
    await request(app, fx.manager).post('/api/price-book', { productId: product.id, vendorId: fx.vendor.id, cost: 55 });

    const repRun = await request(app, fx.rep).get('/api/reports/price-book');
    assert.equal(repRun.status, 403, `a rep read the price book report: ${JSON.stringify(repRun.body).slice(0, 160)}`);

    const listed = await request(app, fx.rep).get('/api/reports');
    assert.ok(
      !(listed.body as Array<{ key: string }>).some((r) => r.key === 'price-book'),
      'a report the role cannot open should not be offered to it',
    );

    const managerRun = await request(app, fx.manager).get('/api/reports/price-book');
    assert.equal(managerRun.status, 200);
    assert.equal(managerRun.body.rows.length, 1);
  });

  it('keeps the price book away from a role that cannot see cost', async () => {
    const product = await makeProduct('SKU-RBAC', 100);
    assert.equal((await request(app, fx.rep).get(`/api/price-book?productId=${product.id}`)).status, 403);
    assert.equal((await request(app, fx.rep).post('/api/price-book', { productId: product.id, cost: 1 })).status, 403);
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

// ── exchange rates ────────────────────────────────────────────────────────────

/**
 * The fetcher is pointed at a stub server rather than the real feed: a test that needs
 * the internet fails for reasons that have nothing to do with the code.
 */
describe('exchange rates', () => {
  let server: import('node:http').Server;
  let feed: string;
  let reply: { status: number; body: unknown } = { status: 200, body: { rates: { AED: 3.6725 } } };

  before(async () => {
    const { createServer } = await import('node:http');
    server = createServer((_req, res) => {
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    feed = `http://127.0.0.1:${port}/{from}`;
  });

  after(() => server.close());

  const setRates = async (rates: Record<string, number>) =>
    request(app, fx.admin).put('/api/settings', {
      'finance.exchangeRates': rates,
      'finance.exchangeRateApi': feed,
    });

  it('stores the rate the feed answers with', async () => {
    await setRates({ USD: 3.5 });
    reply = { status: 200, body: { rates: { AED: 3.6725 } } };

    const res = await request(app, fx.admin).post('/api/settings/exchange-rates/refresh', {});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.updated, ['USD']);
    assert.equal(res.body.rates.USD, 3.6725);
  });

  it('refuses a rate that is nowhere near the stored one', async () => {
    await setRates({ USD: 3.6725 });
    // What an inverted feed looks like: dollars per dirham, not dirhams per dollar.
    reply = { status: 200, body: { rates: { AED: 0.2723 } } };

    const res = await request(app, fx.admin).post('/api/settings/exchange-rates/refresh', {});
    assert.equal(res.body.updated.length, 0);
    assert.equal(res.body.rates.USD, 3.6725, 'the good rate must survive a bad answer');
    assert.match(res.body.skipped.USD, /Refused/);
  });

  it('keeps the stored rate when the feed is unreachable', async () => {
    await setRates({ USD: 3.6725 });
    reply = { status: 500, body: { error: 'nope' } };

    const res = await request(app, fx.admin).post('/api/settings/exchange-rates/refresh', {});
    assert.equal(res.body.ok, false);
    assert.equal(res.body.rates.USD, 3.6725);
  });

  it('discards a reply that carries no usable rate', async () => {
    await setRates({ USD: 3.6725 });
    reply = { status: 200, body: { rates: { EUR: 4 } } };

    const res = await request(app, fx.admin).post('/api/settings/exchange-rates/refresh', {});
    assert.equal(res.body.updated.length, 0);
    assert.equal(res.body.rates.USD, 3.6725);
  });

  it('will not let a rep refresh the rates', async () => {
    assert.equal((await request(app, fx.rep).post('/api/settings/exchange-rates/refresh', {})).status, 403);
  });
});

// ── quote cost integrity ──────────────────────────────────────────────────────

describe('quote cost', () => {
  /**
   * A rep cannot see unitCost, so their browser never has it and posts zero. Believing
   * that turns every quote a rep saves into 100% margin, and overwrites a cost that was
   * previously right.
   */
  it('does not let a rep zero the cost by saving a quote', async () => {
    const product = await prisma.product.create({
      data: { sku: 'SKU-COST', name: 'Costed thing', unit: 'licence', listPrice: 380, cost: 200, vendorId: fx.vendor.id },
    });
    await request(app, fx.manager).post('/api/price-book', { productId: product.id, vendorId: fx.vendor.id, cost: 249 });

    const created = await request(app, fx.rep).post('/api/quotes', {
      accountId: fx.customer.id,
      lines: [{ productId: product.id, description: 'Costed thing', quantity: 10, unitPrice: 380, unitCost: 0, discountPct: 0, taxable: true }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const stored = await prisma.quote.findUniqueOrThrow({ where: { id: created.body.id }, include: { lines: true } });
    assert.equal(Number(stored.lines[0].unitCost), 249, 'the price book cost must be used, not the zero the client sent');
    assert.equal(Number(stored.totalCost), 2490);
    assert.equal(Number(stored.marginAmount), 3800 - 2490);
  });

  it('keeps the cost a manager set when a rep edits the same quote', async () => {
    const created = await request(app, fx.manager).post('/api/quotes', {
      accountId: fx.customer.id,
      lines: [{ description: 'Consulting', quantity: 1, unitPrice: 1000, unitCost: 600, discountPct: 0, taxable: true }],
    });
    assert.equal(created.status, 201);

    // The rep changes the price. Their payload carries unitCost: 0 because they cannot see it.
    const edited = await request(app, fx.rep).patch(`/api/quotes/${created.body.id}`, {
      accountId: fx.customer.id,
      lines: [{ description: 'Consulting', quantity: 1, unitPrice: 1200, unitCost: 0, discountPct: 0, taxable: true }],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const stored = await prisma.quote.findUniqueOrThrow({ where: { id: created.body.id }, include: { lines: true } });
    assert.equal(Number(stored.lines[0].unitPrice), 1200, 'the price change must stick');
    assert.equal(Number(stored.lines[0].unitCost), 600, 'the cost must survive an edit by someone who cannot see it');
  });

  it('still lets a manager set the cost by hand', async () => {
    const created = await request(app, fx.manager).post('/api/quotes', {
      accountId: fx.customer.id,
      lines: [{ description: 'Hardware', quantity: 2, unitPrice: 500, unitCost: 310, discountPct: 0, taxable: true }],
    });
    const stored = await prisma.quote.findUniqueOrThrow({ where: { id: created.body.id }, include: { lines: true } });
    assert.equal(Number(stored.lines[0].unitCost), 310);
  });
});

// ── report scoping ────────────────────────────────────────────────────────────

describe('reports', () => {
  /**
   * A report is another way to ask a question the screens already answer, so it has to
   * answer it for the same audience. Nine of sixteen used to return the whole company
   * to a rep — their own pipeline beside every colleague's win rate.
   */
  it('shows a rep their own numbers and a manager everyone\'s', async () => {
    await makeDeal(fx.rep, { name: 'Mine', amount: 50_000 });
    await makeDeal(fx.otherRep, { name: 'Not mine', amount: 900_000 });

    const rows = async (user: typeof fx.rep, key: string) => {
      const res = await request(app, user).get(`/api/reports/${key}`);
      assert.equal(res.status, 200, `${key} failed for ${user.roleName}: ${JSON.stringify(res.body).slice(0, 120)}`);
      return res.body.rows as Array<Record<string, unknown>>;
    };

    // A rep is scoped to their team; otherRep is deliberately on no team.
    for (const key of ['forecast', 'source-performance', 'rep-performance']) {
      const mine = await rows(fx.rep, key);
      const all = await rows(fx.manager, key);
      assert.ok(mine.length < all.length || JSON.stringify(mine) !== JSON.stringify(all),
        `${key} still returns the manager's view to a rep`);
    }

    const leaderboard = await rows(fx.rep, 'rep-performance');
    assert.ok(!leaderboard.some((r) => r.owner === 'otherrep'), 'a rep must not see a colleague outside their team on the leaderboard');
  });

  it('still gives a manager every invoice on the VAT summary', async () => {
    // Scoping must not quietly narrow a filing document for the person who files it.
    const invoice = await makeInvoice([{ description: 'Licence', quantity: 1, unitPrice: 1000 }]);
    await request(app, fx.admin).post(`/api/approvals/invoices/${invoice.id}/submit`);
    await request(app, fx.manager).post(`/api/approvals/invoices/${invoice.id}/approve`);
    await request(app, fx.admin).post(`/api/invoices/${invoice.id}/status`, { status: 'SENT' });

    const res = await request(app, fx.manager).get('/api/reports/vat-summary');
    assert.equal(res.status, 200);
    const vat = (res.body.rows as Array<{ vat: number }>).reduce((sum, r) => sum + r.vat, 0);
    assert.equal(vat.toFixed(2), '50.00', 'the manager must see the full output VAT');
  });
});

// ── dashboard scoping ─────────────────────────────────────────────────────────

describe('dashboard', () => {
  /**
   * Half this endpoint is built with Prisma and half is raw SQL. The two halves have to
   * agree about who the reader is allowed to see, or the tiles are scoped and the charts
   * beside them are not.
   */
  it('keeps a team-scoped dashboard inside the team, in the charts as well as the tiles', async () => {
    const teamRole = await prisma.role.create({
      data: {
        name: 'Team Lead',
        description: 'Sees their own team.',
        permissions: {
          dashboard: { read: 'team', create: false, update: 'none', delete: 'none', export: true },
          deals: { read: 'team', create: true, update: 'team', delete: 'none', export: true },
        } as never,
      },
    });
    const { SESSION_COOKIE, signSessionToken } = await import('../auth/session.js');
    const teamUser = await prisma.user.create({
      data: {
        email: 'teamlead@test.local', name: 'teamlead',
        passwordHash: 'x', roleId: teamRole.id,
        teamId: (await prisma.user.findUniqueOrThrow({ where: { id: fx.rep.id }, select: { teamId: true } })).teamId,
      },
    });
    const lead = {
      id: teamUser.id, email: teamUser.email, name: 'teamlead', roleName: 'Team Lead',
      cookie: `${SESSION_COOKIE}=${await signSessionToken(teamUser.id, 12)}`,
    };

    // One deal inside the team, one owned by a rep on no team at all.
    await makeDeal(fx.rep, { name: 'Inside the team', amount: 50_000 });
    await makeDeal(fx.otherRep, { name: 'Someone else entirely', amount: 900_000 });

    const res = await request(app, lead).get('/api/dashboard/overview');
    assert.equal(res.status, 200);

    const sourceTotal = (res.body.bySource as Array<{ net: number }>).reduce((sum, row) => sum + row.net, 0);
    assert.equal(sourceTotal, 50_000, 'the source chart must not count a deal outside the team');

    const channelTotal = (res.body.byChannel as Array<{ net: number }>).reduce((sum, row) => sum + row.net, 0);
    assert.equal(channelTotal, 50_000, 'the channel chart must not count a deal outside the team');
  });
});
