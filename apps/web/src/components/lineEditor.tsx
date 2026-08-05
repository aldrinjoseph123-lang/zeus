import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { money } from '../lib/format';
import { Button, EmptyState, Input, cx, useDebounced } from './ui';
import { Lookup } from './pickers';
import { api, qs } from '../lib/api';

/**
 * Editable line grid shared by the invoice, credit note and purchase order editors.
 * Each line carries its own VAT rate because the FTA requires the tax rate to appear
 * against every line — a zero-rated export can sit beside a standard-rated service on
 * the same document.
 */

/** What the price book answered, including the vendor's own figure before conversion. */
export interface ResolvedCost {
  cost: number;
  source: string;
  reason: string;
  currency: string;
  sourceCost: number;
  sourceCurrency: string;
  rate: number | null;
  rateMissing: boolean;
}

export interface EditableLine {
  key: string;
  productId: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  unitCost?: number;
  /** Where the cost came from — shown under the cost cell so a margin is explainable. */
  costSource?: ResolvedCost | null;
  discountPct: number;
  taxable: boolean;
  vatRate: number;
  termMonths?: number | null;
}

export const blankLine = (defaultVat = 5): EditableLine => ({
  key: crypto.randomUUID(),
  productId: null,
  description: '',
  quantity: 1,
  unit: 'licence',
  unitPrice: 0,
  unitCost: 0,
  discountPct: 0,
  taxable: true,
  vatRate: defaultVat,
});

