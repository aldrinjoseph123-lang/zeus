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
    accountId: fx.customer.id, dealId: deal.id, defaultMarkupPct: 20,
    lines: [
      { productId: product.id, description: 'FortiGate 3100F', quantity: 2, unitPrice: 5508.75, unitCost: 4590.63 },
      // A worksheet line: the vendor's price and a markup each give the cost straight back.
      { description: 'EDR licence', vendorId: fx.vendor.id, quantity: 100, vendorUnitCost: 42, markupPct: 15 },
    ],
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
    assert.ok(quote.some((p) => p.endsWith('markupPct')) && quote.some((p) => p.endsWith('vendorUnitCost')), 'and the worksheet');
  });
});

/**
 * The other half of the same rule: a figure worked out from a hidden field is that field.
 *
 * Masking hides by name, so a number carrying a hidden figure under a different name walks
 * straight past it — `lineCost` was quantity × a hidden unit cost, and the account preview's
 * `openValue` is a sum of deal amounts. Names are a list somebody has to keep; digits are not.
 * This plants costs nobody would arrive at by accident and looks for those digits anywhere a
 * Sales Executive is served, screens, previews, dashboard and every report they are offered.
 *
 * Only the fields the Roles editor can actually hide are swept (PROTECTED_FIELDS): a role that
 * hides something else is not a thing an administrator can make.
 */
describe('a figure worked out from a hidden field is hidden with it', () => {
  const UNIT_COST = 4590.63;
  const LINE_COST = 9181.26;      // quantity 2 × the unit cost, and the deal's cost
  const VENDOR_COST = 42;         // the worksheet line's vendor price

  it('on every screen, preview and report a Sales Executive is offered', async () => {
    const { deal, quoteId, invoiceId, product } = await costedPaperwork(fx.rep);
    const offered = (await request(app, fx.rep).get('/api/reports')).body as Array<{ key: string }>;

    const screens = [
      '/api/deals', `/api/deals/${deal.id}`,
      '/api/quotes', `/api/quotes/${quoteId}`,
      '/api/invoices', `/api/invoices/${invoiceId}`,
      '/api/products', `/api/products/${product.id}`,
      '/api/accounts', `/api/accounts/${fx.customer.id}`,
      `/api/previews/account/${fx.customer.id}`, `/api/previews/deal/${deal.id}`,
      '/api/dashboard/overview',
      ...offered.map((r) => `/api/reports/${r.key}`),
    ];

    const found: string[] = [];
    for (const url of screens) {
      const res = await request(app, fx.rep).get(url);
      // A report offered to a role has to open for it: the list used to hand over every report
      // there is, and six of them answered "your role cannot see leads".
      assert.equal(res.status, 200, `${url} is offered to this role and must open`);
      const body = JSON.stringify(res.body);
      for (const [what, figure] of [['unit cost', UNIT_COST], ['line cost', LINE_COST], ['the vendor price', VENDOR_COST]] as const) {
        // The vendor price is small enough to turn up as a quantity or a percentage; only count
        // it where it is money, with a decimal part.
        const digits = figure === VENDOR_COST ? `${figure}.` : String(figure);
        if (body.includes(digits)) found.push(`${url} → ${what} (${figure})`);
      }
    }
    assert.deepEqual(found, [], 'a hidden cost came back under another name');
  });

  it('and an administrator is served those same figures, so the sweep is looking where it should', async () => {
    const { quoteId } = await costedPaperwork(fx.rep);
    const quote = JSON.stringify((await request(app, fx.admin).get(`/api/quotes/${quoteId}`)).body);
    assert.ok(quote.includes(String(UNIT_COST)) && quote.includes(String(LINE_COST)), 'the admin reads unit cost and line cost');
  });
});
