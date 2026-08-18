import PDFDocument from 'pdfkit';
import { getSettings } from '../lib/settings.js';
import { num } from '../db.js';

/**
 * PDF output in the Protect24x7 house style: black masthead, red rule, tight
 * uppercase labels. pdfkit's built-in Helvetica stands in for Chakra Petch so the
 * container stays free of font assets.
 */

const BLACK = '#0a0a0a';
const RED = '#e11d2e';
const GREY = '#6b6b6b';
const LINE = '#d8d8d4';
const SUNKEN = '#f6f6f4';

const PAGE = { size: 'A4' as const, margin: 40 };
const CONTENT_WIDTH = 595.28 - PAGE.margin * 2;

function toBuffer(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function money(value: number): string {
  return new Intl.NumberFormat('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function date(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function masthead(doc: PDFKit.PDFDocument, company: Record<string, unknown>, docTitle: string, docNumber: string): void {
  doc.rect(0, 0, 595.28, 74).fill(BLACK);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text('ZEUS', PAGE.margin, 24, { characterSpacing: 3 });
  doc.fillColor(RED).font('Helvetica-Bold').fontSize(19).text('.', PAGE.margin + 62, 24);
  doc.fillColor('#999999').font('Helvetica').fontSize(8)
    .text(String(company['company.name'] ?? 'Protect24x7').toUpperCase(), PAGE.margin, 48, { characterSpacing: 1.4 });

  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13)
    .text(docTitle.toUpperCase(), PAGE.margin, 24, { width: CONTENT_WIDTH, align: 'right', characterSpacing: 2 });
  doc.fillColor(RED).font('Helvetica').fontSize(10)
    .text(docNumber, PAGE.margin, 44, { width: CONTENT_WIDTH, align: 'right' });

  doc.rect(0, 74, 595.28, 2).fill(RED);
  doc.y = 96;
}

function label(doc: PDFKit.PDFDocument, text: string, x: number, y: number): void {
  doc.fillColor(GREY).font('Helvetica-Bold').fontSize(7).text(text.toUpperCase(), x, y, { characterSpacing: 1.2 });
}

export interface QuotePdfData {
  number: string;
  version: number;
  status: string;
  issueDate: Date;
  validUntil: Date | null;
  currency: string;
  subtotal: unknown;
  discountPct: unknown;
  discountAmt: unknown;
  vatRate: unknown;
  vatAmount: unknown;
  total: unknown;
  terms: string | null;
  notes: string | null;
  account: { name: string; trn: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null; emirate: string | null; country: string; poBox: string | null };
  contact: { firstName: string; lastName: string; email: string | null; phone: string | null } | null;
  preparedBy: { name: string; email: string; phone: string | null } | null;
  deal: { reference: string; name: string } | null;
  lines: Array<{ description: string; quantity: unknown; unit: string; unitPrice: unknown; discountPct: unknown; lineTotal: unknown; taxable: boolean; termMonths: number | null }>;
}

export async function quotePdf(quote: QuotePdfData): Promise<Buffer> {
  const company = await getSettings('company.');
  const finance = await getSettings('finance.');
  const doc = new PDFDocument({ ...PAGE, bufferPages: true });

  masthead(doc, company, 'Quotation', quote.number + (quote.version > 1 ? ` · v${quote.version}` : ''));

  // ── addresses ───────────────────────────────────────────────────────────────
  const top = doc.y;
  const colW = CONTENT_WIDTH / 2 - 12;

  label(doc, 'From', PAGE.margin, top);
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10).text(String(company['company.legalName'] ?? company['company.name'] ?? ''), PAGE.margin, top + 12);
  doc.fillColor(GREY).font('Helvetica').fontSize(8.5);
  const fromLines = [
    company['company.addressLine1'],
    company['company.addressLine2'],
    [company['company.poBox'] ? `P.O. Box ${company['company.poBox']}` : null, company['company.city']].filter(Boolean).join(', '),
    company['company.country'],
    company['company.trn'] ? `TRN ${company['company.trn']}` : null,
    company['company.phone'],
    company['company.email'],
  ].filter(Boolean).map(String);
  doc.text(fromLines.join('\n'), PAGE.margin, doc.y + 2, { width: colW, lineGap: 1.5 });
  const fromBottom = doc.y;

  const rightX = PAGE.margin + CONTENT_WIDTH / 2 + 12;
  label(doc, 'Bill to', rightX, top);
  doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(10).text(quote.account.name, rightX, top + 12, { width: colW });
  doc.fillColor(GREY).font('Helvetica').fontSize(8.5);
  const toLines = [
    quote.contact ? `Attn: ${quote.contact.firstName} ${quote.contact.lastName}` : null,
    quote.account.addressLine1,
    quote.account.addressLine2,
    [quote.account.poBox ? `P.O. Box ${quote.account.poBox}` : null, quote.account.city, quote.account.emirate].filter(Boolean).join(', '),
    quote.account.country,
    quote.account.trn ? `TRN ${quote.account.trn}` : null,
    quote.contact?.email,
    quote.contact?.phone,
  ].filter(Boolean).map(String);
  doc.text(toLines.join('\n'), rightX, doc.y + 2, { width: colW, lineGap: 1.5 });

  doc.y = Math.max(fromBottom, doc.y) + 18;

  // ── meta strip ──────────────────────────────────────────────────────────────
  const metaY = doc.y;
  doc.rect(PAGE.margin, metaY, CONTENT_WIDTH, 30).fill(SUNKEN);
  const meta: Array<[string, string]> = [
    ['Date', date(quote.issueDate)],
    ['Valid until', date(quote.validUntil)],
    ['Currency', quote.currency],
    ['Reference', quote.deal?.reference ?? '—'],
    ['Prepared by', quote.preparedBy?.name ?? '—'],
  ];
  meta.forEach(([k, v], i) => {
    const x = PAGE.margin + 12 + (CONTENT_WIDTH / meta.length) * i;
    label(doc, k, x, metaY + 6);
    doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(9).text(v, x, metaY + 16, { width: CONTENT_WIDTH / meta.length - 12 });
  });
  doc.y = metaY + 44;

  // ── line items ──────────────────────────────────────────────────────────────
  const cols = [
    { key: 'no', label: '#', w: 22, align: 'left' as const },
    { key: 'description', label: 'Description', w: CONTENT_WIDTH - 22 - 46 - 62 - 46 - 74, align: 'left' as const },
    { key: 'qty', label: 'Qty', w: 46, align: 'right' as const },
    { key: 'price', label: 'Unit price', w: 62, align: 'right' as const },
    { key: 'disc', label: 'Disc %', w: 46, align: 'right' as const },
    { key: 'total', label: 'Amount', w: 74, align: 'right' as const },
  ];

  const drawHeader = () => {
    const y = doc.y;
    doc.rect(PAGE.margin, y, CONTENT_WIDTH, 20).fill(BLACK);
    let x = PAGE.margin + 6;
    for (const col of cols) {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
        .text(col.label.toUpperCase(), x, y + 6.5, { width: col.w - 8, align: col.align, characterSpacing: 0.8 });
      x += col.w;
    }
    doc.y = y + 20;
  };

  drawHeader();

  quote.lines.forEach((line, index) => {
    if (doc.y > 690) {
      doc.addPage();
      doc.y = PAGE.margin;
      drawHeader();
    }
    const y = doc.y;
    const desc = line.termMonths ? `${line.description}\n${line.termMonths} month term` : line.description;
    const descHeight = doc.font('Helvetica').fontSize(8.5).heightOfString(desc, { width: cols[1].w - 8 });
    const rowH = Math.max(22, descHeight + 12);

    if (index % 2 === 1) doc.rect(PAGE.margin, y, CONTENT_WIDTH, rowH).fill(SUNKEN);

    const values = [
      String(index + 1),
      desc,
      `${money(num(line.quantity))} ${line.unit}`,
      money(num(line.unitPrice)),
      num(line.discountPct) ? `${num(line.discountPct)}%` : '—',
      money(num(line.lineTotal)),
    ];
    let x = PAGE.margin + 6;
    cols.forEach((col, i) => {
      doc.fillColor(i === 1 ? BLACK : GREY).font(i === 5 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
        .text(values[i], x, y + 6, { width: col.w - 8, align: col.align });
      x += col.w;
    });

    doc.moveTo(PAGE.margin, y + rowH).lineTo(PAGE.margin + CONTENT_WIDTH, y + rowH).lineWidth(0.5).stroke(LINE);
    doc.y = y + rowH;
  });

  // ── totals ──────────────────────────────────────────────────────────────────
  if (doc.y > 640) { doc.addPage(); doc.y = PAGE.margin; }
  doc.y += 12;
  const totalsX = PAGE.margin + CONTENT_WIDTH - 220;
  const rows: Array<[string, string, boolean]> = [
    ['Subtotal', `${quote.currency} ${money(num(quote.subtotal))}`, false],
    ...(num(quote.discountAmt) > 0
      ? [[`Discount (${num(quote.discountPct)}%)`, `-${quote.currency} ${money(num(quote.discountAmt))}`, false] as [string, string, boolean]]
      : []),
    [String(finance['finance.vatLabel'] ?? `VAT (${num(quote.vatRate)}%)`), `${quote.currency} ${money(num(quote.vatAmount))}`, false],
    ['Total', `${quote.currency} ${money(num(quote.total))}`, true],
  ];

  for (const [key, value, strong] of rows) {
    const y = doc.y;
    if (strong) {
      doc.rect(totalsX, y, 220, 26).fill(BLACK);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(key.toUpperCase(), totalsX + 10, y + 8.5, { characterSpacing: 1 });
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(value, totalsX + 10, y + 7, { width: 200, align: 'right' });
      doc.y = y + 26;
    } else {
      doc.fillColor(GREY).font('Helvetica').fontSize(9).text(key, totalsX + 10, y + 4);
      doc.fillColor(BLACK).font('Helvetica').fontSize(9).text(value, totalsX + 10, y + 4, { width: 200, align: 'right' });
      doc.y = y + 18;
    }
  }

  // ── terms & signature ───────────────────────────────────────────────────────
  doc.y += 20;
  if (doc.y > 640) { doc.addPage(); doc.y = PAGE.margin; }

  const termsText = quote.terms ?? String(finance['finance.quoteTerms'] ?? '');
  if (termsText) {
    label(doc, 'Terms & conditions', PAGE.margin, doc.y);
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(termsText, PAGE.margin, doc.y + 4, { width: CONTENT_WIDTH - 200, lineGap: 2 });
  }
  if (quote.notes) {
    doc.y += 8;
    label(doc, 'Notes', PAGE.margin, doc.y);
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(quote.notes, PAGE.margin, doc.y + 4, { width: CONTENT_WIDTH - 200, lineGap: 2 });
  }

  if (company['company.bankIban']) {
    doc.y += 12;
    label(doc, 'Bank details', PAGE.margin, doc.y);
    doc.fillColor(GREY).font('Helvetica').fontSize(8).text(
      [company['company.bankName'], `IBAN ${company['company.bankIban']}`, company['company.bankSwift'] ? `SWIFT ${company['company.bankSwift']}` : null]
        .filter(Boolean).join('  ·  '),
      PAGE.margin, doc.y + 4, { width: CONTENT_WIDTH - 200 },
    );
  }

  stampFooters(doc, `${company['company.name'] ?? 'Protect24x7'} · ${quote.number}`);
  return toBuffer(doc);
}

function stampFooters(doc: PDFKit.PDFDocument, left: string): void {
  // A4 is 841.89pt tall; a 40pt margin leaves 801.89pt of printable page. Text drawn
  // any lower than that has pdfkit silently start a fresh page to finish rendering it
  // — every document was quietly growing a near-blank trailing page from its own
  // footer. 782/790 sit comfortably inside the margin instead.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.moveTo(PAGE.margin, 782).lineTo(PAGE.margin + CONTENT_WIDTH, 782).lineWidth(0.5).stroke(LINE);
    doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text(left, PAGE.margin, 790, { width: CONTENT_WIDTH / 2 });
    doc.fillColor(GREY).font('Helvetica').fontSize(7.5)
      .text(`Page ${i + 1} of ${range.count}`, PAGE.margin + CONTENT_WIDTH / 2, 790, { width: CONTENT_WIDTH / 2, align: 'right' });
  }
}

