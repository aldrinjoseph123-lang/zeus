import ExcelJS from 'exceljs';
import type { TableColumn } from './pdf.js';
import { round2 } from '../lib/money.js';

/**
 * Excel forbids * ? : \ / [ ] in a worksheet name, caps it at 31 chars, and rejects
 * a blank one — feed it a report title with a slash or colon and addWorksheet throws,
 * turning an export into a 500. Sanitise to a name Excel always accepts.
 */
function sheetName(raw: string): string {
  const cleaned = raw.replace(/[*?:\\/[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  return cleaned || 'Sheet1';
}

/** Excel export styled to match the PDF: black header, red rule, frozen top row. */
export async function tableXlsx(opts: {
  title: string;
  sheetName?: string;
  columns: TableColumn[];
  rows: Array<Record<string, unknown>>;
  summary?: Array<[string, string]>;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zeus CRM';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName(opts.sheetName ?? opts.title), {
    views: [{ state: 'frozen', ySplit: opts.summary?.length ? 4 : 2 }],
  });

  ws.mergeCells(1, 1, 1, Math.max(1, opts.columns.length));
  const titleCell = ws.getCell(1, 1);
  titleCell.value = opts.title.toUpperCase();
  titleCell.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0A' } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 26;

  let cursor = 2;
  if (opts.summary?.length) {
    const labels = ws.getRow(cursor);
    const values = ws.getRow(cursor + 1);
    opts.summary.forEach(([k, v], i) => {
      labels.getCell(i + 1).value = k.toUpperCase();
      labels.getCell(i + 1).font = { size: 8, color: { argb: 'FF6B6B6B' }, bold: true };
      values.getCell(i + 1).value = v;
      values.getCell(i + 1).font = { size: 11, bold: true };
    });
    cursor += 3;
  }

  const headerRow = ws.getRow(cursor);
  opts.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label;
    cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0A' } };
    cell.alignment = { horizontal: col.align ?? 'left', vertical: 'middle' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFE11D2E' } } };
  });
  headerRow.height = 20;

  opts.rows.forEach((row, index) => {
    const excelRow = ws.getRow(cursor + 1 + index);
    opts.columns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1);
      const raw = row[col.key];
      if (col.format === 'money') {
        cell.value = raw === null || raw === undefined ? null : Number(raw);
        cell.numFmt = '#,##0.00';
      } else if (col.format === 'percent') {
        cell.value = raw === null || raw === undefined ? null : Number(raw) / 100;
        cell.numFmt = '0.0%';
      } else if (col.format === 'date') {
        cell.value = raw ? new Date(raw as string) : null;
        cell.numFmt = 'dd mmm yyyy';
      } else {
        cell.value = (raw ?? null) as ExcelJS.CellValue;
      }
      cell.alignment = { horizontal: col.align ?? 'left' };
      if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F6F4' } };
    });
  });

  opts.columns.forEach((col, i) => {
    const header = col.label.length;
    const sample = opts.rows.slice(0, 200).reduce((max, r) => Math.max(max, String(r[col.key] ?? '').length), 0);
    ws.getColumn(i + 1).width = Math.min(48, Math.max(11, header + 2, sample + 2));
  });

  ws.autoFilter = {
    from: { row: cursor, column: 1 },
    to: { row: cursor + opts.rows.length, column: opts.columns.length },
  };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface TemplateColumn {
  label: string;
  required?: boolean;
  type?: string;
  values?: string[];
  example?: string;
  example2?: string;
}

/**
 * Blank import template: sheet 1 is the sheet they fill in (header row first, so it
 * can be handed straight back to the importer), sheet 2 explains every column.
 * Closed lists become real Excel dropdowns — the fastest way to stop a file arriving
 * with "Won" in a column that only accepts NEW/WORKING/QUALIFIED.
 */
