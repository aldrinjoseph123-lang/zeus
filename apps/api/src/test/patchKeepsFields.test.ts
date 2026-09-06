import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * A PATCH must change only what it carries.
 *
 * After the Zod 4 upgrade, `.partial()` kept every `.default()`, so a body of `{ name }`
 * silently became `{ name, type: 'PROSPECT', cost: 0, lines: [] … }` and the update
 * overwrote fields nobody sent. The UI sends partial bodies in several places ("mark
 * complete" on an activity, a lead's status change), so this was live data corruption.
 * Each case below pins one defaulted field on one route.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

const id = (res: { body: unknown }) => (res.body as { id: string }).id;

describe('PATCH keeps fields it does not carry', () => {
  it('account: renaming a customer keeps it a customer', async () => {
    const acc = await request(app, fx.admin).post('/api/accounts', { name: 'Keep Type Co', type: 'CUSTOMER', ignoreDuplicates: true });
    const res = await request(app, fx.admin).patch(`/api/accounts/${id(acc)}`, { name: 'Keep Type Co LLC' });
    assert.equal(res.status, 200);
    assert.equal((res.body as { type: string }).type, 'CUSTOMER');
  });

  it('activity: completing a call keeps it a call', async () => {
    const act = await request(app, fx.admin).post('/api/activities', { type: 'CALL', subject: 'Follow-up call', accountId: fx.customer.id });
    assert.equal(act.status, 201, JSON.stringify(act.body));
    const res = await request(app, fx.admin).patch(`/api/activities/${id(act)}`, { status: 'Completed' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as { type: string }).type, 'CALL');
  });

  it('lead: a status change keeps the source', async () => {
    const lead = await request(app, fx.admin).post('/api/leads', { firstName: 'Sam', lastName: 'Source', company: 'Source Co', source: 'Partner Referral', ignoreDuplicates: true });
    assert.equal(lead.status, 201, JSON.stringify(lead.body));
    const res = await request(app, fx.admin).patch(`/api/leads/${id(lead)}`, { status: 'WORKING' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as { source: string }).source, 'Partner Referral');
  });

  it('product: renaming keeps price, cost, unit and currency', async () => {
    const prod = await request(app, fx.admin).post('/api/products', { sku: 'KEEP-1', name: 'Keep Price', type: 'SERVICE', unit: 'hour', listPrice: 900, cost: 400, currency: 'USD' });
    assert.equal(prod.status, 201, JSON.stringify(prod.body));
    const res = await request(app, fx.admin).patch(`/api/products/${id(prod)}`, { name: 'Keep Price v2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as { type: string; unit: string; listPrice: string | number; cost: string | number; currency: string; isActive: boolean };
    assert.equal(body.type, 'SERVICE');
    assert.equal(body.unit, 'hour');
    assert.equal(Number(body.listPrice), 900);
    assert.equal(Number(body.cost), 400);
    assert.equal(body.currency, 'USD');
    assert.equal(body.isActive, true);
  });

  it('quote: editing notes keeps the lines', async () => {
    const quote = await request(app, fx.admin).post('/api/quotes', { accountId: fx.customer.id, lines: [{ description: 'Thing', quantity: 2, unitPrice: 100 }] });
    assert.equal(quote.status, 201, JSON.stringify(quote.body));
    const res = await request(app, fx.admin).patch(`/api/quotes/${id(quote)}`, { notes: 'Delivery in two weeks' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as { lines: unknown[]; subtotal: string | number };
    assert.equal(body.lines.length, 1, 'the one line must survive');
    assert.equal(Number(body.subtotal), 200);
  });

  it('subscription: editing notes keeps quantity, price and term', async () => {
    const sub = await request(app, fx.admin).post('/api/subscriptions', { accountId: fx.customer.id, description: 'Keep Term', quantity: 25, unitPrice: 120, termMonths: 36, startDate: '2026-01-01' });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const res = await request(app, fx.admin).patch(`/api/subscriptions/${id(sub)}`, { notes: 'renewal call booked' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const body = res.body as { quantity: string | number; unitPrice: string | number; termMonths: number };
    assert.equal(Number(body.quantity), 25);
    assert.equal(Number(body.unitPrice), 120);
    assert.equal(body.termMonths, 36);
  });

  it('registration: adding a note keeps the partner side', async () => {
    const partner = await request(app, fx.admin).post('/api/accounts', { name: 'Side Partner', type: 'PARTNER', ignoreDuplicates: true });
    const deal = await request(app, fx.admin).post('/api/deals', { name: 'Sided deal', accountId: fx.customer.id, ignoreDuplicates: true });
    const reg = await request(app, fx.admin).post(`/api/deals/${id(deal)}/registrations`, { side: 'PARTNER', partnerId: id(partner), status: 'SUBMITTED' });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const res = await request(app, fx.admin).patch(`/api/registrations/${id(reg)}`, { notes: 'chased' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as { side: string }).side, 'PARTNER');
  });
});