export interface TableColumn {
  key: string;
  label: string;
  width?: number;
  align?: 'left' | 'right';
  format?: 'money' | 'date' | 'text' | 'percent';
}

/** Generic landscape table used by every report export. */
export async function tablePdf(opts: {
  title: string;
  subtitle?: string;
  columns: TableColumn[];
  rows: Array<Record<string, unknown>>;
  summary?: Array<[string, string]>;
}): Promise<Buffer> {
  const company = await getSettings('company.');
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32, bufferPages: true });
  const width = 841.89 - 64;

  doc.rect(0, 0, 841.89, 62).fill(BLACK);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(16).text('ZEUS', 32, 18, { characterSpacing: 3 });
  doc.fillColor(RED).font('Helvetica-Bold').fontSize(16).text('.', 85, 18);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(12).text(opts.title.toUpperCase(), 32, 18, { width, align: 'right', characterSpacing: 1.5 });
  doc.fillColor('#999999').font('Helvetica').fontSize(8)
    .text(opts.subtitle ?? `Generated ${new Date().toLocaleString('en-GB')}`, 32, 38, { width, align: 'right' });
  doc.rect(0, 62, 841.89, 2).fill(RED);
  doc.y = 80;

  if (opts.summary?.length) {
    const y = doc.y;
    doc.rect(32, y, width, 34).fill(SUNKEN);
    opts.summary.forEach(([k, v], i) => {
      const x = 32 + 12 + (width / opts.summary!.length) * i;
      label(doc, k, x, y + 7);
      doc.fillColor(BLACK).font('Helvetica-Bold').fontSize(11).text(v, x, y + 17);
    });
    doc.y = y + 48;
  }

  const totalDeclared = opts.columns.reduce((s, c) => s + (c.width ?? 0), 0);
  const flexCount = opts.columns.filter((c) => !c.width).length;
  const flexWidth = flexCount ? Math.max(60, (width - totalDeclared) / flexCount) : 0;
  const widths = opts.columns.map((c) => c.width ?? flexWidth);

  const header = () => {
    const y = doc.y;
    doc.rect(32, y, width, 18).fill(BLACK);
    let x = 32 + 6;
    opts.columns.forEach((col, i) => {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
        .text(col.label.toUpperCase(), x, y + 5.5, { width: widths[i] - 8, align: col.align ?? 'left', characterSpacing: 0.6, ellipsis: true, height: 10 });
      x += widths[i];
    });
    doc.y = y + 18;
  };
  header();

  const fmt = (value: unknown, format?: string): string => {
    if (value === null || value === undefined || value === '') return '—';
    if (format === 'money') return money(num(value));
    if (format === 'percent') return `${num(value).toFixed(1)}%`;
    if (format === 'date') return date(value as Date);
    return String(value);
  };

  opts.rows.forEach((row, index) => {
    if (doc.y > 540) { doc.addPage(); doc.y = 32; header(); }
    const y = doc.y;
    if (index % 2 === 1) doc.rect(32, y, width, 16).fill(SUNKEN);
    let x = 32 + 6;
    opts.columns.forEach((col, i) => {
      doc.fillColor(BLACK).font('Helvetica').fontSize(7.5)
        .text(fmt(row[col.key], col.format), x, y + 4.5, { width: widths[i] - 8, align: col.align ?? 'left', ellipsis: true, height: 10 });
      x += widths[i];
    });
    doc.y = y + 16;
  });

  doc.fillColor(GREY).font('Helvetica').fontSize(7.5).text(`${opts.rows.length} row(s)`, 32, doc.y + 8);

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.fillColor(GREY).font('Helvetica').fontSize(7)
      .text(`${company['company.name'] ?? 'Protect24x7'} · Zeus CRM · confidential`, 32, 560, { width });
    doc.fillColor(GREY).font('Helvetica').fontSize(7)
      .text(`Page ${i + 1} of ${range.count}`, 32, 560, { width, align: 'right' });
  }

  return toBuffer(doc);
}