export async function templateXlsx(opts: { title: string; columns: TemplateColumn[]; note?: string }): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zeus CRM';
  wb.created = new Date();

  const ws = wb.addWorksheet(sheetName(opts.title), { views: [{ state: 'frozen', ySplit: 1 }] });
  const header = ws.getRow(1);
  opts.columns.forEach((col, i) => {
    const cell = header.getCell(i + 1);
    cell.value = col.label;
    cell.font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: col.required ? 'FF9E0E19' : 'FF0A0A0A' } };
    cell.alignment = { vertical: 'middle' };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFE11D2E' } } };
    cell.note = [
      col.required ? 'Required.' : 'Optional.',
      col.values?.length ? `One of: ${col.values.join(', ')}.` : '',
      col.type === 'date' ? 'Date, ideally YYYY-MM-DD.' : '',
      col.type === 'number' ? 'Numbers only — no AED, no thousands separator.' : '',
    ].filter(Boolean).join(' ');
    ws.getColumn(i + 1).width = Math.min(42, Math.max(14, col.label.length + 2, (col.example?.length ?? 0) + 2));
  });
  header.height = 20;

  // Two example rows, greyed so it is obvious they are samples to overwrite.
  for (const [offset, key] of (['example', 'example2'] as const).entries()) {
    const row = ws.getRow(2 + offset);
    opts.columns.forEach((col, i) => {
      const cell = row.getCell(i + 1);
      const sample = col[key] ?? '';
      // Numeric samples go in as numbers, so nobody copies the pattern of a
      // text-formatted amount column back to us.
      cell.value = col.type === 'number' && sample !== '' ? Number(sample) : sample;
      cell.font = { italic: true, color: { argb: 'FF9B9B9B' } };
    });
  }

  // Dropdowns down the sheet, so the list is there for the rows they add.
  opts.columns.forEach((col, i) => {
    if (!col.values?.length) return;
    const list = `"${col.values.join(',')}"`;
    for (let row = 2; row <= 500; row++) {
      ws.getCell(row, i + 1).dataValidation = {
        type: 'list', allowBlank: !col.required, formulae: [list],
        showErrorMessage: true, errorTitle: col.label, error: `Use one of: ${col.values.join(', ')}`,
      };
    }
  });

  const guide = wb.addWorksheet('How to fill this in');
  guide.columns = [
    { header: 'Column', key: 'column', width: 22 },
    { header: 'Required', key: 'required', width: 11 },
    { header: 'Accepted values', key: 'values', width: 52 },
    { header: 'Example', key: 'example', width: 34 },
  ];
  guide.getRow(1).font = { bold: true, size: 9, color: { argb: 'FFFFFFFF' } };
  guide.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0A' } };
  for (const col of opts.columns) {
    guide.addRow({
      column: col.label,
      required: col.required ? 'Yes' : 'No',
      values: col.values?.length
        ? col.values.join(' · ')
        : col.type === 'date' ? 'Date — YYYY-MM-DD'
        : col.type === 'number' ? 'Number — no currency symbol or commas'
        : 'Free text',
      example: col.example ?? '',
    });
  }
  if (opts.note) {
    guide.addRow({});
    guide.addRow({ column: 'Note', values: opts.note });
  }
  guide.getColumn('values').alignment = { wrapText: true, vertical: 'top' };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * Load a workbook someone else saved.
 *
 * Comments are the one part of a workbook an import never reads, and the part other tools
 * write differently. openpyxl (and whatever uses it) points a sheet at its comments by absolute
 * path; exceljs cannot follow that and the whole load fails with "Cannot read properties of
 * undefined (reading 'comments')". Zeus's own import template puts a note on every header, so a
 * template filled in and re-saved by such a tool could not be imported at all. The comments,
 * their drawings and the references to them are taken out before loading.
 */
export async function loadWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(buffer);
  for (const name of Object.keys(zip.files)) {
    if (/^xl\/(comments[^/]*\.xml|comments\/.*|threadedComments\/.*|drawings\/[^/]*\.vml)$/.test(name)) {
      zip.remove(name);
    } else if (/^xl\/worksheets\/(_rels\/)?[^/]+\.(xml|rels)$/.test(name)) {
      const xml = await zip.file(name)!.async('string');
      const cleaned = xml
        .replace(/<Relationship\b[^>]*\/(comments|vmlDrawing|threadedComment)"[^>]*\/>/g, '')
        .replace(/<legacyDrawing\b[^>]*\/>/g, '');
      if (cleaned !== xml) zip.file(name, cleaned);
    }
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await zip.generateAsync({ type: 'nodebuffer' })) as never);
  return wb;
}

