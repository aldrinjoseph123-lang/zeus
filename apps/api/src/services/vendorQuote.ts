/**
 * Reading a vendor's quote into worksheet lines, without sending it anywhere.
 *
 * Vendor quotes arrive as Excel, Word, PDF or text pasted out of an email, and no two lay out a
 * table the same way. This does not pretend to understand them. It finds the rows that look
 * like priced lines, says how sure it is about each, and hands them to a person to check —
 * nothing here writes to a quote. What makes that check fast is the document's own total: when
 * the lines found add up to the total the vendor printed, nothing was dropped.
 *
 * Every source is first reduced to rows of cells (see `rowsFromText`, and the readers in the
 * route), so the reading below is the same whatever the file was.
 */

export interface VendorLine {
  vendorCode: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number | null;
  /** The row it was read from, shown beside it in the review. */
  source: string;
  /** Quantity × unit price agreed with a total on the same row, or the table had headers. */
  confident: boolean;
}

export interface VendorQuote {
  currency: string | null;
  /** The total the vendor printed, when one could be found. */
  documentTotal: number | null;
  lines: VendorLine[];
}

/**
 * Text from an email or a PDF: a tab or a run of two spaces separates columns.
 *
 * Below a header row, cells are placed by where they sit on the line rather than by how many
 * came before them. A PDF drops an empty cell entirely, so counting would slide the quantity
 * into the description's column on any line with no part number. Each cell goes to the header
 * column its middle falls under, which also copes with numbers right-aligned under a heading.
 */
export function rowsFromText(text: string): string[][] {
  const split = (line: string) => [...line.matchAll(/[^\t]+?(?=\t| {2,}|$)/g)]
    .map((m) => ({ text: m[0].trim(), start: (m.index ?? 0) + (m[0].length - m[0].trimStart().length), end: (m.index ?? 0) + m[0].trimEnd().length }))
    .filter((c) => c.text);
  const lines = text.split(/\r?\n/).map(split).filter((cells) => cells.length > 0);

  // Copied out of Excel or Word, a tab is an exact column break, and an empty cell between two
  // tabs is a real empty column — keep it, or everything after it slides one column left.
  if (text.includes('\t')) {
    return text.split(/\r?\n/).map((line) => line.split('\t').map((c) => c.trim())).filter((cells) => cells.some(Boolean));
  }

  const headerAt = lines.findIndex((cells) => isHeader(cells.map((c) => c.text)));
  if (headerAt === -1) return lines.map((cells) => cells.map((c) => c.text));

  const header = lines[headerAt];
  const centres = header.map((c) => (c.start + c.end) / 2);
  const columnOf = (centre: number) => centres.reduce((best, h, i) => (Math.abs(h - centre) < Math.abs(centres[best] - centre) ? i : best), 0);
  return lines.map((cells, i) => {
    if (i <= headerAt) return cells.map((c) => c.text);
    const row = header.map(() => '');
    for (const c of cells) {
      const col = columnOf((c.start + c.end) / 2);
      row[col] = row[col] ? `${row[col]} ${c.text}` : c.text;
    }
    return row;
  });
}

const isHeader = (cells: string[]) => cells.filter((c) => Object.values(HEADERS).some((h) => h.test(c))).length >= 3;

/** A part number at the start of a cell that runs on into words: `EDR-ENT-1Y endpoint licence`. */
function leadingCode(cell: string): { code: string | null; rest: string } {
  const [first, ...rest] = cell.split(/\s+/);
  return CODE.test(first) ? { code: first, rest: rest.join(' ') } : { code: null, rest: cell };
}

/** A money-looking cell as a number: `1,250.00`, `USD 1,250`, `$1250`, `(12.50)`. Else null. */
export function amount(cell: string): number | null {
  const cleaned = cell.replace(/\b(USD|AED|EUR|GBP|SAR|INR)\b|[$€£]/gi, '').replace(/\s/g, '');
  if (!/^\(?-?\d{1,3}(,\d{3})*(\.\d+)?\)?$|^\(?-?\d+(\.\d+)?\)?$/.test(cleaned)) return null;
  const value = Number(cleaned.replace(/[(),]/g, ''));
  if (!Number.isFinite(value)) return null;
  return cleaned.startsWith('(') ? -value : value;
}

