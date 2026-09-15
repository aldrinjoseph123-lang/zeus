import { Plus, Trash2 } from 'lucide-react';
import { percent } from '../lib/format';
import { Button, Input, Select, cx } from './ui';
import { AccountPicker } from './pickers';
import { blankLine, type EditableLine } from './lineEditor';

/**
 * The working behind a quote: what each vendor quoted, in their currency, and the markup on it.
 *
 * Same lines as the customer view, more columns. Nothing here is a second document — the
 * customer's quote is these lines with the vendor, cost and markup columns left off.
 *
 * Markup is on cost (100 at 20% sells for 120) because that is how the team prices. Margin
 * is on sell (20 ÷ 120 = 16.7%) because that is what the approval floor and every report
 * measure. Both are shown, beside each other, so neither gets mistaken for the other.
 */

const r2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Figures without the currency on every cell — a sheet this dense names it once, in the header. */
const figures = new Intl.NumberFormat('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const figure = (v: number) => figures.format(v);

/**
 * Mirrors recalcQuote for a live preview; the server prices the lines again on save and its
 * figures are the ones stored. The sell price is marked up from the unrounded cost and rounded
 * once, as the server does.
 */
export function priceWorksheet(lines: EditableLine[], defaultMarkupPct: number | null): EditableLine[] {
  return lines.map((line) => {
    if (line.vendorUnitCost == null) return { ...line, priceFromWorksheet: false };
    const cost = line.vendorUnitCost * (line.fxRate ?? 1);
    const markup = line.markupPct ?? defaultMarkupPct;
    return markup == null
      ? { ...line, unitCost: r2(cost), priceFromWorksheet: false }
      : { ...line, unitCost: r2(cost), unitPrice: r2(cost * (1 + markup / 100)), discountPct: 0, priceFromWorksheet: true };
  });
}

const blank = (value: string) => (value.trim() === '' ? null : Number(value));

export function QuoteWorksheet({
  lines, onChange, defaultMarkupPct, onDefaultMarkupChange, rates, baseCurrency, locked,
}: {
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
  defaultMarkupPct: number | null;
  onDefaultMarkupChange: (value: number | null) => void;
  /** Base-currency units per one unit of each foreign currency, from Settings → Finance. */
  rates: Record<string, number>;
  baseCurrency: string;
  locked: boolean;
}) {
  const update = (key: string, patch: Partial<EditableLine>) =>
    onChange(priceWorksheet(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)), defaultMarkupPct));

  const currencies = [baseCurrency, ...Object.keys(rates).filter((c) => c !== baseCurrency).sort()];

  const cost = (l: EditableLine) => r2(l.quantity * (l.unitCost ?? 0));
  const sell = (l: EditableLine) => r2(l.quantity * l.unitPrice * (1 - l.discountPct / 100));
  const marginOf = (c: number, s: number) => (s === 0 ? null : ((s - c) / s) * 100);
  const markupOf = (c: number, s: number) => (c === 0 ? null : ((s - c) / c) * 100);

  const totalCost = r2(lines.reduce((sum, l) => sum + cost(l), 0));
  const totalSell = r2(lines.reduce((sum, l) => sum + sell(l), 0));
  const totalMargin = marginOf(totalCost, totalSell);

  // Subtotals per vendor, so each block can be checked against the quote that vendor sent.
  const byVendor = new Map<string, { cost: number; sell: number }>();
  for (const l of lines) {
    if (!l.description.trim()) continue;
    const name = l.isInternal ? 'Internal' : l.vendorName ?? 'No vendor';
    const row = byVendor.get(name) ?? { cost: 0, sell: 0 };
    byVendor.set(name, { cost: r2(row.cost + cost(l)), sell: r2(row.sell + sell(l)) });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line px-4 py-3 text-[13px]">
        <label className="flex items-center gap-2">
          <span className="text-muted">Default markup</span>
          <Input
            className="w-20 px-2 py-1 text-right"
            type="number" step="0.5"
            aria-label="Default markup on cost, percent"
            placeholder="None"
            value={defaultMarkupPct ?? ''}
            disabled={locked}
            onChange={(e) => onDefaultMarkupChange(blank(e.target.value))}
          />
          <span className="text-muted">% on cost</span>
        </label>
        <p className="text-[12px] text-muted">
          Lines without their own markup use this. Markup is on cost; margin is on the sell price.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1040px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-n950 text-white">
              {['Vendor / code', 'Description', 'Qty', 'Vendor price', 'Cur / rate', `Cost ${baseCurrency}`, 'Markup %', `Unit sell ${baseCurrency}`, `Line total ${baseCurrency}`, 'Margin', ''].map((h, i) => (
                <th key={h || i} className={cx('whitespace-nowrap px-1.5 py-2 text-[10px] font-bold uppercase tracking-[0.08em]', i >= 2 && i !== 4 ? 'text-right' : 'text-left')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => {
              const lineCost = cost(line);
              const lineSell = sell(line);
              const margin = marginOf(lineCost, lineSell);
              const typedMarkup = line.markupPct ?? defaultMarkupPct;
              const realised = markupOf(lineCost, lineSell);
              return (
                <tr key={line.key} className={cx('border-b border-line align-top', index % 2 === 1 && 'bg-sunken')}>
                  {/* Vendor over its part number: two facts about where the line came from, one column. */}
                  <td className="w-44 max-w-44 px-1.5 py-1.5">
                    {line.isInternal ? (
                      <span className="block py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-watch">Internal</span>
                    ) : (
                      // Pinned: a table column grows to its longest vendor name otherwise.
                      <div className="w-40 overflow-hidden">
                        <AccountPicker
                          type="VENDOR"
                          value={line.vendorId ?? null}
                          selectedLabel={line.vendorName ?? null}
                          placeholder="Vendor…"
                          onChange={(id, row) => update(line.key, { vendorId: id, vendorName: row?.name ?? null })}
                        />
                      </div>
                    )}
                    <span className="mt-1 flex w-40 items-center gap-1.5">
                      <Input className="min-w-0 flex-1 px-1.5 py-0.5 text-[12px]" value={line.vendorCode ?? ''} disabled={locked} aria-label="Vendor code" placeholder="Part no."
                        onChange={(e) => update(line.key, { vendorCode: e.target.value || null })} />
                      {!locked ? (
                        <button
                          className="shrink-0 text-[11px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
                          onClick={() => update(line.key, line.isInternal
                            ? { isInternal: false }
                            : { isInternal: true, vendorId: null, vendorName: null, vendorCurrency: baseCurrency, fxRate: 1 })}
                        >
                          {line.isInternal ? 'Vendor' : 'Internal'}
                        </button>
                      ) : null}
                    </span>
                  </td>
                  <td className="min-w-[180px] px-1.5 py-1.5">
                    <Input className="px-1.5 py-1" value={line.description} disabled={locked} aria-label="Description"
                      onChange={(e) => update(line.key, { description: e.target.value })} />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <Input className="w-16 px-1.5 py-1 text-right" type="number" min="0" step="1" value={line.quantity} disabled={locked} aria-label="Quantity"
                      onChange={(e) => update(line.key, { quantity: Number(e.target.value) })} />
                  </td>
                  <td className="px-1.5 py-1.5">
                    <Input
                      className="w-24 px-1.5 py-1 text-right" type="number" min="0" step="0.01" aria-label="Vendor unit price"
                      value={line.vendorUnitCost ?? ''}
                      placeholder={line.unitCost ? String(line.unitCost) : '0.00'}
                      disabled={locked}
                      onChange={(e) => update(line.key, {
                        vendorUnitCost: blank(e.target.value),
                        vendorCurrency: line.vendorCurrency ?? baseCurrency,
                        fxRate: line.fxRate ?? 1,
                        costSource: null,
                      })}
                    />
                  </td>
                  {/* Currency over the rate it converts at. */}
                  <td className="px-1.5 py-1.5">
                    <Select
                      className="w-20 px-1.5 py-1" aria-label="Vendor currency"
                      value={line.vendorCurrency ?? baseCurrency}
                      disabled={locked || line.isInternal}
                      options={currencies.map((c) => ({ value: c, label: c }))}
                      // The rate is copied onto the line here and stays there: reopening the quote
                      // next month shows the arithmetic that was used, not today's rate.
                      onChange={(e) => update(line.key, { vendorCurrency: e.target.value, fxRate: e.target.value === baseCurrency ? 1 : rates[e.target.value] ?? 1 })}
                    />
                    <Input className="mt-1 w-20 px-1.5 py-0.5 text-right text-[12px]" type="number" min="0" step="0.0001" aria-label="Exchange rate"
                      value={line.fxRate ?? 1}
                      disabled={locked || (line.vendorCurrency ?? baseCurrency) === baseCurrency}
                      onChange={(e) => update(line.key, { fxRate: Number(e.target.value) || 1 })} />
                  </td>
                  <td className="tabular whitespace-nowrap px-1.5 py-2 text-right">{figure(line.unitCost ?? 0)}</td>
                  <td className="px-1.5 py-1.5">
                    <Input
                      className="w-16 px-1.5 py-1 text-right" type="number" step="0.5" aria-label="Markup on cost, percent"
                      value={line.markupPct ?? ''}
                      placeholder={defaultMarkupPct != null ? String(defaultMarkupPct) : '—'}
                      disabled={locked || line.vendorUnitCost == null}
                      title={line.vendorUnitCost == null ? 'Enter the vendor price first.' : undefined}
                      onChange={(e) => update(line.key, { markupPct: blank(e.target.value) })}
                    />
                    {line.markupPct == null && defaultMarkupPct != null && line.vendorUnitCost != null ? (
                      <span className="mt-0.5 block text-right text-[10px] text-muted">default</span>
                    ) : null}
                  </td>
                  <td className="px-1.5 py-1.5 text-right">
                    {line.priceFromWorksheet ? (
                      <span className="tabular block py-0.5 font-semibold">{figure(line.unitPrice)}</span>
                    ) : (
                      <Input className="w-24 px-1.5 py-1 text-right" type="number" step="0.01" aria-label="Unit sell price" value={line.unitPrice} disabled={locked}
                        onChange={(e) => update(line.key, { unitPrice: Number(e.target.value) })} />
                    )}
                    {/* Rounding to the fil moves markup a hair; show the real figure when it has moved. */}
                    {typedMarkup != null && realised != null && Math.abs(realised - typedMarkup) >= 0.05 ? (
                      <span className="mt-0.5 block text-[10px] text-muted">{percent(realised, 1)} realised</span>
                    ) : null}
                  </td>
                  <td className="tabular whitespace-nowrap px-1.5 py-2 text-right font-semibold">{figure(lineSell)}</td>
                  <td className={cx('tabular whitespace-nowrap px-1.5 py-2 text-right', marginTone(margin))}>
                    {margin == null ? '—' : percent(margin, 1)}
                  </td>
                  <td className="px-1.5 py-2">
                    {!locked && lines.length > 1 ? (
                      <button onClick={() => onChange(lines.filter((l) => l.key !== line.key))} aria-label="Remove line" className="text-n300 transition-colors hover:text-accent-ink">
                        <Trash2 size={14} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line bg-sunken font-semibold">
              <td className="px-1.5 py-2 text-[10px] uppercase tracking-[0.08em]" colSpan={5}>Total</td>
              <td className="tabular whitespace-nowrap px-1.5 py-2 text-right">{figure(totalCost)}</td>
              <td className="tabular whitespace-nowrap px-1.5 py-2 text-right">{percent(markupOf(totalCost, totalSell) ?? 0, 1)}</td>
              <td />
              <td className="tabular whitespace-nowrap px-1.5 py-2 text-right">{figure(totalSell)}</td>
              <td className={cx('tabular whitespace-nowrap px-1.5 py-2 text-right', marginTone(totalMargin))}>
                {totalMargin == null ? '—' : percent(totalMargin, 1)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 border-t border-line px-3 py-2">
        {!locked ? (
          <Button size="sm" icon={<Plus size={13} />} onClick={() => onChange([...lines, { ...blankLine(), vendorCurrency: baseCurrency, fxRate: 1 }])}>
            Add line
          </Button>
        ) : <span />}
        {byVendor.size > 1 ? (
          <table className="text-[12px]">
            <caption className="sr-only">Cost, sell and margin by vendor</caption>
            <thead>
              <tr className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted">
                <th className="pr-4 text-left">By vendor</th>
                <th className="pr-4 text-right">Cost</th>
                <th className="pr-4 text-right">Sell</th>
                <th className="text-right">Margin</th>
              </tr>
            </thead>
            <tbody>
              {[...byVendor].map(([name, v]) => {
                const m = marginOf(v.cost, v.sell);
                return (
                  <tr key={name}>
                    <td className="pr-4">{name}</td>
                    <td className="tabular pr-4 text-right">{figure(v.cost)}</td>
                    <td className="tabular pr-4 text-right">{figure(v.sell)}</td>
                    <td className={cx('tabular text-right', marginTone(m))}>{m == null ? '—' : percent(m, 1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
      </div>
    </>
  );
}

/** The same thresholds as the totals card beside it, so the two never disagree about a colour. */
function marginTone(margin: number | null) {
  if (margin == null) return 'text-muted';
  return margin < 10 ? 'text-accent-ink' : margin < 20 ? 'text-watch' : 'text-secure';
}
