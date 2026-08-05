import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { money } from '../lib/format';
import { Button, EmptyState, Input, cx } from './ui';
import { Lookup } from './pickers';
import { api, qs } from '../lib/api';

/**
 * Editable line grid shared by the invoice, credit note and purchase order editors.
 * Each line carries its own VAT rate because the FTA requires the tax rate to appear
 * against every line — a zero-rated export can sit beside a standard-rated service on
 * the same document.
 */

export interface EditableLine {
  key: string;
  productId: string | null;
  description: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  unitCost?: number;
  /** Where the cost came from — shown under the cost cell so a margin is explainable. */
  costSource?: { source: string; reason: string } | null;
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
      return await api.get<{ cost: number; source: string; reason: string }>(
        `/price-book/resolve${qs({ productId, quantity, dealId, vendorId })}`,
      );
    } catch {
      // A role without cost access gets a 403 here, and its cost column is hidden anyway.
      return null;
    }
  };

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
                        costSource: priced ? { source: priced.source, reason: priced.reason } : null,
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
                    {line.costSource ? (
                      <span
                        title={line.costSource.reason}
                        className={cx(
                          'mt-0.5 block max-w-28 truncate text-[10px]',
                          line.costSource.source === 'special' ? 'font-semibold text-[var(--status-secure)]'
                            : line.costSource.source === 'none' ? 'text-accent'
                            : 'text-n400',
                        )}
                      >
                        {line.costSource.source === 'special' ? 'Special price'
                          : line.costSource.source === 'price-book' ? 'Price book'
                          : line.costSource.source === 'catalogue' ? 'Catalogue'
                          : 'No cost on file'}
                      </span>
                    ) : null}
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
