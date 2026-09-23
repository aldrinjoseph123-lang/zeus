import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyVat, convert, lineTotals, round2, stripVat, taxDocumentTotals, worksheetPrice } from '../lib/money.js';

/**
 * Money maths, by property rather than by example. The examples elsewhere pin the figures
 * the business knows; these say what must hold for *any* figure — a total is its lines
 * added up, a fils is never invented or lost, a round trip comes back. Plain node:test with
 * a seeded generator: no dependency, and a failure prints the seed that finds it again.
 */
const SEED = Number(process.env.PROPERTY_SEED ?? Date.now() % 1_000_000);
let state = SEED || 1;
const random = () => { // mulberry32
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
const money = (max = 1_000_000) => int(0, max * 100) / 100;
const fils = (v: number) => Math.round(v * 100);
const times = (n: number, body: (i: number) => void) => { for (let i = 0; i < n; i++) body(i); };
const line = () => ({
  quantity: random() < 0.8 ? int(1, 500) : int(1, 40) / 2,
  unitPrice: money(50_000),
  unitCost: money(40_000),
  discountPct: random() < 0.5 ? 0 : int(0, 200) / 2,
  taxable: random() < 0.85,
  vatRate: random() < 0.9 ? 5 : int(0, 40) / 2,
});
const because = (what: string) => `${what} (PROPERTY_SEED=${SEED})`;

describe('round2', () => {
  it('lands on a fils, stays there, and never moves more than half a fils', () => {
    times(5000, () => {
      const x = (random() - 0.5) * 2_000_000;
      const r = round2(x);
      assert.equal(fils(r) / 100, r, because(`${x} rounded to ${r}, which is not on a fils`));
      assert.equal(round2(r), r, because(`rounding ${r} again moved it`));
      assert.ok(Math.abs(r - x) <= 0.005 + 1e-9, because(`${x} rounded to ${r}`));
    });
  });

  it('rounds a half fils away from zero, the FTA convention, whatever the binary error', () => {
    times(5000, () => {
      const k = int(0, 10_000_000);
      const sign = random() < 0.5 ? 1 : -1;
      assert.equal(round2(sign * (k / 100 + 0.005)), sign * ((k + 1) / 100), because(`${sign * (k / 100 + 0.005)}`));
    });
  });

  it('keeps order: a bigger amount never rounds to a smaller one', () => {
    times(5000, () => {
      const a = (random() - 0.5) * 2_000_000;
      const b = a + random() * 10;
      assert.ok(round2(a) <= round2(b), because(`round2(${a}) > round2(${b})`));
    });
  });
});

describe('a line', () => {
  it('is worth its gross less its discount, and no discount means the gross exactly', () => {
    times(3000, () => {
      const l = line();
      const gross = round2(l.quantity * l.unitPrice);
      const { lineTotal, lineCost } = lineTotals(l);
      assert.ok(lineTotal <= gross + 1e-9 && lineTotal >= 0, because(JSON.stringify(l)));
      assert.equal(lineTotals({ ...l, discountPct: 0 }).lineTotal, gross, because(JSON.stringify(l)));
      assert.equal(lineTotals({ ...l, discountPct: 100 }).lineTotal, 0, because(JSON.stringify(l)));
      assert.equal(lineCost, round2(l.quantity * l.unitCost), because(JSON.stringify(l)));
    });
  });
});

describe('a tax document', () => {
  it('is its lines added up: subtotal, VAT, the VAT return by rate, cost and margin', () => {
    times(1500, () => {
      const lines = Array.from({ length: int(1, 12) }, line);
      const headerDiscountPct = random() < 0.5 ? 0 : int(0, 100) / 2;
      const t = taxDocumentTotals(lines, { headerDiscountPct });
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const ctx = because(JSON.stringify({ lines, headerDiscountPct }));

      assert.equal(t.subtotal, round2(sum(t.lines.map((l) => l.lineTotal))), ctx);
      assert.equal(t.vatAmount, round2(sum(t.lines.map((l) => l.lineVat))), ctx);
      assert.equal(t.totalCost, round2(sum(t.lines.map((l) => l.lineCost))), ctx);
      assert.equal(t.total, round2(t.netAfterDiscount + t.vatAmount), ctx);
      assert.equal(t.netAfterDiscount, round2(t.subtotal - t.discountAmt), ctx);
      assert.equal(t.marginAmount, round2(t.netAfterDiscount - t.totalCost), ctx);
      // What goes on the return must be what went on the invoice.
      assert.equal(round2(sum(t.byRate.map((b) => b.vatAmount))), t.vatAmount, ctx);
      lines.forEach((l, i) => { if (!l.taxable) assert.equal(t.lines[i].lineVat, 0, ctx); });
      if (headerDiscountPct === 0) assert.equal(round2(sum(t.byRate.map((b) => b.taxableAmount))), t.subtotal, ctx);
    });
  });
});

describe('VAT on a bare amount', () => {
  it('adds up, strips back off, and a round trip loses at most a fils', () => {
    times(3000, () => {
      const net = money();
      const rate = random() < 0.8 ? 5 : int(0, 40) / 2;
      const added = applyVat(net, rate);
      assert.equal(added.total, round2(net + added.vatAmount), because(`${net} at ${rate}%`));
      assert.ok(Math.abs(added.vatAmount - net * rate / 100) <= 0.005 + 1e-9, because(`${net} at ${rate}%`));
      const stripped = stripVat(added.total, rate);
      assert.equal(round2(stripped.net + stripped.vatAmount), added.total, because(`${added.total} at ${rate}%`));
      assert.ok(Math.abs(stripped.net - net) <= 0.01 + 1e-9, because(`${net} at ${rate}% came back as ${stripped.net}`));
    });
  });
});

describe('the worksheet and currency', () => {
  it('never sells below cost at a markup of zero or more, and a conversion comes back', () => {
    times(3000, () => {
      const vendorUnitCost = money(100_000);
      const fxRate = random() < 0.5 ? 3.6725 : int(1, 60_000) / 10_000;
      const markupPct = random() < 0.1 ? null : int(0, 4000) / 10;
      const priced = worksheetPrice({ vendorUnitCost, fxRate, markupPct });
      const ctx = because(JSON.stringify({ vendorUnitCost, fxRate, markupPct }));
      assert.equal(priced.unitCost, round2(vendorUnitCost * fxRate), ctx);
      if (markupPct === null) assert.equal(priced.unitPrice, null, ctx);
      else assert.ok(priced.unitPrice! >= priced.unitCost, ctx);

      const rates = { USD: 3.6725, EUR: int(38_000, 42_000) / 10_000 };
      const usd = money(10_000);
      const there = convert(usd, 'USD', 'AED', rates);
      const back = convert(there.amount, 'AED', 'USD', rates);
      assert.ok(Math.abs(back.amount - usd) <= 0.01 + 1e-9, because(`${usd} USD went to ${there.amount} AED and back to ${back.amount}`));
      assert.deepEqual(convert(usd, 'GBP', 'AED', rates), { amount: round2(usd), rate: null }, 'an unknown currency is unknown, not one-to-one');
      assert.deepEqual(convert(usd, 'USD', 'USD', rates), { amount: round2(usd), rate: 1 });
    });
  });
});