// ── tax invoice / credit note ─────────────────────────────────────────────────

export interface TaxDocLine {
  description: string;
  quantity: unknown;
  unit: string;
  unitPrice: unknown;
  discountPct: unknown;
  taxable: boolean;
  vatRate: unknown;
  lineTotal: unknown;
  lineVat: unknown;
  termMonths: number | null;
}

/**
 * Which supplier TRN line a tax document gets.
 *
 * A draft is a preview, so filling in the current company details is helpful. Once
 * issued, the snapshot is evidence of what the customer was actually sent — a reprint
 * that quietly substitutes today's TRN shows a number that was never on their copy, so
 * it says the field was empty instead.
 */
export function supplierTrnLine(
  status: string,
  snapshot: string | null,
  currentTrn: string,
): { trn: string; line: string } {
  if (snapshot) return { trn: snapshot, line: `TRN ${snapshot}` };
  if (status === 'DRAFT') {
    return currentTrn ? { trn: currentTrn, line: `TRN ${currentTrn}` } : { trn: '', line: 'TRN not set' };
  }
  return { trn: '', line: 'TRN not recorded at issue' };
}

export interface InvoicePdfData {
  number: string;
  type: 'TAX_INVOICE' | 'CREDIT_NOTE';
  status: string;
  issueDate: Date;
  supplyDate: Date | null;
  dueDate: Date | null;
  currency: string;
  exchangeRate: unknown;
  subtotal: unknown;
  discountPct: unknown;
  discountAmt: unknown;
  vatAmount: unknown;
  total: unknown;
  amountPaid: unknown;
  poNumber: string | null;
  terms: string | null;
  notes: string | null;
  creditReason: string | null;
  reverseCharge: boolean;
  placeOfSupply: string | null;
  supplierName: string | null;
  supplierTrn: string | null;
  supplierAddress: string | null;
  recipientName: string | null;
  recipientTrn: string | null;
  recipientAddress: string | null;
  account: { name: string; trn: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null; emirate: string | null; country: string; poBox: string | null };
  contact: { firstName: string; lastName: string; email: string | null } | null;
  deal: { reference: string } | null;
  originalInvoice: { number: string; issueDate: Date } | null;
  customerPo: { number: string } | null;
  createdBy: { name: string } | null;
  lines: TaxDocLine[];
}

