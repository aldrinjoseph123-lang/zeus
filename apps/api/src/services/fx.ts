import { prisma } from '../db.js';
import { getSetting, setSetting } from '../lib/settings.js';

/**
 * Exchange rates, fetched rather than typed.
 *
 * Zeus buys in dollars and invoices in dirhams, so a rate is needed to put a vendor's
 * price on a quote. Keeping it current by hand is the kind of chore that gets skipped
 * until a margin looks wrong, so it is pulled from a public rates feed daily.
 *
 * Worth knowing: the dirham is pegged to the dollar at 3.6725 and has been since 1997,
 * so the fetched USD figure is expected to be the same number every day. The fetch earns
 * its keep for any currency that does move, and for the case where the peg is ever
 * revised — it does not make the USD rate more accurate than the constant it replaces.
 *
 * Three rules, because a wrong rate is worse than a stale one:
 *   - a fetch that fails leaves the stored rate alone
 *   - a response that does not parse is discarded, not partially applied
 *   - a rate that moves more than `MAX_DRIFT` from the stored one is refused, because a
 *     feed that starts quoting the other way round (0.272 rather than 3.6725) would
 *     otherwise sail through as a plausible number
 */

/** Rates are quoted as base-currency units per one unit of the foreign currency. */
export type Rates = Record<string, number>;

export interface FxResult {
  ok: boolean;
  rates: Rates;
  /** Currencies whose rate was updated. */
  updated: string[];
  /** Currency -> why it was left alone. */
  skipped: Record<string, string>;
  fetchedAt: string | null;
}

/** A rate this far from the stored one is treated as a feed fault, not a market move. */
const MAX_DRIFT = 0.25;
const TIMEOUT_MS = 8_000;

/**
 * Which currencies Zeus needs a rate for: the ones its own price book and catalogue are
 * actually denominated in. Nothing to configure, and no list of forty currencies nobody
 * trades in — Protect24x7 buys in dollars and sells in dirhams.
 */
export async function currenciesInUse(base: string): Promise<string[]> {
  const [entries, products] = await Promise.all([
    prisma.priceEntry.findMany({ where: { isActive: true }, select: { currency: true }, distinct: ['currency'] }),
    prisma.product.findMany({ where: { isActive: true }, select: { currency: true }, distinct: ['currency'] }),
  ]);

  const codes = new Set<string>();
  for (const row of [...entries, ...products]) {
    if (row.currency && row.currency !== base) codes.add(row.currency);
  }
  // USD is always worth holding: it is what vendors quote, even before a price is loaded.
  if (base !== 'USD') codes.add('USD');
  return [...codes].sort();
}

/** One currency, from the configured feed. Returns null rather than throwing. */
async function fetchRate(from: string, base: string, template: string): Promise<number | null> {
  const url = template.replace('{from}', encodeURIComponent(from)).replace('{base}', encodeURIComponent(base));
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      console.warn(`[fx] ${from}: feed answered ${response.status}`);
      return null;
    }

    const body = (await response.json()) as { rates?: Record<string, unknown> };
    const value = Number(body?.rates?.[base]);
    if (!Number.isFinite(value) || value <= 0) {
      console.warn(`[fx] ${from}: feed carried no usable ${base} rate`);
      return null;
    }
    return value;
  } catch (err) {
    console.warn(`[fx] ${from}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Refresh the stored rates. Safe to call at boot and on a schedule; it writes nothing
 * when the feed has nothing good to say.
 */
export async function refreshRates(): Promise<FxResult> {
  const [base, template, stored] = await Promise.all([
    getSetting<string>('finance.currency', 'AED'),
    getSetting<string>('finance.exchangeRateApi', ''),
    getSetting<Rates>('finance.exchangeRates', {}),
  ]);

  const rates: Rates = { ...stored };
  const updated: string[] = [];
  const skipped: Record<string, string> = {};

  if (!template) {
    return { ok: false, rates, updated, skipped: { all: 'No rates feed is configured.' }, fetchedAt: null };
  }

  for (const currency of await currenciesInUse(String(base))) {
    const fetched = await fetchRate(currency, String(base), String(template));
    if (fetched === null) {
      skipped[currency] = 'The feed could not be reached, so the stored rate stands.';
      continue;
    }

    const previous = Number(stored[currency]);
    if (Number.isFinite(previous) && previous > 0) {
      const drift = Math.abs(fetched - previous) / previous;
      if (drift > MAX_DRIFT) {
        // Refusing here is the point: a silently inverted rate would misprice everything.
        skipped[currency] = `Refused ${fetched} — ${(drift * 100).toFixed(0)}% away from ${previous}, which looks like a feed fault rather than a market move. Check it by hand.`;
        console.warn(`[fx] ${currency}: ${skipped[currency]}`);
        continue;
      }
    }

    rates[currency] = fetched;
    updated.push(currency);
  }

  const fetchedAt = new Date().toISOString();
  if (updated.length > 0) {
    await setSetting('finance.exchangeRates', rates, 'finance');
    await setSetting('finance.exchangeRatesUpdatedAt', fetchedAt, 'finance');
  }

  return { ok: updated.length > 0, rates, updated, skipped, fetchedAt: updated.length > 0 ? fetchedAt : null };
}

/** True when the stored rates are older than the given hours, or were never fetched. */
export async function ratesAreStale(hours = 24): Promise<boolean> {
  const updatedAt = await getSetting<string>('finance.exchangeRatesUpdatedAt', '');
  if (!updatedAt) return true;
  const when = new Date(String(updatedAt)).getTime();
  return !Number.isFinite(when) || Date.now() - when > hours * 3_600_000;
}