const CODE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9][A-Za-z0-9\-_./#+]{2,39}$/;
const HEADERS = {
  code: /^(part|part\s*(no|number|#)|p\/n|sku|item\s*(code|no\.?|#)|product\s*code|model|mfr.*|code)$/i,
  quantity: /^(qty|quantity|units?|no\.?\s*of\s*units)$/i,
  unitPrice: /^(unit\s*(price|cost)|price|rate|u\/p|unit\s*rate|list\s*price)(\s*\(.*\))?$/i,
  lineTotal: /^(total|amount|ext(\.|ended)?\s*price|line\s*total|net\s*(price|amount)|total\s*price)(\s*\(.*\))?$/i,
  description: /^(desc(ription)?|item|product|particulars|details|service)$/i,
};
const TOTAL_ROW = /\b(grand\s*total|total\s*(amount|value|price)?|sub\s*-?\s*total)\b/i;

const agrees = (quantity: number, unitPrice: number, total: number) => Math.abs(quantity * unitPrice - total) <= 0.011 * Math.max(1, quantity);

export function readVendorQuote(rows: string[][]): VendorQuote {
  const flat = rows.map((cells) => cells.join('  '));
  const currency = flat.join('\n').match(/\b(USD|AED|EUR|GBP|SAR|INR)\b/i)?.[1]?.toUpperCase()
    ?? (/\$/.test(flat.join('')) ? 'USD' : /€/.test(flat.join('')) ? 'EUR' : /£/.test(flat.join('')) ? 'GBP' : null);

  // The vendor's own bottom line. "Grand total" beats "total" beats "subtotal"; last row wins.
  let documentTotal: number | null = null;
  let totalRank = 0;
  rows.forEach((cells, i) => {
    const label = flat[i].match(TOTAL_ROW)?.[1]?.toLowerCase().replace(/\s|-/g, '');
    if (!label) return;
    const figures = cells.map(amount).filter((n): n is number => n !== null);
    if (figures.length === 0) return;
    const rank = label.startsWith('grand') ? 3 : label.startsWith('sub') ? 1 : 2;
    if (rank >= totalRank) { totalRank = rank; documentTotal = figures[figures.length - 1]; }
  });

  const lines = headedLines(rows) ?? rows.map((cells, i) => guessedLine(cells, flat[i])).filter((l): l is VendorLine => l !== null);
  return { currency, documentTotal, lines };
}

/** A table with a header row: read each column for what its header says it is. */
function headedLines(rows: string[][]): VendorLine[] | null {
  const at = rows.findIndex(isHeader);
  if (at === -1) return null;
  const header = rows[at];
  const column = (key: keyof typeof HEADERS) => header.findIndex((c) => HEADERS[key].test(c));
  const [quantity, unitPrice, lineTotal] = (['quantity', 'unitPrice', 'lineTotal'] as const).map(column);
  let [code, description] = (['code', 'description'] as const).map(column);
  if (unitPrice === -1 && lineTotal === -1) return null;

  // "Item" heads a part-number column as often as a description one; its contents decide.
  if (code === -1 && description !== -1) {
    const values = rows.slice(at + 1).map((r) => r[description] ?? '').filter(Boolean);
    if (values.length > 0 && values.filter((v) => CODE.test(v)).length / values.length >= 0.6) {
      code = description;
      description = -1;
    }
  }

  const lines: VendorLine[] = [];
  for (const cells of rows.slice(at + 1)) {
    const source = cells.join('  ');
    if (TOTAL_ROW.test(source) && (quantity === -1 || amount(cells[quantity] ?? '') === null)) continue;
    const qty = quantity === -1 ? 1 : amount(cells[quantity] ?? '');
    const total = lineTotal === -1 ? null : amount(cells[lineTotal] ?? '');
    const unit = unitPrice === -1 ? null : amount(cells[unitPrice] ?? '');
    if (qty === null || qty <= 0) continue;
    const price = unit ?? (total !== null ? total / qty : null);
    if (price === null) continue;
    const text = description === -1
      ? cells.filter((c, i) => i !== code && i !== quantity && i !== unitPrice && i !== lineTotal && amount(c) === null).join(' ')
      : cells[description] ?? '';
    const found = code === -1 ? leadingCode(text) : { code: cells[code] || null, rest: text };
    lines.push({
      vendorCode: found.code,
      description: found.rest || found.code || '',
      quantity: qty,
      unitPrice: price,
      lineTotal: total,
      source,
      confident: total === null || agrees(qty, price, total),
    });
  }
  return lines;
}

/**
 * No headers to go on — pasted text, or a PDF that came out as lines. Numbers are read from the
 * right, where vendors put them: quantity, unit price, total. Three that multiply out are a
 * line; anything less is offered unticked for someone to confirm.
 */
function guessedLine(cells: string[], source: string): VendorLine | null {
  if (TOTAL_ROW.test(source)) return null;
  const figures = cells.map((c, i) => ({ i, n: amount(c) })).filter((f): f is { i: number; n: number } => f.n !== null);
  const words = cells.filter((c) => amount(c) === null);
  if (words.length === 0 || figures.length === 0) return null;

  const whole = words.find((w) => CODE.test(w));
  const lead = whole ? null : leadingCode(words[0]);
  const code = whole ?? lead?.code ?? null;
  const description = whole ? words.filter((w) => w !== whole).join(' ') : [lead!.rest, ...words.slice(1)].filter(Boolean).join(' ');
  const [a, b, c] = figures.slice(-3).map((f) => f.n);

  if (figures.length >= 3 && agrees(a, b, c)) {
    return { vendorCode: code, description, quantity: a, unitPrice: b, lineTotal: c, source, confident: true };
  }
  if (figures.length >= 2) {
    const [qty, price] = figures.slice(-2).map((f) => f.n);
    if (Number.isInteger(qty) && qty > 0) {
      return { vendorCode: code, description, quantity: qty, unitPrice: price, lineTotal: null, source, confident: false };
    }
  }
  // A lone figure beside a part number is probably a price for one; a lone figure beside
  // prose is probably a date, a phone number or a page number, and is not offered.
  if (!code) return null;
  return { vendorCode: code, description, quantity: 1, unitPrice: figures[figures.length - 1].n, lineTotal: null, source, confident: false };
}

/** A file Zeus cannot read, with a sentence the person uploading it can act on. */
export class UnreadableVendorFile extends Error {}

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const xmlText = (xml: string) => xml
  .replace(/<w:tab\/>/g, '\t')
  .replace(/<\/w:p>/g, ' ')
  .replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<[^>]+>/g, (_m, text?: string) => text ?? '')
  .replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e]);

