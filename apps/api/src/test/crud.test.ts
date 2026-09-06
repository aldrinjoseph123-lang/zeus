import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

/**
 * CRUD and input-validation coverage for the two core models the logic suite skips
 * (Accounts, Contacts): the full create→read→update→delete cycle, and the status
 * codes a client relies on — 401 without a session, 400 on a bad body, 404 on an id
 * that is not there, and proof that an unexpected field cannot smuggle itself into a row.
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

describe('accounts CRUD + validation', () => {
  it('rejects anonymous access', async () => {
    assert.equal((await request(app).get('/api/accounts')).status, 401);
    assert.equal((await request(app).post('/api/accounts', { name: 'X' })).status, 401);
  });

  it('runs the full create → read → update → delete cycle', async () => {
    const created = await request(app, fx.admin).post('/api/accounts', { name: 'Acme Trading', type: 'CUSTOMER', ignoreDuplicates: true });
    assert.equal(created.status, 201);
    const id = (created.body as { id: string }).id;

    assert.equal((await request(app, fx.admin).get(`/api/accounts/${id}`)).status, 200);

    const patched = await request(app, fx.admin).patch(`/api/accounts/${id}`, { name: 'Acme Trading LLC' });
    assert.equal(patched.status, 200);
    assert.equal((patched.body as { name: string }).name, 'Acme Trading LLC');

    const deleted = await request(app, fx.admin).del(`/api/accounts/${id}`);
    assert.ok(deleted.status < 300, `delete returned ${deleted.status}`);
    assert.equal((await request(app, fx.admin).get(`/api/accounts/${id}`)).status, 404);
  });

  it('400s a create missing the required name', async () => {
    const res = await request(app, fx.admin).post('/api/accounts', { type: 'CUSTOMER' });
    assert.equal(res.status, 400);
  });

  it('404s reads, updates and deletes of an unknown id', async () => {
    assert.equal((await request(app, fx.admin).get('/api/accounts/does-not-exist')).status, 404);
    assert.equal((await request(app, fx.admin).patch('/api/accounts/does-not-exist', { name: 'x' })).status, 404);
    assert.equal((await request(app, fx.admin).del('/api/accounts/does-not-exist')).status, 404);
  });

  it('strips an unexpected field instead of persisting it (no mass assignment)', async () => {
    const res = await request(app, fx.admin).post('/api/accounts', { name: 'Ghost Co', isDeleted: true, evil: 'x', ignoreDuplicates: true });
    assert.equal(res.status, 201);
    const row = await prisma.account.findUnique({ where: { id: (res.body as { id: string }).id } });
    assert.equal(row?.deletedAt, null, 'a client-sent flag must not soft-delete the new row');
    assert.equal((row as unknown as Record<string, unknown>).evil, undefined);
  });

  it('409s a blatant duplicate unless the warning is dismissed', async () => {
    await request(app, fx.admin).post('/api/accounts', { name: 'Dup Co', ignoreDuplicates: true });
    const again = await request(app, fx.admin).post('/api/accounts', { name: 'Dup Co' });
    assert.equal(again.status, 409);
  });
});

describe('contacts CRUD + validation', () => {
  it('rejects anonymous access', async () => {
    assert.equal((await request(app).get('/api/contacts')).status, 401);
  });

  it('runs the full create → read → update → delete cycle', async () => {
    const created = await request(app, fx.admin).post('/api/contacts', { firstName: 'Sara', lastName: 'Khan', accountId: fx.customer.id });
    assert.equal(created.status, 201);
    const id = (created.body as { id: string }).id;

    assert.equal((await request(app, fx.admin).get(`/api/contacts/${id}`)).status, 200);
    const patched = await request(app, fx.admin).patch(`/api/contacts/${id}`, { jobTitle: 'CTO' });
    assert.equal(patched.status, 200);
    assert.equal((patched.body as { jobTitle: string }).jobTitle, 'CTO');

    const deleted = await request(app, fx.admin).del(`/api/contacts/${id}`);
    assert.ok(deleted.status < 300, `delete returned ${deleted.status}`);
    assert.equal((await request(app, fx.admin).get(`/api/contacts/${id}`)).status, 404);
  });

  it('400s a create missing a required name', async () => {
    assert.equal((await request(app, fx.admin).post('/api/contacts', { firstName: 'Only' })).status, 400);
  });

  it('400s a malformed email', async () => {
    assert.equal((await request(app, fx.admin).post('/api/contacts', { firstName: 'Bad', lastName: 'Email', email: 'not-an-email' })).status, 400);
  });

  it('404s an unknown id', async () => {
    assert.equal((await request(app, fx.admin).get('/api/contacts/nope')).status, 404);
  });
});

/**
 * Deleting an account must refuse while anything still points at it. The daily
 * integrity sweep flags a quote, invoice or live deal/contact under a soft-deleted
 * account as drift, so the guard has to match that definition exactly — the first
 * live deploy orphaned a cancelled invoice because the old guard only checked open deals.
 */
describe('account deletion guard', () => {
  it('refuses while an invoice exists in any status, and the bulk path skips it', async () => {
    const acc = await request(app, fx.admin).post('/api/accounts', { name: 'Guarded Co', type: 'CUSTOMER', ignoreDuplicates: true });
    const id = (acc.body as { id: string }).id;
    const inv = await request(app, fx.admin).post('/api/invoices', { accountId: id, lines: [{ description: 'Thing', quantity: 1, unitPrice: 100 }] });
    assert.equal(inv.status, 201);
    const cancelled = await request(app, fx.admin).post(`/api/invoices/${(inv.body as { id: string }).id}/status`, { status: 'CANCELLED' });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    const del = await request(app, fx.admin).del(`/api/accounts/${id}`);
    assert.equal(del.status, 400);
    assert.match(String((del.body as { error: string }).error), /1 invoice/);

    const bulk = await request(app, fx.admin).post('/api/accounts/bulk-delete', { ids: [id] });
    assert.deepEqual(bulk.body, { deleted: 0, skipped: 1 });
    assert.equal((await request(app, fx.admin).get(`/api/accounts/${id}`)).status, 200);
  });

  it('refuses while a contact is attached, then allows once it is gone', async () => {
    const acc = await request(app, fx.admin).post('/api/accounts', { name: 'Lonely Co', type: 'PROSPECT', ignoreDuplicates: true });
    const id = (acc.body as { id: string }).id;
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'Only', lastName: 'Person', accountId: id, ignoreDuplicates: true });
    assert.equal(contact.status, 201);

    const blocked = await request(app, fx.admin).del(`/api/accounts/${id}`);
    assert.equal(blocked.status, 400);
    assert.match(String((blocked.body as { error: string }).error), /1 contact/);

    assert.ok((await request(app, fx.admin).del(`/api/contacts/${(contact.body as { id: string }).id}`)).status < 300);
    assert.ok((await request(app, fx.admin).del(`/api/accounts/${id}`)).status < 300);
    assert.equal((await request(app, fx.admin).get(`/api/accounts/${id}`)).status, 404);
  });
});
