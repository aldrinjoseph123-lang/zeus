import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';
import { round2 } from '../lib/money.js';

/**
 * The quote worksheet as Excel.
 *
 * The version with formulas is only worth having if it is Zeus's arithmetic and not an
 * approximation of it: a manager who opens it and changes nothing must see the approved
 * figures, and one who changes a markup must see what Zeus would have priced. No spreadsheet
 * engine is installed here, so these tests evaluate the workbook's formulas themselves.
 * The grammar is small on purpose: ROUND, IF, SUM over a column, and arithmetic.
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

/** The design's worksheet, submitted and signed off. */
async function approvedDesignQuote() {
  const created = await request(app, fx.admin).post('/api/quotes', {
    accountId: fx.customer.id, defaultMarkupPct: 20,
    lines: [
      { description: 'FortiGate 3100F', vendorId: fx.vendor.id, vendorCode: 'FG-3100', quantity: 2, vendorCurrency: 'USD', vendorUnitCost: 1250, fxRate: 3.6725 },
      { description: 'EDR licence, per endpoint', quantity: 100, vendorUnitCost: 42, markupPct: 15 },
      { description: 'Installation & commissioning', isInternal: true, quantity: 1, vendorUnitCost: 3500, markupPct: 30 },
    ],
  });
  assert.equal(created.status, 201);
  const id = (created.body as { id: string }).id;
  assert.equal((await request(app, fx.admin).post(`/api/approvals/quotes/${id}/submit`, {})).status, 200);
  assert.equal((await request(app, fx.manager).post(`/api/approvals/quotes/${id}/approve`, {})).status, 200);
  return prisma.quote.findUniqueOrThrow({ where: { id } });
}

async function workbook(res: { status: number; body: unknown; raw: { rawPayload: Buffer } }) {
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.raw.rawPayload as never);
  return wb.worksheets[0];
}

/**
 * Evaluate a cell the way a spreadsheet would. `overrides` stands in for someone typing a new
 * value into an input cell.
 */
