/**
 * AED money maths. Everything runs through fils (1/100 AED) integers so we never
 * ship a 0.1 + 0.2 rounding bug onto a customer quote.
 */

/** Round half-up to 2 decimals, the convention UAE FTA invoices use. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const shifted = value * 100;
  // Nudge past binary representation error before rounding (e.g. 1.005*100 = 100.49999...).
  const corrected = Math.round((shifted + Number.EPSILON * Math.sign(shifted) * Math.abs(shifted)) * 1e6) / 1e6;
  return Math.sign(corrected) * Math.round(Math.abs(corrected)) / 100;
}

export interface LineInput {
  quantity: number;
  unitPrice: number;
  unitCost?: number;
  discountPct?: number;
  taxable?: boolean;
}

export interface LineTotals {
  lineTotal: number;
  lineCost: number;
}

/** Per-line net after the line discount. */
export function lineTotals(line: LineInput): LineTotals {
  const gross = round2(line.quantity * line.unitPrice);
  const discount = round2(gross * ((line.discountPct ?? 0) / 100));
  return {
    lineTotal: round2(gross - discount),
    lineCost: round2(line.quantity * (line.unitCost ?? 0)),
  };
}

export interface TaxLineInput extends LineInput {
  /** Each line carries its own rate — the FTA requires the rate to show per line. */
  vatRate?: number;
}

export interface TaxLineTotals {
  lineTotal: number;
  lineVat: number;
  lineCost: number;
}

export interface TaxDocumentTotals {
  subtotal: number;
  discountAmt: number;
  netAfterDiscount: number;
  vatAmount: number;
  total: number;
  totalCost: number;
  marginAmount: number;
  marginPct: number;
  lines: TaxLineTotals[];
  /** VAT broken out by rate — what a filed return actually needs. */
  byRate: Array<{ rate: number; taxableAmount: number; vatAmount: number }>;
}

/**
 * Tax-document totals with per-line VAT.
 *
 * A header discount is spread across the lines in proportion before tax, so a mixed
 * document — standard-rated services next to a zero-rated export — still charges VAT
 * on exactly the right base. Tax is computed and rounded per line, then summed, which
 * is what makes the printed line tax add up to the invoice tax.
 */
export function taxDocumentTotals(
  lines: TaxLineInput[],
  opts: { headerDiscountPct?: number; defaultVatRate?: number } = {},
): TaxDocumentTotals {
  const headerDiscountPct = opts.headerDiscountPct ?? 0;
  const defaultRate = opts.defaultVatRate ?? 5;
  const factor = 1 - headerDiscountPct / 100;

  let subtotal = 0;
  let totalCost = 0;
  let vatAmount = 0;
  const computed: TaxLineTotals[] = [];
  const rateBuckets = new Map<number, { taxableAmount: number; vatAmount: number }>();

  for (const line of lines) {
    const { lineTotal, lineCost: cost } = lineTotals(line);
    const taxable = line.taxable !== false;
    const rate = taxable ? (line.vatRate ?? defaultRate) : 0;

    // The discounted base this line is actually taxed on.
    const taxableBase = round2(lineTotal * factor);
    const lineVat = taxable ? round2(taxableBase * (rate / 100)) : 0;

    subtotal = round2(subtotal + lineTotal);
    totalCost = round2(totalCost + cost);
    vatAmount = round2(vatAmount + lineVat);
    computed.push({ lineTotal, lineVat, lineCost: cost });

    const bucket = rateBuckets.get(rate) ?? { taxableAmount: 0, vatAmount: 0 };
    bucket.taxableAmount = round2(bucket.taxableAmount + taxableBase);
    bucket.vatAmount = round2(bucket.vatAmount + lineVat);
    rateBuckets.set(rate, bucket);
  }

  const discountAmt = round2(subtotal * (headerDiscountPct / 100));
  const netAfterDiscount = round2(subtotal - discountAmt);
  const marginAmount = round2(netAfterDiscount - totalCost);

  return {
    subtotal,
    discountAmt,
    netAfterDiscount,
    vatAmount,
    total: round2(netAfterDiscount + vatAmount),
    totalCost,
    marginAmount,
    marginPct: netAfterDiscount === 0 ? 0 : round2((marginAmount / netAfterDiscount) * 100),
    lines: computed,
    byRate: [...rateBuckets.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([rate, v]) => ({ rate, ...v })),
  };
}

/** Net -> {vat, gross} for a bare deal amount that has no quote lines yet. */
export function applyVat(net: number, vatRate = 5): { vatAmount: number; total: number } {
  const vatAmount = round2(net * (vatRate / 100));
  return { vatAmount, total: round2(net + vatAmount) };
}

/** Gross -> net, for when someone types the VAT-inclusive figure off a PO. */
export function stripVat(gross: number, vatRate = 5): { net: number; vatAmount: number } {
  const net = round2(gross / (1 + vatRate / 100));
  return { net, vatAmount: round2(gross - net) };
}

export interface Converted {
  amount: number;
  /** AED per one unit of `from`. 1 when no conversion was needed. */
  rate: number | null;
}

/**
 * Convert between currencies using a table of rates expressed as base-currency units
 * per one unit of the foreign currency (AED 3.6725 to the dollar).
 *
 * A missing rate returns `rate: null` and leaves the amount alone. Callers must treat
 * that as "unknown", never as "no conversion needed" — a USD price silently passed
 * through as dirhams understates the cost by nearly four times, and every margin
 * computed from it is wrong in the direction that loses money.
 */
export function convert(
  amount: number,
  from: string,
  to: string,
  rates: Record<string, number>,
  base = 'AED',
): Converted {
  if (from === to) return { amount: round2(amount), rate: 1 };

  // Every rate in the table is quoted against the base currency, which is itself 1.
  const rateOf = (code: string): number | null => {
    if (code === base) return 1;
    const value = Number(rates[code]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const fromRate = rateOf(from);
  const toRate = rateOf(to);
  if (fromRate === null || toRate === null) return { amount: round2(amount), rate: null };

  // USD to EUR goes through the dirham: 3.6725 / 4.0221.
  const rate = fromRate / toRate;
  return { amount: round2(amount * rate), rate };
}

export function formatAed(value: number): string {
  return new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', minimumFractionDigits: 2 }).format(value);
}
