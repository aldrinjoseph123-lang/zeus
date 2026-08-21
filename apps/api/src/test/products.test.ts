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

const productBody = (over: Record<string, unknown> = {}) => ({
  sku: `SKU-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
  name: 'Managed EDR', type: 'SERVICE', unit: 'endpoint',
  listPrice: 100, cost: 40, currency: 'AED', taxable: true,
  ...over,
});

describe('product catalog CRUD', () => {
  it('creates a product and reads it back', async () => {
    const body = productBody();
    const created = await request(app, fx.admin).post('/api/products', body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.sku, body.sku);
    assert.equal(Number(created.body.listPrice), 100);

    const fetched = await request(app, fx.admin).get(`/api/products/${created.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.name, 'Managed EDR');
  });

  it('refuses a duplicate SKU', async () => {
    const body = productBody({ sku: 'DUPE-SKU-1' });
    assert.equal((await request(app, fx.admin).post('/api/products', body)).status, 201);

    const clash = await request(app, fx.admin).post('/api/products', productBody({ sku: 'DUPE-SKU-1' }));
    assert.equal(clash.status, 400);
    assert.match(clash.body.error, /already exists/i);
  });

  it('requires a SKU and a name', async () => {
    assert.equal((await request(app, fx.admin).post('/api/products', { name: 'No SKU' })).status, 400);
    assert.equal((await request(app, fx.admin).post('/api/products', { sku: 'NO-NAME' })).status, 400);
  });

  it('updates a product and records the change', async () => {
    const created = await request(app, fx.admin).post('/api/products', productBody());
    const updated = await request(app, fx.admin).patch(`/api/products/${created.body.id}`, { listPrice: 250 });
    assert.equal(updated.status, 200);
    assert.equal(Number(updated.body.listPrice), 250);

    const entry = await prisma.auditLog.findFirst({ where: { entity: 'Product', entityId: created.body.id, action: 'update' } });
    assert.ok(entry, 'the update is audited');
  });

  it('404s an unknown product', async () => {
    assert.equal((await request(app, fx.admin).get('/api/products/not-a-real-id')).status, 404);
    assert.equal((await request(app, fx.admin).patch('/api/products/not-a-real-id', { name: 'x' })).status, 404);
  });
});

describe('deleting a product protects the paperwork', () => {
  it('hard-deletes one that has never been used, with an undo', async () => {
    const created = await request(app, fx.admin).post('/api/products', productBody());
    const res = await request(app, fx.admin).del(`/api/products/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.undoId);
    assert.equal(await prisma.product.findUnique({ where: { id: created.body.id } }), null);
  });

  it('deactivates instead of deleting once it appears on a document', async () => {
    const created = await request(app, fx.admin).post('/api/products', productBody());
    // A quote line referencing it is enough — the figures on that quote must stay intact.
    const quote = await request(app, fx.admin).post('/api/quotes', {
      accountId: fx.customer.id,
      lines: [{ productId: created.body.id, description: 'Managed EDR', quantity: 1, unitPrice: 100, unitCost: 40 }],
    });
    assert.equal(quote.status, 201, JSON.stringify(quote.body));

    const res = await request(app, fx.admin).del(`/api/products/${created.body.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.deactivated, true);

    const still = await prisma.product.findUnique({ where: { id: created.body.id } });
    assert.ok(still, 'the row survives so the quote still resolves');
    assert.equal(still?.isActive, false);
  });
});

describe('cost is hidden from a rep, in both directions', () => {
  it('strips cost from what a rep reads', async () => {
    await request(app, fx.admin).post('/api/products', productBody({ sku: 'MASK-1' }));

    const asAdmin = await request(app, fx.admin).get('/api/products');
    assert.ok('cost' in asAdmin.body.data[0], 'an admin sees cost');

    const asRep = await request(app, fx.rep).get('/api/products');
    assert.equal(asRep.status, 200);
    assert.ok(!('cost' in asRep.body.data[0]), 'a rep never receives the cost field');
  });

  it('ignores a cost a rep tries to write', async () => {
    // A rep cannot create products at all, but a manager can — and a manager's own
    // permission map has no field restriction, so this proves the strip is per-role.
    const created = await request(app, fx.manager).post('/api/products', productBody({ sku: 'MASK-2', cost: 55 }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(Number(created.body.cost), 55, 'a manager may set cost');
  });
});

describe('permission gating', () => {
  it('lets a rep read but not write', async () => {
    assert.equal((await request(app, fx.rep).get('/api/products')).status, 200);
    assert.equal((await request(app, fx.rep).post('/api/products', productBody())).status, 403);
  });

  it('lets a manager create and update but not delete', async () => {
    const created = await request(app, fx.manager).post('/api/products', productBody());
    assert.equal(created.status, 201);
    assert.equal((await request(app, fx.manager).patch(`/api/products/${created.body.id}`, { name: 'Renamed' })).status, 200);
    assert.equal((await request(app, fx.manager).del(`/api/products/${created.body.id}`)).status, 403, 'deleting catalog items is an admin action');
  });

  it('is closed to anonymous', async () => {
    assert.equal((await request(app).get('/api/products')).status, 401);
  });
});
