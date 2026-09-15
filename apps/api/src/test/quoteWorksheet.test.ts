import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * The quote worksheet: vendor cost in, markup on cost, sell price out.
 *
 * The figures are the ones in the settled design (artifact c31f690c), worked by hand
 * before a line of this existed — two vendors, two currencies and an internal line.
 * If the arithmetic changes, this is where it has to be argued with.
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

interface Line {
  id: string; description: string; quantity: string; unitCost: string; unitPrice: string; lineTotal: string; lineCost: string;
  discountPct: string; markupPct: string | null; vendorUnitCost: string | null; vendorId: string | null;
  productId: string | null; priceFromWorksheet: boolean;
}
interface Quote { id: string; subtotal: string; totalCost: string; marginAmount: string; defaultMarkupPct: string | null; lines: Line[] }

/** The design's worksheet. FortiGate takes the quote's 20% default; the other two set their own. */
const designLines = () => [
  { description: 'FortiGate 3100F', vendorId: fx.vendor.id, vendorCode: 'FG-3100', quantity: 2, vendorCurrency: 'USD', vendorUnitCost: 1250, fxRate: 3.6725 },
  { description: 'EDR licence, per endpoint', vendorCode: 'LIC-EDR-100', quantity: 100, vendorUnitCost: 42, markupPct: 15 },
  { description: 'Installation & commissioning', isInternal: true, quantity: 1, unit: 'project', vendorUnitCost: 3500, markupPct: 30 },
];

async function designQuote(over: Record<string, unknown> = {}) {
  const res = await request(app, fx.admin).post('/api/quotes', {
    accountId: fx.customer.id, defaultMarkupPct: 20, lines: designLines(), ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 200));
  return res.body as Quote;
}

const read = async (id: string, as = fx.admin) => (await request(app, as).get(`/api/quotes/${id}`)).body as Quote;
const money = (v: unknown) => Number(v);

describe('the arithmetic', () => {
  it('prices the design worksheet to the fil', async () => {
    const quote = await read((await designQuote()).id);
    const [forti, edr, install] = quote.lines;

    assert.equal(money(forti.unitCost), 4590.63, '1,250 USD at 3.6725');
    assert.equal(money(forti.unitPrice), 5508.75, 'marked up from the unrounded 4,590.625, not from 4,590.63');
    assert.equal(money(forti.lineTotal), 11017.5);
    assert.equal(money(edr.unitPrice), 48.3);
    assert.equal(money(install.unitPrice), 4550);

    assert.equal(money(quote.subtotal), 20397.5);
    assert.equal(money(quote.totalCost), 16881.26);
    const marginPct = (money(quote.marginAmount) / money(quote.subtotal)) * 100;
    assert.equal(marginPct.toFixed(1), '17.2', 'margin on sell, which is what the approval floor reads');
  });

  it('the price a client sends for a marked-up line is not the price stored', async () => {
    const res = await request(app, fx.admin).post('/api/quotes', {
      accountId: fx.customer.id,
      lines: [{ description: 'FortiGate', quantity: 1, vendorUnitCost: 1250, fxRate: 3.6725, markupPct: 20, unitPrice: 1, unitCost: 1, discountPct: 50 }],
    });
    const line = (await read((res.body as Quote).id)).lines[0];
    assert.equal(money(line.unitPrice), 5508.75);
    assert.equal(money(line.discountPct), 0, 'markup is the one lever on a worksheet line');
  });

  it('a vendor cost with no markup anywhere keeps the price that was typed', async () => {
    const res = await request(app, fx.admin).post('/api/quotes', {
      accountId: fx.customer.id,
      lines: [{ description: 'Priced by hand', quantity: 1, vendorUnitCost: 100, fxRate: 3.6725, unitPrice: 400 }],
    });
    const line = (await read((res.body as Quote).id)).lines[0];
    assert.equal(money(line.unitCost), 367.25, 'the cost still comes from the vendor price');
    assert.equal(money(line.unitPrice), 400);
    assert.equal(line.priceFromWorksheet, false);
  });

  it('changing the default markup reprices the lines that use it, and only those', async () => {
    const quote = await designQuote();
    const res = await request(app, fx.admin).patch(`/api/quotes/${quote.id}`, { defaultMarkupPct: 25 });
    assert.equal(res.status, 200);

    const [forti, edr] = (await read(quote.id)).lines;
    assert.equal(money(forti.unitPrice), 5738.28, '4,590.625 × 1.25 — no lines were sent, and it still moved');
    assert.equal(money(edr.unitPrice), 48.3, 'a line with its own markup ignores the default');
  });
});