/**
 * Every format, reduced to rows of cells. Each reader keeps what the format already knows about
 * columns — Excel and Word tables have real cells; a PDF only has positions on a line, which
 * `pdftotext -layout` preserves and `rowsFromText` reads.
 */
export async function rowsFromFile(fullPath: string, filename: string): Promise<string[][]> {
  const { readFile } = await import('node:fs/promises');
  const ext = filename.toLowerCase().split('.').pop();

  if (ext === 'txt') return rowsFromText(await readFile(fullPath, 'utf8'));

  if (ext === 'csv') {
    const { parseCsv } = await import('./xlsx.js');
    const { headers, rows } = parseCsv(await readFile(fullPath, 'utf8'));
    return [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))];
  }

  if (ext === 'xlsx') {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await readFile(fullPath)) as never);
    const rows: string[][] = [];
    wb.worksheets[0]?.eachRow((row) => {
      rows.push(Array.from({ length: row.cellCount }, (_x, i) => row.getCell(i + 1).text.trim()));
    });
    return rows;
  }

  if (ext === 'docx') {
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(await readFile(fullPath));
    const xml = await zip.file('word/document.xml')?.async('string');
    if (!xml) throw new UnreadableVendorFile('That Word file has no document inside it. Save it again as .docx, or paste the table.');
    const rows: string[][] = [];
    // Tables and paragraphs in the order they appear, so a total under a table stays under it.
    for (const block of xml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p[\s>][\s\S]*?<\/w:p>/g) ?? []) {
      if (block.startsWith('<w:tbl')) {
        for (const tr of block.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []) {
          rows.push((tr.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) ?? []).map((tc) => xmlText(tc).replace(/\s+/g, ' ').trim()));
        }
      } else {
        rows.push(...rowsFromText(xmlText(block)));
      }
    }
    return rows;
  }

  if (ext === 'pdf') {
    const { execFile } = await import('node:child_process');
    const text = await new Promise<string>((resolve, reject) => {
      execFile('pdftotext', ['-layout', '-enc', 'UTF-8', fullPath, '-'], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
        if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
          reject(new UnreadableVendorFile('This server cannot read PDFs yet. Paste the table from the PDF, or upload the Excel version.'));
        } else if (err) {
          // A scanned PDF, or an encrypted one: there is no text to take out.
          reject(new UnreadableVendorFile('No text could be taken out of that PDF — it may be a scan. Paste the table, or ask the vendor for Excel.'));
        } else resolve(stdout);
      });
    });
    if (!text.trim()) throw new UnreadableVendorFile('That PDF has no text in it — it is probably a scan. Paste the table, or ask the vendor for Excel.');
    return rowsFromText(text);
  }

  throw new UnreadableVendorFile('Zeus reads vendor quotes from Excel, CSV, Word, PDF or text. Paste the table if it came another way.');
}