function evaluator(ws: ExcelJS.Worksheet, overrides: Record<string, number> = {}) {
  const memo = new Map<string, unknown>();
  const cell = (raw: string): unknown => {
    const ref = raw.replace(/\$/g, '');
    if (ref in overrides) return overrides[ref];
    if (memo.has(ref)) return memo.get(ref);
    const v = ws.getCell(ref).value as unknown;
    let out: unknown = v ?? 0;
    if (v && typeof v === 'object' && 'formula' in v) {
      const js = (v as { formula: string }).formula
        .replace(/SUM\(([A-Z]+)(\d+):\1(\d+)\)/g, (_m, col: string, a: string, b: string) =>
          `(${Array.from({ length: Number(b) - Number(a) + 1 }, (_x, i) => `${col}${Number(a) + i}`).join('+')})`)
        .replace(/\$/g, '')
        .replace(/\b([A-Z]{1,2}\d+)\b/g, 'v("$1")')
        .replace(/ROUND\(/g, 'R(').replace(/IF\(/g, 'IFF(')
        .replace(/([^<>=!])=([^=])/g, '$1===$2');
      out = new Function('v', 'R', 'IFF', `return ${js};`)(
        cell,
        (x: number) => round2(x),
        (c: boolean, a: unknown, b: unknown) => (c ? a : b),
      );
    }
    memo.set(ref, out);
    return out;
  };
  return cell;
}

const get = (id: string, as = fx.admin, formulas = false) =>
  request(app, as).get(`/api/quotes/${id}/worksheet.xlsx${formulas ? '?formulas=true' : ''}`);

describe('who gets the worksheet', () => {
  it('not before a manager has approved the quote', async () => {
    const created = await request(app, fx.admin).post('/api/quotes', {
      accountId: fx.customer.id, lines: [{ description: 'Draft', quantity: 1, vendorUnitCost: 100, markupPct: 20 }],
    });
    const res = await get((created.body as { id: string }).id);
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /approved/);
  });

  it('never a role that cannot see cost', async () => {
    const quote = await approvedDesignQuote();
    await prisma.quote.update({ where: { id: quote.id }, data: { preparedById: fx.rep.id } });
    assert.equal((await get(quote.id, fx.rep)).status, 403);
  });

  it('the formulas only to a role that approves quotes', async () => {
    const quote = await approvedDesignQuote();
    const manager = await prisma.user.findUniqueOrThrow({ where: { id: fx.manager.id }, include: { role: true } });
    const perms = manager.role.permissions as Record<string, Record<string, unknown>>;
    await prisma.role.update({ where: { id: manager.roleId }, data: { permissions: { ...perms, quotes: { ...perms.quotes, approve: false } } as never } });
    const { clearSessionCache } = await import('../auth/sessionStore.js');
    clearSessionCache();

    assert.equal((await get(quote.id, fx.manager)).status, 200, 'the values are theirs to take');
    assert.equal((await get(quote.id, fx.manager, true)).status, 403, 'the formulas are not');
  });

  it('writes down who took it', async () => {
    const quote = await approvedDesignQuote();
    await get(quote.id, fx.admin, true);
    const logged = await prisma.auditLog.findFirst({ where: { entity: 'Quote', entityId: quote.id, action: 'export' } });
    assert.match(logged?.summary ?? '', /with formulas/);
  });
});

describe('what is in it', () => {
  it('the values version holds the approved figures and no formulas', async () => {
    const quote = await approvedDesignQuote();
    const ws = await workbook(await get(quote.id));

    assert.equal(ws.getCell('J7').value, 5508.75);
    assert.equal(ws.getCell('K7').value, 11017.5);
    assert.equal(ws.getCell('A9').value, 'Internal');
    assert.equal(ws.getCell('K10').value, 20397.5, 'the total sell');
    assert.equal(ws.getCell('L10').value, 16881.26, 'the total cost');
    ws.eachRow((row) => row.eachCell((c) => assert.ok(!(c.value && typeof c.value === 'object' && 'formula' in c.value), `${c.address} is a formula`)));
    assert.match(String(ws.getCell('A2').value), /Not for customers or vendors/);
  });

  it('the formulas version recalculates to exactly what Zeus stored', async () => {
    const quote = await approvedDesignQuote();
    const ws = await workbook(await get(quote.id, fx.admin, true));
    const v = evaluator(ws);

    assert.ok(typeof ws.getCell('J7').value === 'object', 'the sell price is a formula, not a typed number');
    // Every formula agrees with the figure it carries as its cached result.
    ws.eachRow((row) => row.eachCell((c) => {
      const val = c.value as { formula?: string; result?: unknown } | null;
      if (!val || typeof val !== 'object' || !val.formula) return;
      const got = v(c.address);
      // A cached zero is dropped when the file is written, which is why it recalculates on open.
      if (typeof got === 'number') assert.ok(Math.abs(got - Number(val.result ?? 0)) < 1e-9, `${c.address}: ${val.formula} gives ${got}, stored ${val.result}`);
    }));

    // And the bottom lines are the quote's own.
    const summary = (label: string) => {
      let ref = '';
      ws.eachRow((row, r) => { if (row.getCell('J').value === label) ref = `K${r}`; });
      return v(ref);
    };
    assert.equal(summary('Subtotal'), Number(quote.subtotal));
    assert.equal(summary('VAT'), Number(quote.vatAmount));
    assert.equal(summary('Total'), Number(quote.total));
    assert.equal(summary('Margin'), Number(quote.marginAmount));
  });

  it('changing the default markup in Excel moves only the lines that use it', async () => {
    const quote = await approvedDesignQuote();
    const ws = await workbook(await get(quote.id, fx.admin, true));
    const v = evaluator(ws, { E4: 0.25 });

    assert.equal(v('J7'), 5738.28, 'FortiGate is on the default — the same figure Zeus gives for 25%');
    assert.equal(v('J8'), 48.3, 'EDR has its own 15%');
    assert.equal(v('K10'), round2(11476.56 + 4830 + 4550));
  });
});