describe('who can touch it', () => {
  it('a rep saving the quote can neither change the worksheet nor wipe it', async () => {
    const quote = await designQuote();
    await prisma.quote.update({ where: { id: quote.id }, data: { preparedById: fx.rep.id } });
    const asRep = await read(quote.id, fx.rep);

    assert.ok(asRep.lines.every((l) => !('vendorUnitCost' in (l as object)) && !('markupPct' in (l as object))), 'the rep never receives it');
    assert.ok(!('defaultMarkupPct' in (asRep as object)));
    assert.equal(asRep.lines[0].priceFromWorksheet, true, 'but is told the price is not theirs to type');

    // What the editor sends back: its own view of the lines, one description reworded, plus
    // an attempt at the fields it cannot see.
    const res = await request(app, fx.rep).patch(`/api/quotes/${quote.id}`, {
      defaultMarkupPct: 90,
      lines: asRep.lines.map((l, i) => ({
        id: l.id, description: i === 0 ? 'FortiGate 3100F, 2 units' : l.description,
        quantity: Number(l.quantity),
        unitPrice: 1, unitCost: 0, markupPct: 90, vendorUnitCost: 1,
      })),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));

    const after = await read(quote.id);
    assert.equal(money(after.defaultMarkupPct), 20);
    assert.equal(after.lines[0].description, 'FortiGate 3100F, 2 units', 'the edit they were allowed still landed');
    assert.equal(money(after.lines[0].vendorUnitCost), 1250);
    assert.equal(after.lines[0].vendorId, fx.vendor.id);
    assert.equal(money(after.lines[1].markupPct), 15);
    assert.equal(money(after.subtotal), 20397.5, 'and the manager\'s prices stand');
  });
});

describe('what it touches', () => {
  it('a vendor code matching a catalogue SKU links the product; one that does not is left alone', async () => {
    const product = await prisma.product.create({ data: { sku: 'fg-3100', name: 'FortiGate 3100F', vendorId: fx.vendor.id } });
    const [forti, edr] = (await read((await designQuote()).id)).lines;
    assert.equal(forti.productId, product.id, 'matched regardless of case');
    assert.equal(edr.productId, null);
  });

  it('a new version carries the worksheet, not just its results', async () => {
    const quote = await designQuote();
    const revised = await request(app, fx.admin).post(`/api/quotes/${quote.id}/revise`, {});
    assert.equal(revised.status, 201);
    const v2 = await read((revised.body as Quote).id);
    assert.equal(money(v2.defaultMarkupPct), 20);
    assert.equal(money(v2.lines[0].vendorUnitCost), 1250);
    assert.equal(money(v2.lines[1].markupPct), 15);
    assert.equal(money(v2.subtotal), 20397.5);
  });

  it('undoing an edit brings the vendor back with the lines', async () => {
    const quote = await designQuote();
    await request(app, fx.admin).patch(`/api/quotes/${quote.id}`, { lines: [{ description: 'Replaced', quantity: 1, unitPrice: 10 }] });
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'Quote', entityId: quote.id, action: 'update' }, orderBy: { at: 'desc' } });
    assert.equal((await request(app, fx.admin).post(`/api/undo/${entry.id}`)).status, 200);

    const restored = await read(quote.id);
    assert.equal(restored.lines.length, 3);
    assert.equal(restored.lines[0].vendorId, fx.vendor.id, 'undo used to drop every *Id it did not recognise');
    assert.equal(money(restored.subtotal), 20397.5);
  });
});