/** Read the first sheet of an uploaded workbook (or CSV) into plain row objects. */
export async function readWorkbook(buffer: Buffer, filename: string): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  if (filename.toLowerCase().endsWith('.csv')) {
    const text = buffer.toString('utf8');
    return parseCsv(text);
  }
  const wb = await loadWorkbook(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  const headers: string[] = [];
  ws.getRow(1).eachCell((cell, col) => { headers[col - 1] = String(cell.value ?? '').trim(); });

  const rows: Array<Record<string, string>> = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const record: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((header, i) => {
      if (!header) return;
      const value = row.getCell(i + 1).value;
      const text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : typeof value === 'object' && 'text' in value ? String((value as { text: string }).text) : String(value);
      record[header] = text.trim();
      if (record[header]) hasValue = true;
    });
    if (hasValue) rows.push(record);
  });

  return { headers: headers.filter(Boolean), rows };
}

/** RFC4180-ish CSV parser — handles quoted fields, embedded commas and newlines. */
export function parseCsv(text: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  const clean = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (inQuotes) {
      if (char === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += char;
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { record.push(field); field = ''; continue; }
    if (char === '\r') continue;
    if (char === '\n') { record.push(field); records.push(record); record = []; field = ''; continue; }
    field += char;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }

  const [headerRow = [], ...dataRows] = records;
  const headers = headerRow.map((h) => h.trim()).filter(Boolean);
  const rows = dataRows
    .filter((r) => r.some((cell) => cell.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));

  return { headers, rows };
}

export interface WorksheetQuote {
  number: string;
  version: number;
  status: string;
  approvalStatus: string;
  account: { name: string };
  preparedBy: { name: string } | null;
  defaultMarkupPct: unknown;
  discountPct: unknown;
  vatRate: unknown;
  subtotal: unknown;
  discountAmt: unknown;
  vatAmount: unknown;
  total: unknown;
  totalCost: unknown;
  marginAmount: unknown;
  lines: Array<{
    description: string; quantity: unknown; unitPrice: unknown; unitCost: unknown; discountPct: unknown;
    lineTotal: unknown; lineCost: unknown; taxable: boolean;
    vendor: { name: string } | null; vendorCode: string | null; vendorCurrency: string;
    vendorUnitCost: unknown; fxRate: unknown; markupPct: unknown; isInternal: boolean;
  }>;
}

/**
 * The quote worksheet as a spreadsheet — the working a manager signed off, in the tool the
 * team used to do it in.
 *
 * Two versions from one layout. `formulas: false` is the record: every figure is the one Zeus
 * stored. `formulas: true` makes the sell cells real formulas over the cost cells, so a
 * manager can change a markup or a rate and watch it move. Those formulas are Zeus's own
 * arithmetic, cell for cell — marked up from the unrounded cost, rounded once, VAT per line
 * on the discounted base — so an untouched file recalculates to exactly the stored figures.
 * Each formula also carries its stored result, which is what Excel shows before it
 * recalculates and what a viewer that never recalculates shows forever.
 *
 * Neither version is for a customer or a vendor: both carry buy prices.
 */
export async function quoteWorksheetXlsx(quote: WorksheetQuote, opts: { formulas: boolean }): Promise<Buffer> {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zeus CRM';
  wb.created = new Date();
  // A cached result of zero does not survive the file, so have Excel work every formula out
  // as it opens rather than show a blank where a 0.00 discount should be.
  if (opts.formulas) wb.calcProperties.fullCalcOnLoad = true;
  const ws = wb.addWorksheet(sheetName(`${quote.number} worksheet`), { views: [{ state: 'frozen', ySplit: 6 }] });

  const black = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A0A0A' } } as const;
  const COLUMNS = [
    ['Vendor', 22], ['Code', 14], ['Description', 34], ['Qty', 7], ['Vendor price', 13], ['Cur', 6], ['Rate', 9],
    ['Unit cost AED', 13], ['Markup', 9], ['Unit sell AED', 13], ['Line total AED', 14], ['Line cost AED', 14], ['Margin', 9], ['VAT AED', 11],
  ] as const;
  COLUMNS.forEach(([, width], i) => { ws.getColumn(i + 1).width = width; });

  // Row 1–2: what this is, and who must not receive it.
  ws.mergeCells(1, 1, 1, COLUMNS.length);
  Object.assign(ws.getCell('A1'), {
    value: `${quote.number}${quote.version > 1 ? ` v${quote.version}` : ''} · WORKSHEET${opts.formulas ? ' · WITH FORMULAS' : ''}`,
    font: { bold: true, size: 13, color: { argb: 'FFFFFFFF' } }, fill: black, alignment: { vertical: 'middle' },
  });
  ws.getRow(1).height = 26;
  ws.mergeCells(2, 1, 2, COLUMNS.length);
  Object.assign(ws.getCell('A2'), {
    value: 'Internal — contains buy prices and markup. Not for customers or vendors.',
    font: { bold: true, size: 9, color: { argb: 'FFC8121F' } },
  });

  // Row 3–4: the quote-level inputs. The formulas point at E4, G4 and I4, so changing one
  // there reprices every line that depends on it.
  const inputs: Array<[string, string, ExcelJS.CellValue, string?]> = [
    ['A', 'Customer', quote.account.name],
    ['C', 'Prepared by', quote.preparedBy?.name ?? '—'],
    ['E', 'Default markup', quote.defaultMarkupPct === null ? null : Number(quote.defaultMarkupPct) / 100, '0.0%'],
    ['G', 'Discount', Number(quote.discountPct) / 100, '0.0%'],
    ['I', 'VAT', Number(quote.vatRate) / 100, '0.0%'],
    ['K', 'Status', `${quote.status} · approval ${quote.approvalStatus.replace('_', ' ').toLowerCase()}`],
  ];
  for (const [col, label, value, fmt] of inputs) {
    Object.assign(ws.getCell(`${col}3`), { value: label.toUpperCase(), font: { size: 8, bold: true, color: { argb: 'FF6B6B6B' } } });
    const cell = ws.getCell(`${col}4`);
    cell.value = value;
    cell.font = { size: 11, bold: true };
    if (fmt) cell.numFmt = fmt;
  }

  const header = ws.getRow(6);
  COLUMNS.forEach(([label], i) => {
    Object.assign(header.getCell(i + 1), {
      value: label, fill: black, font: { bold: true, size: 9, color: { argb: 'FFFFFFFF' } },
      alignment: { horizontal: i >= 3 && i !== 5 ? 'right' : 'left', vertical: 'middle' },
      border: { bottom: { style: 'medium', color: { argb: 'FFE11D2E' } } },
    });
  });
  header.height = 20;

  const first = 7;
  const last = first + quote.lines.length - 1;
  const put = (ref: string, formula: string | null, result: number | string | null, numFmt?: string) => {
    const cell = ws.getCell(ref);
    cell.value = opts.formulas && formula ? { formula, result: result ?? undefined } as ExcelJS.CellValue : result;
    if (numFmt) cell.numFmt = numFmt;
  };

  quote.lines.forEach((line, index) => {
    const r = first + index;
    const worksheet = line.vendorUnitCost !== null && line.vendorUnitCost !== undefined;
    const ownMarkup = n(line.markupPct);
    const effectiveMarkup = ownMarkup ?? n(quote.defaultMarkupPct);
    const priced = worksheet && effectiveMarkup !== null;
    const disc = Number(line.discountPct);
    const lineTotal = Number(line.lineTotal);
    const lineCost = Number(line.lineCost);
    const vatRate = line.taxable ? Number(quote.vatRate) : 0;
    const lineVat = round2(round2(lineTotal * (1 - Number(quote.discountPct) / 100)) * (vatRate / 100));

    ws.getCell(`A${r}`).value = line.isInternal ? 'Internal' : line.vendor?.name ?? '';
    ws.getCell(`B${r}`).value = line.vendorCode ?? '';
    ws.getCell(`C${r}`).value = line.description;
    put(`D${r}`, null, Number(line.quantity), '#,##0.##');
    put(`E${r}`, null, worksheet ? Number(line.vendorUnitCost) : null, '#,##0.00##');
    ws.getCell(`F${r}`).value = worksheet ? line.vendorCurrency : '';
    put(`G${r}`, null, worksheet ? Number(line.fxRate) : null, '0.0000##');
    put(`H${r}`, worksheet ? `ROUND(E${r}*G${r},2)` : null, Number(line.unitCost), '#,##0.00');
    // A line on the default points at E4 rather than holding a copy of it.
    put(`I${r}`, worksheet && ownMarkup === null && effectiveMarkup !== null ? '$E$4' : null, effectiveMarkup === null || !worksheet ? null : effectiveMarkup / 100, '0.0%');
    put(`J${r}`, priced ? `ROUND(E${r}*G${r}*(1+I${r}),2)` : null, Number(line.unitPrice), '#,##0.00');
    put(`K${r}`, disc > 0 ? `ROUND(ROUND(D${r}*J${r},2)-ROUND(ROUND(D${r}*J${r},2)*${disc / 100},2),2)` : `ROUND(D${r}*J${r},2)`, lineTotal, '#,##0.00');
    put(`L${r}`, `ROUND(D${r}*H${r},2)`, lineCost, '#,##0.00');
    put(`M${r}`, `IF(K${r}=0,"",(K${r}-L${r})/K${r})`, lineTotal === 0 ? '' : (lineTotal - lineCost) / lineTotal, '0.0%');
    put(`N${r}`, `ROUND(ROUND(K${r}*(1-$G$4),2)*${vatRate / 100},2)`, lineVat, '#,##0.00');
    if (index % 2 === 1) for (let c = 1; c <= COLUMNS.length; c++) ws.getRow(r).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6F6F4' } };
  });

  // Totals, then the quote's own summary in the customer's terms.
  const t = last + 1;
  const sell = Number(quote.subtotal);
  const cost = Number(quote.totalCost);
  const net = sell - Number(quote.discountAmt);
  ws.getCell(`A${t}`).value = 'TOTAL';
  const empty = quote.lines.length === 0;
  put(`I${t}`, empty ? null : `IF(L${t}=0,"",(K${t}-L${t})/L${t})`, cost === 0 ? '' : (sell - cost) / cost, '0.0%');
  // Rounded as Zeus rounds while it adds; a bare SUM of money drifts a fraction of a fil.
  put(`K${t}`, empty ? null : `ROUND(SUM(K${first}:K${last}),2)`, sell, '#,##0.00');
  put(`L${t}`, empty ? null : `ROUND(SUM(L${first}:L${last}),2)`, cost, '#,##0.00');
  put(`M${t}`, empty ? null : `IF(K${t}=0,"",(K${t}-L${t})/K${t})`, sell === 0 ? '' : (sell - cost) / sell, '0.0%');
  put(`N${t}`, empty ? null : `ROUND(SUM(N${first}:N${last}),2)`, Number(quote.vatAmount), '#,##0.00');
  ws.getRow(t).font = { bold: true };
  ws.getRow(t).border = { top: { style: 'thin', color: { argb: 'FF0A0A0A' } } };

  const summary: Array<[string, string, number, string]> = [
    ['Subtotal', `K${t}`, sell, '#,##0.00'],
    ['Discount', `ROUND(K${t}*$G$4,2)`, Number(quote.discountAmt), '#,##0.00'],
    ['Net', `ROUND(K${t + 2}-K${t + 3},2)`, net, '#,##0.00'],
    ['VAT', `N${t}`, Number(quote.vatAmount), '#,##0.00'],
    ['Total', `ROUND(K${t + 4}+K${t + 5},2)`, Number(quote.total), '#,##0.00'],
    ['Margin', `ROUND(K${t + 4}-L${t},2)`, Number(quote.marginAmount), '#,##0.00'],
  ];
  summary.forEach(([label, formula, value, fmt], i) => {
    const r = t + 2 + i;
    Object.assign(ws.getCell(`J${r}`), { value: label, font: { bold: label === 'Total' }, alignment: { horizontal: 'right' } });
    put(`K${r}`, formula, value, fmt);
    if (label === 'Total') ws.getCell(`K${r}`).font = { bold: true };
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