/**
 * UAE Tax Invoice / Tax Credit Note.
 *
 * Carries every field mandated by Article 59 of the Executive Regulations to Federal
 * Decree-Law No. 8 of 2017: the document title, both parties with their TRNs, a
 * sequential number, issue and supply dates, per-line description/quantity/unit
 * price/tax rate, the discount, and the tax and gross payable in AED. A credit note
 * additionally names the invoice it corrects and why.
 *
 * The FTA does not certify templates — it mandates content. This lays that content out
 * on the Zeus letterhead.
 */
export async function invoicePdf(doc: InvoicePdfData): Promise<Buffer> {
  const company = await getSettings('company.');
  const finance = await getSettings('finance.');
  const pdf = new PDFDocument({ ...PAGE, bufferPages: true });

  const isCredit = doc.type === 'CREDIT_NOTE';
  const title = isCredit ? 'Tax Credit Note' : 'Tax Invoice';

  masthead(pdf, company, title, doc.number);

  // ── parties ────────────────────────────────────────────────────────────────
  const top = pdf.y;
  const colW = CONTENT_WIDTH / 2 - 12;

  label(pdf, 'Supplier', PAGE.margin, top);
  pdf.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
    .text(doc.supplierName || String(company['company.legalName'] ?? company['company.name'] ?? ''), PAGE.margin, top + 12, { width: colW });
  pdf.fillColor(GREY).font('Helvetica').fontSize(8.5);
  const isDraft = doc.status === 'DRAFT';
  const { line: trnLine } = supplierTrnLine(doc.status, doc.supplierTrn, String(company['company.trn'] ?? ''));

  pdf.text(
    [
      doc.supplierAddress || (isDraft
        ? [company['company.addressLine1'], company['company.city'], company['company.country']].filter(Boolean).join(', ')
        : ''),
      trnLine,
      company['company.phone'],
      company['company.email'],
    ].filter(Boolean).map(String).join('\n'),
    PAGE.margin, pdf.y + 2, { width: colW, lineGap: 1.5 },
  );
  const leftBottom = pdf.y;

  const rightX = PAGE.margin + CONTENT_WIDTH / 2 + 12;
  label(pdf, isCredit ? 'Credit to' : 'Bill to', rightX, top);
  pdf.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
    .text(doc.recipientName || doc.account.name, rightX, top + 12, { width: colW });
  pdf.fillColor(GREY).font('Helvetica').fontSize(8.5);
  const recipientTrn = doc.recipientTrn ?? doc.account.trn;
  pdf.text(
    [
      doc.contact ? `Attn: ${doc.contact.firstName} ${doc.contact.lastName}` : null,
      doc.recipientAddress || [doc.account.addressLine1, doc.account.city, doc.account.emirate, doc.account.country].filter(Boolean).join(', '),
      recipientTrn ? `TRN ${recipientTrn}` : null,
      doc.contact?.email,
    ].filter(Boolean).map(String).join('\n'),
    rightX, pdf.y + 2, { width: colW, lineGap: 1.5 },
  );
  pdf.y = Math.max(leftBottom, pdf.y) + 18;

  // ── meta strip ─────────────────────────────────────────────────────────────
  const metaY = pdf.y;
  const meta: Array<[string, string]> = [
    [isCredit ? 'Credit note date' : 'Invoice date', date(doc.issueDate)],
    ...(doc.supplyDate ? ([['Date of supply', date(doc.supplyDate)]] as Array<[string, string]>) : []),
    ...(!isCredit && doc.dueDate ? ([['Payment due', date(doc.dueDate)]] as Array<[string, string]>) : []),
    ...(isCredit && doc.originalInvoice ? ([['Against invoice', doc.originalInvoice.number]] as Array<[string, string]>) : []),
    ['Currency', doc.currency],
    ...(doc.placeOfSupply ? ([['Place of supply', doc.placeOfSupply]] as Array<[string, string]>) : []),
    ...(doc.customerPo?.number ? ([['Your PO', doc.customerPo.number]] as Array<[string, string]>) : doc.poNumber ? ([['Your PO', doc.poNumber]] as Array<[string, string]>) : []),
    ['Prepared by', doc.createdBy?.name ?? '—'],
  ];
  const rows = Math.ceil(meta.length / 4);
  const stripHeight = rows * 30;
  pdf.rect(PAGE.margin, metaY, CONTENT_WIDTH, stripHeight).fill(SUNKEN);
  meta.forEach(([k, v], i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = PAGE.margin + 12 + (CONTENT_WIDTH / 4) * col;
    label(pdf, k, x, metaY + 6 + row * 30);
    pdf.fillColor(BLACK).font('Helvetica-Bold').fontSize(9)
      .text(v, x, metaY + 16 + row * 30, { width: CONTENT_WIDTH / 4 - 12, ellipsis: true, height: 11 });
  });
  pdf.y = metaY + stripHeight + 14;

  if (isCredit && doc.creditReason) {
    pdf.fillColor(RED).font('Helvetica-Bold').fontSize(8.5).text(`Reason for credit: ${doc.creditReason}`, PAGE.margin, pdf.y, { width: CONTENT_WIDTH });
    pdf.y += 10;
  }

  // ── line items, tax rate per line ──────────────────────────────────────────
  const cols = [
    { key: 'no', label: '#', w: 20, align: 'left' as const },
    // Widths sized for six-figure money at 8.5pt. Too narrow and PDFKit wraps the number
    // itself — a total printed as "151,248.0" over "0" on a tax invoice.
    { key: 'description', label: 'Description', w: CONTENT_WIDTH - 20 - 56 - 64 - 30 - 68 - 74, align: 'left' as const },
    { key: 'qty', label: 'Qty', w: 56, align: 'right' as const },
    { key: 'price', label: 'Unit price', w: 64, align: 'right' as const },
    { key: 'rate', label: 'VAT', w: 30, align: 'right' as const },
    { key: 'vat', label: 'VAT amt', w: 68, align: 'right' as const },
    { key: 'total', label: 'Amount', w: 74, align: 'right' as const },
  ];

  const drawHeader = () => {
    const y = pdf.y;
    pdf.rect(PAGE.margin, y, CONTENT_WIDTH, 20).fill(BLACK);
    let x = PAGE.margin + 5;
    for (const col of cols) {
      pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
        .text(col.label.toUpperCase(), x, y + 6.5, { width: col.w - 6, align: col.align, characterSpacing: 0.6 });
      x += col.w;
    }
    pdf.y = y + 20;
  };
  drawHeader();

  doc.lines.forEach((line, index) => {
    if (pdf.y > 660) { pdf.addPage(); pdf.y = PAGE.margin; drawHeader(); }
    const y = pdf.y;
    const desc = line.termMonths ? `${line.description}\n${line.termMonths} month term` : line.description;
    const descHeight = pdf.font('Helvetica').fontSize(8.5).heightOfString(desc, { width: cols[1].w - 6 });
    const rowH = Math.max(21, descHeight + 11);

    if (index % 2 === 1) pdf.rect(PAGE.margin, y, CONTENT_WIDTH, rowH).fill(SUNKEN);

    const values = [
      String(index + 1),
      desc,
      `${money(num(line.quantity))} ${line.unit}`,
      money(num(line.unitPrice)),
      line.taxable ? `${num(line.vatRate)}%` : '0%',
      money(num(line.lineVat)),
      money(num(line.lineTotal)),
    ];
    let x = PAGE.margin + 5;
    cols.forEach((col, i) => {
      pdf.fillColor(i === 1 ? BLACK : GREY).font(i === 6 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
        .text(values[i], x, y + 5.5, { width: col.w - 6, align: col.align });
      x += col.w;
    });
    pdf.moveTo(PAGE.margin, y + rowH).lineTo(PAGE.margin + CONTENT_WIDTH, y + rowH).lineWidth(0.5).stroke(LINE);
    pdf.y = y + rowH;
  });

  // ── totals ─────────────────────────────────────────────────────────────────
  if (pdf.y > 620) { pdf.addPage(); pdf.y = PAGE.margin; }
  pdf.y += 12;

  const totalsX = PAGE.margin + CONTENT_WIDTH - 230;
  const netAfterDiscount = num(doc.subtotal) - num(doc.discountAmt);
  const totalRows: Array<[string, string, boolean]> = [
    ['Subtotal', `${doc.currency} ${money(num(doc.subtotal))}`, false],
    ...(num(doc.discountAmt) > 0
      ? [[`Discount (${num(doc.discountPct)}%)`, `-${doc.currency} ${money(num(doc.discountAmt))}`, false] as [string, string, boolean]]
      : []),
    ['Taxable amount', `${doc.currency} ${money(netAfterDiscount)}`, false],
    ['Total VAT', `${doc.currency} ${money(num(doc.vatAmount))}`, false],
    [isCredit ? 'Total credited' : 'Total payable', `${doc.currency} ${money(num(doc.total))}`, true],
  ];

  for (const [key, value, strong] of totalRows) {
    const y = pdf.y;
    if (strong) {
      pdf.rect(totalsX, y, 230, 26).fill(BLACK);
      pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8.5).text(key.toUpperCase(), totalsX + 10, y + 9, { characterSpacing: 0.8 });
      pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(value, totalsX + 10, y + 7, { width: 210, align: 'right' });
      pdf.y = y + 26;
    } else {
      pdf.fillColor(GREY).font('Helvetica').fontSize(9).text(key, totalsX + 10, y + 4);
      pdf.fillColor(BLACK).font('Helvetica').fontSize(9).text(value, totalsX + 10, y + 4, { width: 210, align: 'right' });
      pdf.y = y + 17;
    }
  }

  if (!isCredit && num(doc.amountPaid) > 0) {
    const owed = num(doc.total) - num(doc.amountPaid);
    // Capture y first: text() moves the cursor, so reading pdf.y again for the value
    // put the figure on the line below its own label.
    const receivedY = pdf.y + 4;
    pdf.fillColor(GREY).font('Helvetica').fontSize(9).text('Received', totalsX + 10, receivedY);
    pdf.fillColor(BLACK).font('Helvetica').fontSize(9)
      .text(`-${doc.currency} ${money(num(doc.amountPaid))}`, totalsX + 10, receivedY, { width: 210, align: 'right' });
    pdf.y = receivedY + 13;

    const balanceY = pdf.y + 3;
    const tone = owed > 0 ? RED : '#1f8a4c';
    pdf.fillColor(tone).font('Helvetica-Bold').fontSize(9.5)
      .text(owed > 0 ? 'Balance due' : 'Paid in full', totalsX + 10, balanceY);
    pdf.fillColor(tone).font('Helvetica-Bold').fontSize(9.5)
      .text(`${doc.currency} ${money(Math.max(0, owed))}`, totalsX + 10, balanceY, { width: 210, align: 'right' });
    pdf.y = balanceY + 15;
  }

  // AED equivalents are required on the face when billing in another currency.
  if (doc.currency !== 'AED' && num(doc.exchangeRate) > 0) {
    const rate = num(doc.exchangeRate);
    pdf.y += 6;
    pdf.fillColor(GREY).font('Helvetica').fontSize(8)
      .text(
        `Exchange rate ${doc.currency} 1 = AED ${rate.toFixed(4)} · Taxable AED ${money(netAfterDiscount * rate)} · VAT AED ${money(num(doc.vatAmount) * rate)} · Total AED ${money(num(doc.total) * rate)}`,
        PAGE.margin, pdf.y, { width: CONTENT_WIDTH, align: 'right' },
      );
    pdf.y += 12;
  }

  if (doc.reverseCharge) {
    pdf.y += 6;
    const statement = String(finance['finance.reverseChargeStatement'] ?? 'The recipient is required to account for the VAT due on this supply.');
    const h = pdf.font('Helvetica-Bold').fontSize(8).heightOfString(statement, { width: CONTENT_WIDTH - 20 });
    pdf.rect(PAGE.margin, pdf.y, CONTENT_WIDTH, h + 14).fill('#fdecec');
    pdf.fillColor('#9e0e19').font('Helvetica-Bold').fontSize(8).text(statement, PAGE.margin + 10, pdf.y + 7, { width: CONTENT_WIDTH - 20 });
    pdf.y += h + 20;
  }

  // ── terms, notes, bank ─────────────────────────────────────────────────────
  pdf.y += 14;
  if (pdf.y > 660) { pdf.addPage(); pdf.y = PAGE.margin; }

  const termsText = doc.terms ?? String(finance['finance.invoiceTerms'] ?? '');
  if (termsText) {
    label(pdf, 'Terms', PAGE.margin, pdf.y);
    pdf.fillColor(GREY).font('Helvetica').fontSize(8).text(termsText, PAGE.margin, pdf.y + 4, { width: CONTENT_WIDTH * 0.62, lineGap: 2 });
  }
  if (doc.notes) {
    pdf.y += 8;
    label(pdf, 'Notes', PAGE.margin, pdf.y);
    pdf.fillColor(GREY).font('Helvetica').fontSize(8).text(doc.notes, PAGE.margin, pdf.y + 4, { width: CONTENT_WIDTH * 0.62, lineGap: 2 });
  }
  if (!isCredit && company['company.bankIban']) {
    pdf.y += 12;
    label(pdf, 'Remit to', PAGE.margin, pdf.y);
    pdf.fillColor(GREY).font('Helvetica').fontSize(8).text(
      [company['company.bankName'], `IBAN ${company['company.bankIban']}`, company['company.bankSwift'] ? `SWIFT ${company['company.bankSwift']}` : null]
        .filter(Boolean).join('  ·  '),
      PAGE.margin, pdf.y + 4, { width: CONTENT_WIDTH * 0.62 },
    );
  }

  stampFooters(pdf, `${company['company.name'] ?? 'Protect24x7'} · ${title} ${doc.number}`);
  return toBuffer(pdf);
}

