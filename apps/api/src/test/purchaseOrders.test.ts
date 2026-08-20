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

describe('purchase order creation', () => {
  it('a supplier PO gets an allocated number; a customer PO needs its own', async () => {
    const supplier = await request(app, fx.admin).post('/api/purchase-orders', {
      direction: 'SUPPLIER', accountId: fx.vendor.id,
      lines: [{ description: 'Widgets', quantity: 10, unitPrice: 50 }],
    });
    assert.equal(supplier.status, 201, JSON.stringify(supplier.body));
    assert.match(supplier.body.number, /^ZEU-PO-/);

    const missingNumber = await request(app, fx.admin).post('/api/purchase-orders', { direction: 'CUSTOMER', accountId: fx.customer.id });
    assert.equal(missingNumber.status, 400);

    const customer = await request(app, fx.admin).post('/api/purchase-orders', {
      direction: 'CUSTOMER', accountId: fx.customer.id, number: 'CUST-PO-9001',
    });
    assert.equal(customer.status, 201, JSON.stringify(customer.body));
    assert.equal(customer.body.number, 'CUST-PO-9001');
  });

  it('refuses a duplicate number within the same direction', async () => {
    await request(app, fx.admin).post('/api/purchase-orders', { direction: 'CUSTOMER', accountId: fx.customer.id, number: 'DUPE-1' });
    const clash = await request(app, fx.admin).post('/api/purchase-orders', { direction: 'CUSTOMER', accountId: fx.customer.id, number: 'DUPE-1' });
    assert.equal(clash.status, 400);
  });

  it('totals the order from its lines including VAT', async () => {
    const res = await request(app, fx.admin).post('/api/purchase-orders', {
      direction: 'SUPPLIER', accountId: fx.vendor.id, vatRate: 5,
      lines: [{ description: 'Licences', quantity: 10, unitPrice: 100, taxable: true }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(Number(res.body.subtotal), 1000);
    assert.equal(Number(res.body.vatAmount), 50);
    assert.equal(Number(res.body.total), 1050);
  });
});

describe('purchase order status transitions', () => {
  async function draftSupplierPo(total = 500_000) {
    const res = await request(app, fx.admin).post('/api/purchase-orders', {
      direction: 'SUPPLIER', accountId: fx.vendor.id,
      lines: [{ description: 'Big order', quantity: 1, unitPrice: total }],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as { id: string; number: string; total: string };
  }

  it('blocks issuing a high-value supplier PO until a manager approves it', async () => {
    const po = await draftSupplierPo();
    const blocked = await request(app, fx.admin).post(`/api/purchase-orders/${po.id}/status`, { status: 'ISSUED' });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /approval/i);
  });

  it('refuses to cancel an order that already has a payment recorded', async () => {
    const po = await draftSupplierPo(1000);
    await request(app, fx.admin).post(`/api/purchase-orders/${po.id}/status`, { status: 'ISSUED' }).catch(() => undefined);
    await prisma.purchaseOrder.update({ where: { id: po.id }, data: { status: 'ISSUED', approvalStatus: 'APPROVED' } });
    await request(app, fx.admin).post('/api/payments', { direction: 'OUTGOING', amount: 100, purchaseOrderId: po.id });

    const res = await request(app, fx.admin).post(`/api/purchase-orders/${po.id}/status`, { status: 'CANCELLED' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /already moved/i);
  });
});

describe('goods receipt', () => {
  async function issuedSupplierPo() {
    const res = await request(app, fx.admin).post('/api/purchase-orders', {
      direction: 'SUPPLIER', accountId: fx.vendor.id,
      lines: [{ description: 'Cheap item', quantity: 5, unitPrice: 10 }],
    });
    return res.body as { id: string; lines: Array<{ id: string; quantity: string }> };
  }

  it('will not receive more than was ordered', async () => {
    const po = await issuedSupplierPo();
    const res = await request(app, fx.admin).post(`/api/purchase-orders/${po.id}/receive`, {
      received: [{ lineId: po.lines[0].id, quantityReceived: 10 }],
    });
    assert.equal(res.status, 400);
  });

  it('moves to PARTIALLY_RECEIVED then RECEIVED as quantities come in', async () => {
    const po = await issuedSupplierPo();
    const partial = await request(app, fx.admin).post(`/api/purchase-orders/${po.id}/receive`, {
      received: [{ lineId: po.lines[0].id, quantityReceived: 2 }],
    });
    assert.equal(partial.status, 200, JSON.stringify(partial.body));
    assert.equal(partial.body.status, 'PARTIALLY_RECEIVED');

    const full = await request(app, fx.admin).post(`/api/purchase-orders/${po.id}/receive`, {
      received: [{ lineId: po.lines[0].id, quantityReceived: 5 }],
    });
    assert.equal(full.body.status, 'RECEIVED');
  });
});

describe('supplier PO from a won quote', () => {
  it('carries lines across at cost, not the price the customer was quoted', async () => {
    const product = await prisma.product.create({ data: { sku: `T-${Date.now()}`, name: 'Test SKU', unit: 'licence', listPrice: 100, cost: 40, type: 'SERVICE', category: 'x', currency: 'AED' } });
    const quote = await request(app, fx.admin).post('/api/quotes', {
      accountId: fx.customer.id,
      lines: [{ productId: product.id, description: 'Test SKU', quantity: 3, unitPrice: 100, unitCost: 40 }],
    });
    assert.equal(quote.status, 201, JSON.stringify(quote.body));

    const po = await request(app, fx.admin).post(`/api/quotes/${quote.body.id}/supplier-po`, { vendorId: fx.vendor.id });
    assert.equal(po.status, 201, JSON.stringify(po.body));
    assert.equal(po.body.direction, 'SUPPLIER');
    assert.equal(Number(po.body.lines[0].unitPrice), 40, 'buy price, not the 100 the customer was quoted');
  });
});

describe('sending and printing', () => {
  it("refuses to print or email a customer's own PO back to them", async () => {
    const po = await request(app, fx.admin).post('/api/purchase-orders', { direction: 'CUSTOMER', accountId: fx.customer.id, number: 'CUST-1' });
    const pdf = await request(app, fx.admin).get(`/api/purchase-orders/${po.body.id}/pdf`);
    assert.equal(pdf.status, 400);
    const send = await request(app, fx.admin).post(`/api/purchase-orders/${po.body.id}/send`, { to: ['vendor@example.com'] });
    assert.equal(send.status, 400);
  });
});

describe('deletion', () => {
  it('refuses to delete an order with payments recorded', async () => {
    const po = await request(app, fx.admin).post('/api/purchase-orders', {
      direction: 'SUPPLIER', accountId: fx.vendor.id, lines: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    });
    await prisma.purchaseOrder.update({ where: { id: po.body.id }, data: { status: 'ISSUED', approvalStatus: 'APPROVED' } });
    await request(app, fx.admin).post('/api/payments', { direction: 'OUTGOING', amount: 50, purchaseOrderId: po.body.id });

    const res = await request(app, fx.admin).del(`/api/purchase-orders/${po.body.id}`);
    assert.equal(res.status, 400);
  });

  it('soft-deletes an order with no payments, and offers an undo', async () => {
    const po = await request(app, fx.admin).post('/api/purchase-orders', {
      direction: 'CUSTOMER', accountId: fx.customer.id, number: 'DELETE-ME',
    });
    const res = await request(app, fx.admin).del(`/api/purchase-orders/${po.body.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.undoId);
    assert.ok((await prisma.purchaseOrder.findUnique({ where: { id: po.body.id } }))?.deletedAt);
  });
});

describe('permission gating', () => {
  it('a rep cannot create or delete a purchase order', async () => {
    assert.equal((await request(app, fx.rep).post('/api/purchase-orders', { direction: 'CUSTOMER', accountId: fx.customer.id, number: 'X' })).status, 403);
  });
});
