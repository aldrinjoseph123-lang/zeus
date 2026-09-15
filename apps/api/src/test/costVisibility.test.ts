import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';

/**
 * A role that cannot see cost must not be able to work it out either.
 *
 * Field masking hides fields by name, which is only as good as the list of names. On
 * 15 Sep 2026 a Sales Executive opening a quote received every line's `lineCost` —
 * quantity × unit cost, the hidden number divided by nothing harder than the quantity
 * printed beside it. Invoice lines carried `unitCost` itself, because the invoices
 * module had never been given a cost field to hide.
 *
 * So this walks the screens a Sales Executive can open and looks at what comes back,
 * rather than trusting a list: any key that reads as cost or margin, holding a value,
 * is a leak.
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

const COSTLY = /cost|margin|markup/i;

/** Every path in a response where a cost-like key holds an actual value. */
function leaks(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = path ? `${path}.${key}` : key;
    const found = COSTLY.test(key) && child !== null && typeof child !== 'object' && typeof child !== 'boolean' ? [here] : [];
    return [...found, ...leaks(child, here)];
  });
}

/** A deal the rep owns, with a costed quote on it, accepted and invoiced. */
async function costedPaperwork(owner: TestUser) {
  const product = await prisma.product.create({
    data: { sku: 'FG-3100', name: 'FortiGate 3100F', cost: 4590.63, listPrice: 5508.75, vendorId: fx.vendor.id },
  });
  const deal = await prisma.deal.create({
    data: {
      reference: 'ZEU-D-COST01', name: 'Firewall refresh', accountId: fx.customer.id,
      pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
      amount: 11_017.5, cost: 9_181.26, vatRate: 5, vatAmount: 0, totalAmount: 11_017.5,
      probability: 50, ownerId: owner.id, closeDate: new Date(Date.now() + 30 * 86_400_000),
    },
  });
  const created = await request(app, fx.admin).post('/api/quotes', {
    accountId: fx.customer.id, dealId: deal.id,
    lines: [{ productId: product.id, description: 'FortiGate 3100F', quantity: 2, unitPrice: 5508.75, unitCost: 4590.63 }],
  });
  assert.equal(created.status, 201);
  const quoteId = (created.body as { id: string }).id;
  await prisma.quote.update({ where: { id: quoteId }, data: { preparedById: owner.id, status: 'ACCEPTED' } });

  const invoiced = await request(app, fx.admin).post(`/api/quotes/${quoteId}/invoice`, {});
  assert.equal(invoiced.status, 201);
  const invoiceId = (invoiced.body as { id: string }).id;
  await prisma.invoice.update({ where: { id: invoiceId }, data: { createdById: owner.id } });

  return { deal, quoteId, invoiceId, product };
}

describe('a Sales Executive cannot see or derive cost', () => {
  it('on any screen that shows a quote, an invoice, a deal or a product', async () => {
    const { deal, quoteId, invoiceId, product } = await costedPaperwork(fx.rep);

    const screens = [
      `/api/quotes`, `/api/quotes/${quoteId}`,
      `/api/invoices`, `/api/invoices/${invoiceId}`,
      `/api/deals`, `/api/deals/${deal.id}`,
      `/api/products`, `/api/products/${product.id}`,
      `/api/accounts/${fx.customer.id}`,
    ];

    const found: string[] = [];
    for (const url of screens) {
      const res = await request(app, fx.rep).get(url);
      assert.equal(res.status, 200, `${url} must be readable by the rep, or this proves nothing about it`);
      found.push(...leaks(res.body).map((p) => `${url} → ${p}`));
    }
    assert.deepEqual(found, [], 'every one of these is cost handed to a role that is not meant to have it');
  });

  it('in any report the role is offered — which also has to open', async () => {
    await costedPaperwork(fx.rep);
    const offered = (await request(app, fx.rep).get('/api/reports')).body as Array<{ key: string }>;
    assert.ok(offered.some((r) => r.key === 'quotes'), 'the quotes report is the one that carries margin');

    const found: string[] = [];
    for (const { key } of offered) {
      const res = await request(app, fx.rep).get(`/api/reports/${key}`);
      // The quotes report scoped on `ownerId`, which a quote does not have, and crashed for
      // every role narrower than "all" — so nobody noticed it also had margin to hide.
      assert.equal(res.status, 200, `the ${key} report is offered to the rep and must open`);
      found.push(...leaks(res.body).map((p) => `${key} → ${p}`));
    }
    assert.deepEqual(found, []);
  });

  it('while an administrator still sees all of it, so the sweep is looking in the right place', async () => {
    const { quoteId, invoiceId } = await costedPaperwork(fx.rep);
    const quote = leaks((await request(app, fx.admin).get(`/api/quotes/${quoteId}`)).body);
    const invoice = leaks((await request(app, fx.admin).get(`/api/invoices/${invoiceId}`)).body);
    assert.ok(quote.some((p) => p.endsWith('lineCost')), 'the admin reads line cost on a quote');
    assert.ok(invoice.some((p) => p.endsWith('unitCost')), 'the admin reads unit cost on an invoice');
  });
});
