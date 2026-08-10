import ExcelJS from 'exceljs';
import type { TableColumn } from './pdf.js';

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

/** Read the first sheet of an uploaded workbook (or CSV) into plain row objects. */
export async function readWorkbook(buffer: Buffer, filename: string): Promise<{ headers: string[]; rows: Array<Record<string, string>> }> {
  const wb = new ExcelJS.Workbook();
  if (filename.toLowerCase().endsWith('.csv')) {
    const text = buffer.toString('utf8');
    return parseCsv(text);
  }
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
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

  const clean = text.replace(/^﻿/, '');
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
