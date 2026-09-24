import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';
import type { Group } from '../routes/search.js';

/**
 * The search box. One request; every kind of record a person types the number or name of;
 * an exact match first; nothing a role's own list would not show.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

const search = async (user: TestUser, q: string) => (await request(app, user).get(`/api/search?q=${encodeURIComponent(q)}`)).body as { groups: Group[] };
const group = (r: { groups: Group[] }, label: string) => r.groups.find((g) => g.label === label);

describe('search', () => {
  it('finds a document by its number, the customer PO on an invoice, and a deal by reference', async () => {
    const quote = (await request(app, fx.admin).post('/api/quotes', { accountId: fx.customer.id, lines: [{ description: 'Firewall', quantity: 1, unitPrice: 100 }] })).body as { id: string; number: string };
    const invoice = (await request(app, fx.admin).post('/api/invoices', {
      accountId: fx.customer.id, lines: [{ description: 'Line', quantity: 1, unitPrice: 100, unitCost: 0, discountPct: 0, taxable: false, vatRate: 0 }],
    })).body as { id: string; number: string };
    await prisma.invoice.update({ where: { id: invoice.id }, data: { poNumber: 'PO-4711' } });
    const po = (await request(app, fx.admin).post('/api/purchase-orders', { direction: 'SUPPLIER', accountId: fx.vendor.id, lines: [{ description: 'Widgets', quantity: 10, unitPrice: 50 }] })).body as { id: string; number: string };
    const deal = await prisma.deal.create({
      data: {
        reference: 'ZEU-D-SRCH1', name: 'Firewall refresh', accountId: fx.customer.id, status: 'OPEN', pipelineId: fx.pipeline.id,
        stageId: fx.pipeline.stages[1].id, amount: 1000, probability: 50, ownerId: fx.rep.id, closeDate: new Date(),
      },
    });

    assert.deepEqual(group(await search(fx.admin, quote.number), 'Quotes')?.rows.map((r) => r.path), [`/quotes/${quote.id}`]);
    const byPo = await search(fx.admin, 'PO-4711');
    assert.deepEqual(byPo.groups.map((g) => g.label), ['Invoices'], 'the customer PO number finds only the invoice carrying it');
    assert.equal(byPo.groups[0].rows[0].primary, `${invoice.number} · PO PO-4711`);
    assert.deepEqual(group(await search(fx.admin, po.number), 'Purchase orders')?.rows.map((r) => r.path), [`/purchase-orders/${po.id}`]);
    const byRef = await search(fx.admin, 'ZEU-D-SRCH1');
    assert.deepEqual(byRef.groups[0].rows[0], { id: deal.id, primary: 'ZEU-D-SRCH1 · Firewall refresh', secondary: 'Test Customer LLC', path: `/deals/${deal.id}`, type: 'deal' });
    assert.ok(!('amount' in byRef.groups[0].rows[0]), 'a result is a name and a link, never the money');
  });

  it('puts what was typed exactly first, across and within groups', async () => {
    const acme = await prisma.account.create({ data: { name: 'Acme', type: 'CUSTOMER' } });
    await prisma.account.create({ data: { name: 'Acme Holdings', type: 'PROSPECT' } });
    await prisma.deal.create({
      data: {
        reference: 'ZEU-D-SRCH2', name: 'Acme rollout', accountId: acme.id, status: 'OPEN', pipelineId: fx.pipeline.id,
        stageId: fx.pipeline.stages[1].id, amount: 1, probability: 50, ownerId: fx.rep.id, closeDate: new Date(),
      },
    });
    const r = await search(fx.admin, 'acme');
    assert.equal(r.groups[0].label, 'Accounts', 'the group holding the exact match leads');
    assert.deepEqual(r.groups[0].rows.map((x) => x.primary), ['Acme', 'Acme Holdings']);
    assert.ok(group(r, 'Deals'), 'the deal that mentions it is still there, after');
  });

  it('shows a role only the kinds it may read, and only its own scope of them', async () => {
    const role = await prisma.role.create({
      data: { name: 'Own Deals Only', permissions: { deals: { read: 'own', create: false, update: 'none', delete: 'none', export: false } } as never },
    });
    const user = await prisma.user.create({ data: { email: 'owndeals@test.local', name: 'owndeals', passwordHash: 'x', roleId: role.id } });
    const { SESSION_COOKIE, signSessionToken } = await import('../auth/session.js');
    const narrow: TestUser = { id: user.id, email: user.email, name: user.name, roleName: role.name, cookie: `${SESSION_COOKIE}=${await signSessionToken(user.id, 12)}` };
    const mk = (reference: string, ownerId: string) => prisma.deal.create({
      data: { reference, name: `Shared name`, accountId: fx.customer.id, status: 'OPEN', pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[1].id, amount: 1, probability: 50, ownerId, closeDate: new Date() },
    });
    await mk('ZEU-D-OWN', narrow.id);
    await mk('ZEU-D-THEIRS', fx.rep.id);

    const r = await search(narrow, 'Shared name');
    assert.deepEqual(r.groups.map((g) => g.label), ['Deals'], 'accounts and contacts are not offered to a role that cannot read them');
    assert.deepEqual(r.groups[0].rows.map((x) => x.primary), ['ZEU-D-OWN · Shared name']);
    assert.deepEqual((await search(narrow, 'Test Customer')).groups.filter((g) => g.label === 'Accounts'), []);
  });

  it('answers nothing for a single character, and refuses no one signed in', async () => {
    assert.deepEqual(await search(fx.admin, 'a'), { groups: [] });
    assert.equal((await app.inject({ method: 'GET', url: '/api/search?q=acme' })).statusCode, 401);
  });
});
