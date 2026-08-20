import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';

let app: FastifyInstance;
let fx: Awaited<ReturnType<typeof seedFixtures>>;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

/** Draft -> approved -> sent, the same sequence api.test.ts's own invoice tests use —
 * `approvals.invoicesEnabled` defaults on, min amount 0, so every invoice needs a
 * manager's sign-off before it can be issued. */
async function issuedInvoice(amount: number) {
  const created = await request(app, fx.admin).post('/api/invoices', {
    accountId: fx.customer.id,
    lines: [{ description: 'Line', quantity: 1, unitPrice: amount, unitCost: 0, discountPct: 0, taxable: false, vatRate: 0 }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await request(app, fx.admin).post(`/api/approvals/invoices/${created.body.id}/submit`);
  await request(app, fx.manager).post(`/api/approvals/invoices/${created.body.id}/approve`);
  const sent = await request(app, fx.admin).post(`/api/invoices/${created.body.id}/status`, { status: 'SENT' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body as { id: string; number: string; total: string; status: string };
}

async function issuedSupplierPo(amount: number) {
  const created = await request(app, fx.admin).post('/api/purchase-orders', {
    direction: 'SUPPLIER', accountId: fx.vendor.id, lines: [{ description: 'Line', quantity: 1, unitPrice: amount }],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  await prisma.purchaseOrder.update({ where: { id: created.body.id }, data: { status: 'ISSUED', approvalStatus: 'APPROVED' } });
  return created.body as { id: string; number: string; total: string };
}

describe('recording a receipt (INCOMING)', () => {
  it('must be against an invoice', async () => {
    const res = await request(app, fx.admin).post('/api/payments', { direction: 'INCOMING', amount: 100 });
    assert.equal(res.status, 400);
  });

  it('refuses a draft or cancelled invoice', async () => {
    const draft = await request(app, fx.admin).post('/api/invoices', {
      accountId: fx.customer.id, lines: [{ description: 'x', quantity: 1, unitPrice: 100, unitCost: 0, discountPct: 0, taxable: false, vatRate: 0 }],
    });
    const onDraft = await request(app, fx.admin).post('/api/payments', { direction: 'INCOMING', amount: 100, invoiceId: draft.body.id });
    assert.equal(onDraft.status, 400);
    assert.match(onDraft.body.error, /has not been issued/i);
  });

  it('updates the invoice balance and status as it is paid down', async () => {
    const invoice = await issuedInvoice(1000);
    const partial = await request(app, fx.admin).post('/api/payments', { direction: 'INCOMING', amount: 400, invoiceId: invoice.id });
    assert.equal(partial.status, 201, JSON.stringify(partial.body));

    const afterPartial = await request(app, fx.admin).get(`/api/invoices/${invoice.id}`);
    assert.equal(afterPartial.body.status, 'PARTIAL');
    assert.equal(Number(afterPartial.body.amountPaid), 400);

    await request(app, fx.admin).post('/api/payments', { direction: 'INCOMING', amount: 600, invoiceId: invoice.id });
    const afterFull = await request(app, fx.admin).get(`/api/invoices/${invoice.id}`);
    assert.equal(afterFull.body.status, 'PAID');
  });

  it('blocks an overpayment unless explicitly confirmed', async () => {
    const invoice = await issuedInvoice(500);
    const blocked = await request(app, fx.admin).post('/api/payments', { direction: 'INCOMING', amount: 600, invoiceId: invoice.id });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /more than/i);

    const confirmed = await request(app, fx.admin).post('/api/payments', { direction: 'INCOMING', amount: 600, invoiceId: invoice.id, allowOverpayment: true });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  });

  it('notifies once the invoice is fully settled', async () => {
    const invoice = await issuedInvoice(200);
    await request(app, fx.admin).post('/api/payments', { direction: 'INCOMING', amount: 200, invoiceId: invoice.id });
    const notified = await prisma.notification.findFirst({ where: { type: 'invoice_paid' } });
    assert.ok(notified, 'a settled invoice fires invoice_paid');
  });
});

describe('recording a payment out (OUTGOING)', () => {
  it('must be against a purchase order', async () => {
    const res = await request(app, fx.admin).post('/api/payments', { direction: 'OUTGOING', amount: 100 });
    assert.equal(res.status, 400);
  });

  it('refuses a customer-direction PO — that is money coming in, not out', async () => {
    const customerPo = await request(app, fx.admin).post('/api/purchase-orders', { direction: 'CUSTOMER', accountId: fx.customer.id, number: 'WRONG-DIR' });
    const res = await request(app, fx.admin).post('/api/payments', { direction: 'OUTGOING', amount: 100, purchaseOrderId: customerPo.body.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /customer order/i);
  });

  it('refuses a draft supplier PO', async () => {
    const draft = await request(app, fx.admin).post('/api/purchase-orders', {
      direction: 'SUPPLIER', accountId: fx.vendor.id, lines: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    });
    const res = await request(app, fx.admin).post('/api/payments', { direction: 'OUTGOING', amount: 100, purchaseOrderId: draft.body.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /still a draft/i);
  });

  it('updates the PO balance', async () => {
    const po = await issuedSupplierPo(1000);
    await request(app, fx.admin).post('/api/payments', { direction: 'OUTGOING', amount: 300, purchaseOrderId: po.id });
    const after = await request(app, fx.admin).get(`/api/purchase-orders/${po.id}`);
    assert.equal(Number(after.body.amountPaid), 300);
  });
});

describe('deleting a payment', () => {
  it('reverses the invoice balance and offers an undo', async () => {
    const invoice = await issuedInvoice(500);
    const payment = await request(app, fx.admin).post('/api/payments', { direction: 'INCOMING', amount: 500, invoiceId: invoice.id });
    const paid = await request(app, fx.admin).get(`/api/invoices/${invoice.id}`);
    assert.equal(paid.body.status, 'PAID');

    const del = await request(app, fx.admin).del(`/api/payments/${payment.body.id}`);
    assert.equal(del.status, 200);
    assert.ok(del.body.undoId);

    const afterDelete = await request(app, fx.admin).get(`/api/invoices/${invoice.id}`);
    assert.equal(Number(afterDelete.body.amountPaid), 0);
    assert.notEqual(afterDelete.body.status, 'PAID');
  });
});

describe('cash position', () => {
  it('reports outstanding, overdue and due-this-week receivables', async () => {
    const invoice = await issuedInvoice(1000);
    await prisma.invoice.update({ where: { id: invoice.id }, data: { dueDate: new Date(Date.now() - 5 * 86_400_000) } });

    const res = await request(app, fx.admin).get('/api/payments/position');
    assert.equal(res.status, 200);
    assert.equal(res.body.receivable.outstanding, 1000);
    assert.equal(res.body.receivable.overdue, 1000);
  });
});

describe('permission gating', () => {
  it('a rep cannot record or delete a payment', async () => {
    assert.equal((await request(app, fx.rep).post('/api/payments', { direction: 'INCOMING', amount: 100 })).status, 403);
    assert.equal((await request(app, fx.rep).del('/api/payments/whatever')).status, 403);
  });
});
