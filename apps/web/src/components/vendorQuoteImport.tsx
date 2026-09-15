import { useState } from 'react';
import { CheckCircle2, AlertTriangle, Upload } from 'lucide-react';
import { ApiError } from '../lib/api';
import { percent } from '../lib/format';
import { AccountPicker } from './pickers';
import { Button, ErrorNote, Field, Input, Modal, Select, Textarea, cx } from './ui';
import { blankLine, type EditableLine } from './lineEditor';

/**
 * Bring a vendor's quote into the worksheet: paste it or upload it, check what was read, apply.
 *
 * Nothing is accepted unseen. Zeus reads the rows that look like priced lines and ticks the ones
 * whose numbers multiply out; everything else is offered unticked with the row it came from
 * beside it. The strongest check is the vendor's own total — when the ticked lines add up to it,
 * nothing was dropped, and the screen says so in as many words.
 *
 * A part number already on the worksheet is a re-quote: its cost is updated in place and the
 * change is shown, rather than the line being added twice.
 */

interface ReadLine {
  vendorCode: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number | null;
  source: string;
  confident: boolean;
}

interface Read {
  currency: string | null;
  documentTotal: number | null;
  lines: ReadLine[];
}

type Row = ReadLine & { include: boolean; matchKey: string | null };

const figures = new Intl.NumberFormat('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const figure = (v: number) => figures.format(v);

export function VendorQuoteImport({
  lines, rates, baseCurrency, onApply, onClose,
}: {
  lines: EditableLine[];
  rates: Record<string, number>;
  baseCurrency: string;
  /** `original` is the very file that was read, for the editor to keep with the quote. */
  onApply: (lines: EditableLine[], summary: string, original: File) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [read, setRead] = useState<Read | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [vendor, setVendor] = useState<{ id: string | null; name: string | null }>({ id: null, name: null });
  const [currency, setCurrency] = useState(baseCurrency);
  const [fxRate, setFxRate] = useState(1);

  const byCode = new Map(lines.filter((l) => l.vendorCode).map((l) => [l.vendorCode!.toLowerCase(), l]));

  // What was read is what gets kept: the editor attaches this same File, pasted text included.
  const [original, setOriginal] = useState<File | null>(null);

  /** Ask the server what the file says. Nothing is stored until the quote keeps the file. */
  const readIt = async () => {
    setError(null);
    setBusy(true);
    try {
      const upload = file ?? new File([text], 'vendor-quote.txt', { type: 'text/plain' });
      const body = new FormData();
      body.append('file', upload);
      const res = await fetch('/api/quotes/vendor-quote/read', { method: 'POST', credentials: 'include', body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? `Could not read that (${res.status})`);
      const result = json as Read;
      setOriginal(upload);
      if (result.lines.length === 0) throw new Error('No priced lines were found in that. Try pasting just the table, or upload the Excel version if the vendor has one.');
      const cur = result.currency ?? baseCurrency;
      setRead(result);
      setCurrency(cur);
      setFxRate(cur === baseCurrency ? 1 : rates[cur] ?? 1);
      setRows(result.lines.map((l) => ({ ...l, include: l.confident, matchKey: l.vendorCode && byCode.has(l.vendorCode.toLowerCase()) ? l.vendorCode.toLowerCase() : null })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that.');
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.include);
  const chosenTotal = chosen.reduce((s, r) => s + Math.round(r.quantity * r.unitPrice * 100) / 100, 0);
  const difference = read?.documentTotal == null ? null : Math.round((chosenTotal - read.documentTotal) * 100) / 100;

  const apply = () => {
    let updated = 0;
    const next = lines.map((line) => {
      const match = line.vendorCode ? chosen.find((r) => r.matchKey === line.vendorCode!.toLowerCase()) : undefined;
      if (!match) return line;
      updated += 1;
      return { ...line, vendorUnitCost: match.unitPrice, vendorCurrency: currency, fxRate, vendorId: vendor.id ?? line.vendorId, vendorName: vendor.name ?? line.vendorName };
    });
    const added = chosen.filter((r) => !r.matchKey).map((r) => ({
      ...blankLine(),
      description: r.description || r.vendorCode || 'Vendor line',
      quantity: r.quantity,
      vendorCode: r.vendorCode,
      vendorId: vendor.id,
      vendorName: vendor.name,
      vendorCurrency: currency,
      fxRate,
      vendorUnitCost: r.unitPrice,
      markupPct: null,
    }));
    // A worksheet that was only the empty starter line should not keep it.
    const kept = next.filter((l) => l.description.trim() || l.vendorUnitCost != null);
    onApply([...kept, ...added], `${added.length} line${added.length === 1 ? '' : 's'} added${updated ? `, ${updated} re-costed` : ''}.`, original!);
  };

  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      title="Bring in the vendor's quote"
      subtitle={read ? 'Check what was read. Nothing goes onto the worksheet until you apply it.' : 'Paste the table from the email, or upload the file. The original is kept with the quote.'}
      footer={read ? (
        <>
          <Button variant="ghost" onClick={() => setRead(null)}>Back</Button>
          <Button variant="accent" disabled={chosen.length === 0} onClick={apply}>
            Apply {chosen.length} line{chosen.length === 1 ? '' : 's'}
          </Button>
        </>
      ) : (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" icon={<Upload size={13} />} loading={busy} disabled={!file && !text.trim()} onClick={() => void readIt()}>Read it</Button>
        </>
      )}
    >
      {error ? <div className="mb-3"><ErrorNote error={error} /></div> : null}

      {!read ? (
        <div className="grid gap-4">
          <Field label="Paste" hint="Copied from the email, the PDF or the spreadsheet — the table is enough.">
            <Textarea rows={8} value={text} disabled={Boolean(file)} onChange={(e) => setText(e.target.value)} placeholder={'Part number\tDescription\tQty\tUnit price\tTotal'} />
          </Field>
          <Field label="Or upload" hint="Excel, CSV, Word, PDF or a text file.">
            <input
              type="file"
              accept=".xlsx,.csv,.docx,.pdf,.txt"
              aria-label="Vendor quote file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block text-[13px]"
            />
          </Field>
        </div>
      ) : (
        <div className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <Field label="Vendor" hint="Applied to every line brought in.">
              <AccountPicker type="VENDOR" value={vendor.id} selectedLabel={vendor.name} placeholder="Vendor…" onChange={(id, row) => setVendor({ id, name: row?.name ?? null })} />
            </Field>
            <Field label="Currency">
              <Select
                className="w-24" value={currency}
                options={[baseCurrency, ...Object.keys(rates).filter((c) => c !== baseCurrency)].map((c) => ({ value: c, label: c }))}
                onChange={(e) => { setCurrency(e.target.value); setFxRate(e.target.value === baseCurrency ? 1 : rates[e.target.value] ?? 1); }}
              />
            </Field>
            <Field label="Rate">
              <Input className="w-28 text-right" type="number" step="0.0001" value={fxRate} disabled={currency === baseCurrency} onChange={(e) => setFxRate(Number(e.target.value) || 1)} />
            </Field>
          </div>

          <TotalCheck chosenTotal={chosenTotal} documentTotal={read.documentTotal} difference={difference} currency={currency} />

          <div className="max-h-[50vh] overflow-auto border border-line">
            <table className="w-full min-w-[760px] border-collapse text-[13px]">
              <thead className="sticky top-0">
                <tr className="bg-n950 text-white">
                  {['', 'Code', 'Description', 'Qty', `Unit price ${currency}`, 'On the worksheet'].map((h, i) => (
                    <th key={h || i} className={cx('whitespace-nowrap px-2 py-2 text-[10px] font-bold uppercase tracking-[0.08em]', i === 3 || i === 4 ? 'text-right' : 'text-left')}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const existing = row.matchKey ? byCode.get(row.matchKey) : undefined;
                  const was = existing?.vendorUnitCost ?? null;
                  return (
                    <tr key={i} className={cx('border-b border-line align-top', !row.include && 'text-muted')}>
                      <td className="px-2 py-1.5">
                        <input type="checkbox" checked={row.include} aria-label={`Bring in ${row.description || row.vendorCode || `line ${i + 1}`}`} onChange={(e) => set(i, { include: e.target.checked })} className="mt-1.5 h-4 w-4 accent-[var(--red-500)]" />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input className="w-36 px-1.5 py-1" value={row.vendorCode ?? ''} aria-label="Vendor code" onChange={(e) => set(i, { vendorCode: e.target.value || null, matchKey: e.target.value && byCode.has(e.target.value.toLowerCase()) ? e.target.value.toLowerCase() : null })} />
                      </td>
                      <td className="min-w-[220px] px-2 py-1.5">
                        <Input className="px-1.5 py-1" value={row.description} aria-label="Description" onChange={(e) => set(i, { description: e.target.value })} />
                        {/* What it was read from, so a wrong guess is visible without opening the file. */}
                        <span className="mt-0.5 block truncate font-mono text-[10px] text-muted" title={row.source}>{row.source}</span>
                      </td>
                      <td className="px-2 py-1.5">
                        <Input className="w-20 px-1.5 py-1 text-right" type="number" min="0" value={row.quantity} aria-label="Quantity" onChange={(e) => set(i, { quantity: Number(e.target.value) })} />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input className="w-28 px-1.5 py-1 text-right" type="number" step="0.01" value={row.unitPrice} aria-label="Unit price" onChange={(e) => set(i, { unitPrice: Number(e.target.value) })} />
                        {!row.confident ? <span className="mt-0.5 block text-right text-[10px] text-watch">check this</span> : null}
                      </td>
                      <td className="min-w-[200px] max-w-[260px] px-2 py-2 text-[12px]">
                        {existing ? (
                          <span>
                            Updates <strong>{existing.description}</strong>
                            {was != null && was !== row.unitPrice ? (
                              <span className={cx('block tabular', row.unitPrice > was ? 'text-accent-ink' : 'text-secure')}>
                                {figure(was)} → {figure(row.unitPrice)} ({row.unitPrice > was ? '+' : ''}{percent(((row.unitPrice - was) / was) * 100, 1)})
                              </span>
                            ) : <span className="block text-muted">price unchanged</span>}
                          </span>
                        ) : <span className="text-muted">New line</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The one line that says whether anything was missed. */
function TotalCheck({ chosenTotal, documentTotal, difference, currency }: {
  chosenTotal: number; documentTotal: number | null; difference: number | null; currency: string;
}) {
  if (documentTotal == null) {
    return (
      <p className="flex items-center gap-2 text-[12px] text-muted">
        <AlertTriangle size={14} className="text-watch" />
        No total found on the document to check against. Ticked lines add up to {currency} {figure(chosenTotal)}.
      </p>
    );
  }
  const matches = difference === 0;
  return (
    <p className={cx('flex items-center gap-2 text-[12px] font-semibold', matches ? 'text-secure' : 'text-accent-ink')}>
      {matches ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
      {matches
        ? `Ticked lines add up to the vendor's total of ${currency} ${figure(documentTotal)}. Nothing was missed.`
        : `Ticked lines add up to ${currency} ${figure(chosenTotal)}; the vendor's total is ${currency} ${figure(documentTotal)} — ${figure(Math.abs(difference!))} ${difference! < 0 ? 'short' : 'over'}. Check for a missed or extra line (tax and freight are often totalled in).`}
    </p>
  );
}
