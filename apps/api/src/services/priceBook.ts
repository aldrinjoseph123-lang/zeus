import { prisma, num } from '../db.js';
import { round2 } from '../lib/money.js';

/**
 * Vendor price book.
 *
 * What Zeus pays for a SKU is not one number. It changes with quantity, it expires
 * when the vendor's price list does, and a registered opportunity often carries a
 * special price (an SPA) the vendor approved for that deal alone.
 *
 * Rather than three tables arguing about which wins, every price is a PriceEntry with
 * conditions, and this resolver picks the most specific one that applies:
 *
 *   1. a price attached to this deal        — the SPA, and it never leaks to another deal
 *   2. the best standing price for the qty  — highest quantity break at or below it
 *   3. the catalogue cost on the product    — what Zeus did before any of this existed
 *
 * The source comes back with the number so a screen can say where a cost came from.
 * A margin nobody can explain is a margin nobody trusts.
 */

export type PriceSource = 'special' | 'price-book' | 'catalogue' | 'none';

export interface ResolvedPrice {
  cost: number;
  source: PriceSource;
  /** Human sentence for the UI — "Special price on ZEU-D-000042". */
  reason: string;
  currency: string;
  vendorSku: string | null;
  /** The vendor's list price when known, so a discount can be shown. */
  listPrice: number | null;
  entryId: string | null;
  validTo: Date | null;
}

export interface PriceQuery {
  productId: string;
  quantity?: number;
  /** Scopes the lookup to a deal so its special price is found. */
  dealId?: string | null;
  /** Prefer a particular vendor when the SKU is available from more than one. */
  vendorId?: string | null;
  /** Date the price has to be valid on. Defaults to today. */
  on?: Date;
}

/**
 * True when the entry is live on the given date. Entries with no dates are open-ended,
 * which is how most vendor lists actually behave between refreshes.
 */
function validOn(entry: { validFrom: Date | null; validTo: Date | null; isActive: boolean }, on: Date): boolean {
  if (!entry.isActive) return false;
  if (entry.validFrom && entry.validFrom > on) return false;
  if (entry.validTo && entry.validTo < on) return false;
  return true;
}

export async function resolvePrice(query: PriceQuery): Promise<ResolvedPrice> {
  const quantity = query.quantity && query.quantity > 0 ? query.quantity : 1;
  const on = query.on ?? new Date();

  const [product, entries] = await Promise.all([
    prisma.product.findUnique({
      where: { id: query.productId },
      select: { cost: true, currency: true, sku: true },
    }),
    prisma.priceEntry.findMany({
      where: {
        productId: query.productId,
        // Standing prices, plus any special price for this deal — never another deal's.
        OR: [{ dealId: null }, ...(query.dealId ? [{ dealId: query.dealId }] : [])],
      },
      include: { deal: { select: { reference: true } }, vendor: { select: { name: true } } },
    }),
  ]);

  const usable = entries.filter((entry) => validOn(entry, on) && num(entry.minQuantity) <= quantity);

  // A vendor preference narrows the field, but only if it leaves something usable —
  // a quote should not lose its cost because the preferred vendor has no list loaded.
  const scoped = query.vendorId
    ? (usable.filter((e) => e.vendorId === query.vendorId).length ? usable.filter((e) => e.vendorId === query.vendorId) : usable)
    : usable;

  const special = scoped.filter((e) => e.dealId);
  const standing = scoped.filter((e) => !e.dealId);

  /** Best = the highest quantity break that applies, then the cheapest. */
  const best = (list: typeof scoped) =>
    [...list].sort((a, b) => num(b.minQuantity) - num(a.minQuantity) || num(a.cost) - num(b.cost))[0];

  const chosen = best(special) ?? best(standing);

  if (chosen) {
    const isSpecial = Boolean(chosen.dealId);
    return {
      cost: round2(num(chosen.cost)),
      source: isSpecial ? 'special' : 'price-book',
      reason: isSpecial
        ? `Special price approved on ${chosen.deal?.reference ?? 'this deal'}`
        : `${chosen.vendor?.name ?? 'Price book'}${num(chosen.minQuantity) > 1 ? ` from ${num(chosen.minQuantity)} units` : ''}`,
      currency: chosen.currency,
      vendorSku: chosen.vendorSku,
      listPrice: chosen.listPrice === null ? null : round2(num(chosen.listPrice)),
      entryId: chosen.id,
      validTo: chosen.validTo,
    };
  }

  if (product && num(product.cost) > 0) {
    return {
      cost: round2(num(product.cost)),
      source: 'catalogue',
      reason: 'Catalogue cost — no vendor price loaded for this SKU',
      currency: product.currency,
      vendorSku: null,
      listPrice: null,
      entryId: null,
      validTo: null,
    };
  }

  return {
    cost: 0,
    source: 'none',
    reason: 'No cost on file — margin cannot be trusted until one is added',
    currency: 'AED',
    vendorSku: null,
    listPrice: null,
    entryId: null,
    validTo: null,
  };
}

/** Resolve several lines in one round trip, for a whole quote or PO. */
export async function resolvePrices(
  lines: Array<{ productId?: string | null; quantity?: number }>,
  context: { dealId?: string | null; vendorId?: string | null } = {},
): Promise<Array<ResolvedPrice | null>> {
  return Promise.all(
    lines.map((line) =>
      line.productId
        ? resolvePrice({ productId: line.productId, quantity: line.quantity, ...context })
        : Promise.resolve(null),
    ),
  );
}