// ── purchase order ────────────────────────────────────────────────────────────

export interface PoPdfData {
  number: string;
  status: string;
  orderDate: Date;
  expectedDate: Date | null;
  paymentDueDate: Date | null;
  paymentTermsDays: number | null;
  currency: string;
  subtotal: unknown;
  discountPct: unknown;
  discountAmt: unknown;
  vatAmount: unknown;
  total: unknown;
  shipToAddress: string | null;
  terms: string | null;
  notes: string | null;
  account: { name: string; trn: string | null; addressLine1: string | null; city: string | null; emirate: string | null; country: string; poBox: string | null; phone: string | null; email: string | null };
  contact: { firstName: string; lastName: string; email: string | null; phone: string | null } | null;
  deal: { reference: string } | null;
  quote: { number: string } | null;
  owner: { name: string } | null;
  lines: TaxDocLine[];
}

/** The purchase order you issue to a vendor. Not a tax document — no FTA content rules. */
export async function purchaseOrderPdf(po: PoPdfData): Promise<Buffer> {
  const company = await getSettings('company.');
  const pdf = new PDFDocument({ ...PAGE, bufferPages: true });

  masthead(pdf, company, 'Purchase Order', po.number);

  const top = pdf.y;
  const colW = CONTENT_WIDTH / 2 - 12;

  label(pdf, 'Supplier', PAGE.margin, top);
  pdf.fillColor(BLACK).font('Helvetica-Bold').fontSize(10).text(po.account.name, PAGE.margin, top + 12, { width: colW });
  pdf.fillColor(GREY).font('Helvetica').fontSize(8.5).text(
    [
      po.contact ? `Attn: ${po.contact.firstName} ${po.contact.lastName}` : null,
      [po.account.addressLine1, po.account.city, po.account.emirate, po.account.country].filter(Boolean).join(', '),
      po.account.trn ? `TRN ${po.account.trn}` : null,
      po.contact?.email ?? po.account.email,
      po.contact?.phone ?? po.account.phone,
    ].filter(Boolean).map(String).join('\n'),
    PAGE.margin, pdf.y + 2, { width: colW, lineGap: 1.5 },
  );
  const leftBottom = pdf.y;

  const rightX = PAGE.margin + CONTENT_WIDTH / 2 + 12;
  label(pdf, 'Deliver to', rightX, top);
  pdf.fillColor(BLACK).font('Helvetica-Bold').fontSize(10)
    .text(String(company['company.legalName'] ?? company['company.name'] ?? ''), rightX, top + 12, { width: colW });
  pdf.fillColor(GREY).font('Helvetica').fontSize(8.5).text(
    [
      po.shipToAddress || [company['company.addressLine1'], company['company.poBox'] ? `P.O. Box ${company['company.poBox']}` : null, company['company.city'], company['company.country']].filter(Boolean).join(', '),
      company['company.trn'] ? `TRN ${company['company.trn']}` : null,
      company['company.phone'],
    ].filter(Boolean).map(String).join('\n'),
    rightX, pdf.y + 2, { width: colW, lineGap: 1.5 },
  );
  pdf.y = Math.max(leftBottom, pdf.y) + 18;

  const metaY = pdf.y;
  pdf.rect(PAGE.margin, metaY, CONTENT_WIDTH, 30).fill(SUNKEN);
  const meta: Array<[string, string]> = [
    ['Order date', date(po.orderDate)],
    ['Required by', date(po.expectedDate)],
    ['Payment terms', po.paymentTermsDays !== null && po.paymentTermsDays !== undefined ? `${po.paymentTermsDays} days` : '—'],
    ['Raised by', po.owner?.name ?? '—'],
  ];
  meta.forEach(([k, v], i) => {
    const x = PAGE.margin + 12 + (CONTENT_WIDTH / meta.length) * i;
    label(pdf, k, x, metaY + 6);
    pdf.fillColor(BLACK).font('Helvetica-Bold').fontSize(9).text(v, x, metaY + 16, { width: CONTENT_WIDTH / meta.length - 12 });
  });
  pdf.y = metaY + 44;

  const cols = [
    { key: 'no', label: '#', w: 22, align: 'left' as const },
    { key: 'description', label: 'Description', w: CONTENT_WIDTH - 22 - 52 - 66 - 46 - 74, align: 'left' as const },
    { key: 'qty', label: 'Qty', w: 52, align: 'right' as const },
    { key: 'price', label: 'Unit price', w: 66, align: 'right' as const },
    { key: 'rate', label: 'VAT', w: 46, align: 'right' as const },
    { key: 'total', label: 'Amount', w: 74, align: 'right' as const },
  ];

  const drawHeader = () => {
    const y = pdf.y;
    pdf.rect(PAGE.margin, y, CONTENT_WIDTH, 20).fill(BLACK);
    let x = PAGE.margin + 6;
    for (const col of cols) {
      pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
        .text(col.label.toUpperCase(), x, y + 6.5, { width: col.w - 8, align: col.align, characterSpacing: 0.8 });
      x += col.w;
    }
    pdf.y = y + 20;
  };
  drawHeader();

  po.lines.forEach((line, index) => {
    if (pdf.y > 670) { pdf.addPage(); pdf.y = PAGE.margin; drawHeader(); }
    const y = pdf.y;
    const descHeight = pdf.font('Helvetica').fontSize(8.5).heightOfString(line.description, { width: cols[1].w - 8 });
    const rowH = Math.max(22, descHeight + 12);
    if (index % 2 === 1) pdf.rect(PAGE.margin, y, CONTENT_WIDTH, rowH).fill(SUNKEN);

    const values = [
      String(index + 1),
      line.description,
      `${money(num(line.quantity))} ${line.unit}`,
      money(num(line.unitPrice)),
      line.taxable ? `${num(line.vatRate)}%` : '0%',
      money(num(line.lineTotal)),
    ];
    let x = PAGE.margin + 6;
    cols.forEach((col, i) => {
      pdf.fillColor(i === 1 ? BLACK : GREY).font(i === 5 ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
        .text(values[i], x, y + 6, { width: col.w - 8, align: col.align });
      x += col.w;
    });
    pdf.moveTo(PAGE.margin, y + rowH).lineTo(PAGE.margin + CONTENT_WIDTH, y + rowH).lineWidth(0.5).stroke(LINE);
    pdf.y = y + rowH;
  });

  if (pdf.y > 630) { pdf.addPage(); pdf.y = PAGE.margin; }
  pdf.y += 12;
  const totalsX = PAGE.margin + CONTENT_WIDTH - 220;
  const rows: Array<[string, string, boolean]> = [
    ['Subtotal', `${po.currency} ${money(num(po.subtotal))}`, false],
    ...(num(po.discountAmt) > 0 ? [[`Discount (${num(po.discountPct)}%)`, `− ${po.currency} ${money(num(po.discountAmt))}`, false] as [string, string, boolean]] : []),
    ['VAT', `${po.currency} ${money(num(po.vatAmount))}`, false],
    ['Order total', `${po.currency} ${money(num(po.total))}`, true],
  ];
  for (const [key, value, strong] of rows) {
    const y = pdf.y;
    if (strong) {
      pdf.rect(totalsX, y, 220, 26).fill(BLACK);
      pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(key.toUpperCase(), totalsX + 10, y + 8.5, { characterSpacing: 1 });
      pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(value, totalsX + 10, y + 7, { width: 200, align: 'right' });
      pdf.y = y + 26;
    } else {
      pdf.fillColor(GREY).font('Helvetica').fontSize(9).text(key, totalsX + 10, y + 4);
      pdf.fillColor(BLACK).font('Helvetica').fontSize(9).text(value, totalsX + 10, y + 4, { width: 200, align: 'right' });
      pdf.y = y + 18;
    }
  }

  pdf.y += 18;
  if (pdf.y > 650) { pdf.addPage(); pdf.y = PAGE.margin; }
  if (po.terms) {
    label(pdf, 'Terms', PAGE.margin, pdf.y);
    pdf.fillColor(GREY).font('Helvetica').fontSize(8).text(po.terms, PAGE.margin, pdf.y + 4, { width: CONTENT_WIDTH - 200, lineGap: 2 });
  }
  if (po.notes) {
    pdf.y += 8;
    label(pdf, 'Notes', PAGE.margin, pdf.y);
    pdf.fillColor(GREY).font('Helvetica').fontSize(8).text(po.notes, PAGE.margin, pdf.y + 4, { width: CONTENT_WIDTH - 200, lineGap: 2 });
  }

  pdf.y += 26;
  const sigY = Math.min(pdf.y, 720);
  pdf.moveTo(PAGE.margin, sigY).lineTo(PAGE.margin + 180, sigY).lineWidth(0.5).stroke(LINE);
  label(pdf, 'Authorised signature', PAGE.margin, sigY + 5);

  stampFooters(pdf, `${company['company.name'] ?? 'Protect24x7'} · Purchase Order ${po.number}`);
  return toBuffer(pdf);
}