export function LineEditor({
  lines, onChange, locked = false, showCost = false, priceLabel = 'Unit price', defaultVat = 5,
  costFromCatalog = false, showVat = true, headerDiscountPct = 0, dealId = null, vendorId = null,
  currency = 'AED',
}: {
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
  locked?: boolean;
  showCost?: boolean;
  priceLabel?: string;
  defaultVat?: number;
  /** On a supplier PO the catalog *cost* is what you pay, so it fills the price column. */
  costFromCatalog?: boolean;
  /** Quotes store one rate for the document, so they hide the per-line rate column. */
  showVat?: boolean;
  /** Needed so the line VAT column matches the printed document, which taxes the
   *  discounted base — without it the column sums to more than the invoice total. */
  headerDiscountPct?: number;
  /** Scopes the cost lookup so a special price approved for this deal is found. */
  dealId?: string | null;
  /** Prefers one vendor's price when the same SKU is available from several. */
  vendorId?: string | null;
  /** The document's currency. Vendor prices are converted into it before they land. */
  currency?: string;
}) {
  const update = (key: string, patch: Partial<EditableLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  /**
   * Ask the price book what this line really costs.
   *
   * Typed cost is how margin quietly goes wrong: last year's number, or the list price
   * pasted in by mistake. Resolved *before* the line is written rather than after, so
   * the pick lands as one change — a second write built from pre-pick state would put
   * the old description and price back.
   *
   * Best-effort: if the lookup fails the catalogue cost stands, because a pricing
   * question must never block someone from building a quote.
   */
  const vendorPrice = async (productId: string, quantity: number) => {
    try {
      return await api.get<ResolvedCost>(
        `/price-book/resolve${qs({ productId, quantity, dealId, vendorId, currency })}`,
      );
    } catch {
      // A role without cost access gets a 403 here, and its cost column is hidden anyway.
      return null;
    }
  };

  /**
   * Keep the cost honest when the conditions behind it change.
   *
   * The price a vendor charges depends on quantity and on which deal this is, so a cost
   * resolved at quantity 1 is simply wrong once the line says 800 — and a special price
   * has to disappear the moment the deal it belonged to is unlinked. The document's
   * currency counts too: switching an invoice from AED to USD changes what a dollar
   * price converts to. Only lines whose cost came from the price book are refreshed —
   * typing a cost by hand clears `costSource`, and that is an override worth respecting.
   */
  const conditions = `${dealId ?? ''}|${vendorId ?? ''}|${currency}|${lines.map((l) => `${l.productId ?? ''}:${l.quantity}`).join(',')}`;
  const settled = useDebounced(conditions, 400);

  useEffect(() => {
    if (!showCost || locked) return;
    const targets = lines.filter((line) => line.productId && line.costSource);
    if (targets.length === 0) return;

    let cancelled = false;
    void (async () => {
      const resolved = await Promise.all(targets.map((line) => vendorPrice(line.productId!, line.quantity)));
      if (cancelled) return;

      const byKey = new Map(targets.map((line, i) => [line.key, resolved[i]]));
      let touched = false;
      const next = lines.map((line) => {
        const priced = byKey.get(line.key);
        if (!priced || (priced.cost === line.unitCost && priced.source === line.costSource?.source)) return line;
        touched = true;
        return { ...line, unitCost: priced.cost, costSource: priced };
      });
      if (touched) onChange(next);
    })();

    return () => { cancelled = true; };
    // `conditions` is the whole dependency: it changes exactly when a price could.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, showCost, locked]);

  const lineNet = (line: EditableLine) => {
    const gross = line.quantity * line.unitPrice;
    return gross - gross * (line.discountPct / 100);
  };
  // The server taxes the base *after* the header discount is spread across the lines.
  const lineVat = (line: EditableLine) =>
    line.taxable ? lineNet(line) * (1 - headerDiscountPct / 100) * (line.vatRate / 100) : 0;

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-n950 text-white">
              {['#', 'Description', 'Qty', 'Unit', priceLabel, ...(showCost ? ['Cost'] : []), 'Disc %', ...(showVat ? ['VAT %'] : []), 'VAT', 'Amount', ''].map((header) => (
                <th key={header} className="whitespace-nowrap px-2 py-2 text-left text-[10px] font-bold uppercase tracking-[0.08em]">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key} className={cx('border-b border-line', index % 2 === 1 && 'bg-sunken')}>
                <td className="px-2 py-1.5 text-[11px] text-muted">{index + 1}</td>
                <td className="min-w-[260px] px-2 py-1.5">
                  <CatalogLine
                    line={line}
                    locked={locked}
                    costFromCatalog={costFromCatalog}
                    onPick={async (product) => {
                      // The catalogue cost is only the fallback; the price book knows what
                      // this costs at this quantity, on this deal.
                      const priced = showCost ? await vendorPrice(product.id, line.quantity) : null;
                      update(line.key, {
                        productId: product.id,
                        description: product.name,
                        unit: product.unit,
                        unitPrice: costFromCatalog ? Number(product.cost ?? 0) : Number(product.listPrice),
                        unitCost: priced ? priced.cost : Number(product.cost ?? 0),
                        taxable: product.taxable,
                        vatRate: product.taxable ? defaultVat : 0,
                        costSource: priced,
                      });
                    }}
                    onDescription={(value) => update(line.key, { description: value, productId: null })}
                  />
                </td>
                <td className="px-2 py-1.5">
                  <Input className="w-20 px-2 py-1" type="number" min="0" step="1" value={line.quantity} disabled={locked}
                    onChange={(e) => update(line.key, { quantity: Number(e.target.value) })} />
                </td>
                <td className="px-2 py-1.5">
                  <Input className="w-24 px-2 py-1" value={line.unit} disabled={locked}
                    onChange={(e) => update(line.key, { unit: e.target.value })} />
                </td>
                <td className="px-2 py-1.5">
                  <Input className="w-28 px-2 py-1 text-right" type="number" step="0.01" value={line.unitPrice} disabled={locked}
                    onChange={(e) => update(line.key, { unitPrice: Number(e.target.value) })} />
                </td>
                {showCost ? (
                  <td className="px-2 py-1.5">
                    <Input className="w-28 px-2 py-1 text-right" type="number" min="0" step="0.01" value={line.unitCost ?? 0} disabled={locked}
                      onChange={(e) => update(line.key, { unitCost: Number(e.target.value), costSource: null })} />
                    {line.costSource ? <CostSource source={line.costSource} /> : null}
                  </td>
                ) : null}
                <td className="px-2 py-1.5">
                  <Input className="w-20 px-2 py-1 text-right" type="number" min="0" max="100" step="0.5" value={line.discountPct} disabled={locked}
                    onChange={(e) => update(line.key, { discountPct: Number(e.target.value) })} />
                </td>
                {showVat ? (
                  <td className="px-2 py-1.5">
                    <span className="flex items-center gap-1">
                      <input
                        type="checkbox"
                        checked={line.taxable}
                        disabled={locked}
                        title="Subject to VAT"
                        onChange={(e) => update(line.key, { taxable: e.target.checked, vatRate: e.target.checked ? defaultVat : 0 })}
                        className="h-4 w-4 accent-[var(--red-500)]"
                      />
                      <Input
                        className="w-16 px-1.5 py-1 text-right"
                        type="number" min="0" max="100" step="0.5"
                        value={line.vatRate}
                        disabled={locked || !line.taxable}
                        onChange={(e) => update(line.key, { vatRate: Number(e.target.value) })}
                      />
                    </span>
                  </td>
                ) : (
                  <td className="px-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={line.taxable}
                      disabled={locked}
                      title="Subject to VAT"
                      onChange={(e) => update(line.key, { taxable: e.target.checked, vatRate: e.target.checked ? defaultVat : 0 })}
                      className="h-4 w-4 accent-[var(--red-500)]"
                    />
                  </td>
                )}
                <td className="tabular whitespace-nowrap px-2 py-1.5 text-right text-muted">{money(lineVat(line), true)}</td>
                <td className="tabular whitespace-nowrap px-2 py-1.5 text-right font-semibold">{money(lineNet(line), true)}</td>
                <td className="px-2 py-1.5">
                  {!locked && lines.length > 1 ? (
                    <button onClick={() => onChange(lines.filter((l) => l.key !== line.key))} aria-label="Remove line" className="text-n300 transition-colors hover:text-accent">
                      <Trash2 size={14} />
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {lines.every((line) => !line.description.trim()) ? (
        <EmptyState title="No lines yet" message="Search the catalog, or type a description for a one-off item." />
      ) : null}

      {!locked ? (
        <div className="border-t border-line px-3 py-2">
          <Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...lines, blankLine(defaultVat)])}>
            Add line
          </Button>
        </div>
      ) : null}
    </>
  );
}

/**
 * Provenance under the cost cell. Where a rate was applied the vendor's own figure is
 * printed too: someone checking a margin against a price list needs to see "USD 138",
 * not only the dirhams it became. A currency with no rate is called out in red — that
 * cost is not in the document's money and any margin beside it is wrong.
 */
function CostSource({ source }: { source: ResolvedCost }) {
  const label =
    source.rateMissing ? `No rate for ${source.sourceCurrency}`
      : source.source === 'special' ? 'Special price'
      : source.source === 'price-book' ? 'Price book'
      : source.source === 'catalogue' ? 'Catalogue'
      : 'No cost on file';

  const converted = !source.rateMissing && source.rate !== null && source.rate !== 1;

  return (
    <span
      title={source.reason}
      className={cx(
        'mt-0.5 block max-w-28 truncate text-[10px]',
        source.rateMissing || source.source === 'none' ? 'font-semibold text-accent'
          : source.source === 'special' ? 'font-semibold text-[var(--status-secure)]'
          : 'text-n400',
      )}
    >
      {label}
      {converted ? (
        <span className="block text-n400">{source.sourceCurrency} {source.sourceCost} @ {source.rate}</span>
      ) : null}
    </span>
  );
}

function CatalogLine({ line, locked, costFromCatalog, onPick, onDescription }: {
  line: EditableLine;
  locked: boolean;
  costFromCatalog: boolean;
  onPick: (p: { id: string; name: string; unit: string; listPrice: number | string; cost?: number | string; taxable: boolean }) => void | Promise<void>;
  onDescription: (value: string) => void;
}) {
  const [picking, setPicking] = useState(false);

  if (picking && !locked) {
    return (
      <Lookup<{ id: string; sku: string; name: string; unit: string; listPrice: string | number; cost?: string | number; taxable: boolean; vendor: { name: string } | null }>
        value={null}
        onChange={(_, row) => { if (row) void onPick(row); setPicking(false); }}
        endpoint="/products"
        extraParams={{ isActive: true }}
        placeholder={costFromCatalog ? 'Search the catalog (buy price)…' : 'Search the catalog…'}
        render={(row) => ({ primary: `${row.sku} · ${row.name}`, secondary: row.vendor?.name ?? undefined })}
      />
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input value={line.description} disabled={locked} placeholder="Description" className="px-2 py-1"
        onChange={(e) => onDescription(e.target.value)} />
      {!locked ? (
        <button onClick={() => setPicking(true)} title="Pick from catalog"
          className="shrink-0 rounded-sharp border border-line px-1.5 py-1 text-[10px] font-semibold uppercase text-muted hover:border-n900 hover:text-ink">
          SKU
        </button>
      ) : null}
    </div>
  );
}

/** Mirrors the server's per-line tax maths for a live preview. Server figures win on save. */
export function previewTotals(lines: EditableLine[], headerDiscountPct = 0) {
  const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
  const factor = 1 - headerDiscountPct / 100;

  let subtotal = 0;
  let vatAmount = 0;
  let totalCost = 0;

  for (const line of lines) {
    const gross = r2(line.quantity * line.unitPrice);
    const net = r2(gross - r2(gross * (line.discountPct / 100)));
    subtotal = r2(subtotal + net);
    totalCost = r2(totalCost + r2(line.quantity * (line.unitCost ?? 0)));
    if (line.taxable) vatAmount = r2(vatAmount + r2(r2(net * factor) * (line.vatRate / 100)));
  }

  const discountAmt = r2(subtotal * (headerDiscountPct / 100));
  const netAfterDiscount = r2(subtotal - discountAmt);
  const marginAmount = r2(netAfterDiscount - totalCost);

  return {
    subtotal, discountAmt, netAfterDiscount, vatAmount,
    total: r2(netAfterDiscount + vatAmount),
    totalCost, marginAmount,
    marginPct: netAfterDiscount === 0 ? 0 : r2((marginAmount / netAfterDiscount) * 100),
  };
}
