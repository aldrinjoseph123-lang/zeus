import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { readVendorQuote, rowsFromText } from '../services/vendorQuote.js';

/**
 * Reading a vendor's quote in, part 2 of the worksheet.
 *
 * One quote, as it arrives in every format a vendor sends: a distributor's Fortinet quote in
 * dollars, two part-numbered lines and one service with no part number, a subtotal and a grand
 * total. Whatever the format, the same three lines must come out, adding up to the total the
 * vendor printed — that equality is what the review screen leans on to say nothing was missed.
 */
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-vendor-quotes-'));
const { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } = await import('./harness.js');

let app: FastifyInstance;
let fx: Awaited<ReturnType<typeof seedFixtures>>;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

const HEADER = ['Part Number', 'Description', 'Qty', 'Unit Price', 'Total'];
const LINES = [
  ['FG-3100F-BDL-950-12', 'FortiGate-3100F Hardware plus 1 Year UTP', '2', '1,250.00', '2,500.00'],
  ['FC-10-F31HF-950-02-12', 'Unified Threat Protection renewal', '2', '410.00', '820.00'],
  ['', 'FortiCare onboarding', '1', '300.00', '300.00'],
];
const FOOTER = [['', 'Subtotal', '', '', '3,620.00'], ['', 'Grand Total (USD)', '', '', '3,620.00']];

/** Fixed-width text, the way a PDF comes out of pdftotext -layout. */
const layout = (cells: string[]) => [cells[0].padEnd(24), cells[1].padEnd(44), cells[2].padStart(4), cells[3].padStart(12), cells[4].padStart(12)].join('  ');
const DOCUMENT = ['Westcon Gulf FZE                Quotation WG-88123   Date 12/09/2026', '', layout(HEADER), ...LINES.map(layout), ...FOOTER.map(layout), '', 'Valid 30 days. Call +971 4 123 4567'];

const formats: Record<string, () => Promise<Buffer>> = {
  txt: async () => Buffer.from([HEADER, ...LINES, ...FOOTER].map((r) => r.join('\t')).join('\n')),
  csv: async () => Buffer.from([HEADER, ...LINES, ...FOOTER].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')),
  xlsx: async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Quote');
    [HEADER, ...LINES, ...FOOTER].forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  },
  docx: async () => {
    const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t.replace(/&/g, '&amp;')}</w:t></w:r></w:p></w:tc>`;
    const table = `<w:tbl>${[HEADER, ...LINES, ...FOOTER].map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('')}</w:tbl>`;
    const xml = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>`
      + `<w:p><w:r><w:t>Westcon Gulf FZE — Quotation WG-88123</w:t></w:r></w:p>${table}<w:p><w:r><w:t>Valid 30 days.</w:t></w:r></w:p></w:body></w:document>`;
    const zip = new JSZip();
    zip.file('word/document.xml', xml);
    return zip.generateAsync({ type: 'nodebuffer' });
  },
  pdf: () => new Promise<Buffer>((resolve) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.font('Courier').fontSize(8);
    DOCUMENT.forEach((line, i) => doc.text(line, 30, 40 + i * 12, { lineBreak: false }));
    doc.end();
  }),
};

function multipart(fields: Record<string, string>, name: string, content: Buffer) {
  const boundary = `ZeusVendorQuote${Math.random().toString(16).slice(2)}`;
  const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), boundary };
}

async function attach(user: { cookie: string }, quoteId: string, name: string, content: Buffer) {
  const { payload, boundary } = multipart({ parent: 'quote', parentId: quoteId }, name, content);
  const res = await app.inject({ method: 'POST', url: '/api/attachments', headers: { cookie: user.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  return { status: res.statusCode, body: JSON.parse(res.body) as { id: string; error?: string } };
}

/** Read a file as the review screen does: nothing stored, nothing attached. */
async function readIt(user: { cookie: string }, name: string, content: Buffer) {
  const { payload, boundary } = multipart({}, name, content);
  const res = await app.inject({ method: 'POST', url: '/api/quotes/vendor-quote/read', headers: { cookie: user.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
  return { status: res.statusCode, body: JSON.parse(res.body) as unknown };
}

async function quote(preparedBy = fx.admin) {
  return prisma.quote.create({ data: { number: `ZEU-Q-VQ${Math.random().toString(36).slice(2, 7)}`, accountId: fx.customer.id, preparedById: preparedBy.id } });
}

interface Read { currency: string | null; documentTotal: number | null; lines: Array<{ vendorCode: string | null; description: string; quantity: number; unitPrice: number; confident: boolean }> }

describe('every format gives the same three lines', () => {
  for (const [ext, build] of Object.entries(formats)) {
    it(`.${ext}`, async () => {
      const res = await readIt(fx.admin, `westcon-quote.${ext}`, await build());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const read = res.body as Read;

      assert.deepEqual(read.lines.map((l) => l.vendorCode), ['FG-3100F-BDL-950-12', 'FC-10-F31HF-950-02-12', null]);
      assert.deepEqual(read.lines.map((l) => [l.quantity, l.unitPrice]), [[2, 1250], [2, 410], [1, 300]]);
      assert.equal(read.lines[2].description, 'FortiCare onboarding', 'a line with no part number keeps its own words, not the next column');
      assert.ok(read.lines.every((l) => l.confident), 'every line multiplies out to its own total');
      assert.equal(read.currency, 'USD');
      assert.equal(read.documentTotal, 3620, 'the grand total, not the subtotal and not a phone number');
      assert.equal(read.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0), read.documentTotal, 'nothing dropped, nothing added');
    });
  }
});

describe('what cannot be read says so', () => {
  it('a PDF with no text in it — a scan', async () => {
    const scan = await new Promise<Buffer>((resolve) => {
      const doc = new PDFDocument();
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.rect(50, 50, 200, 100).fill('#999999');
      doc.end();
    });
    const res = await readIt(fx.admin, 'scanned.pdf', scan);
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /scan/);
  });

  it('a format Zeus does not read', async () => {
    const res = await readIt(fx.admin, 'photo.png', Buffer.from('not really a png'));
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /Excel, CSV, Word, PDF or text/);
  });
});

describe('a vendor document carries buy prices', () => {
  it('a rep can neither attach one, list them, open one, nor read one in', async () => {
    const q = await quote(fx.rep);
    const stored = await attach(fx.admin, q.id, 'westcon.txt', await formats.txt());
    assert.equal((await attach(fx.rep, q.id, 'mine.txt', Buffer.from('x'))).status, 403);
    assert.equal((await request(app, fx.rep).get(`/api/attachments?parent=quote&parentId=${q.id}`)).status, 403);
    assert.equal((await request(app, fx.rep).get(`/api/attachments/${stored.body.id}/download`)).status, 403);
    assert.equal((await readIt(fx.rep, 'westcon.txt', await formats.txt())).status, 403);
  });

  it('and it never lands on the account, where anyone on the account would see it', async () => {
    const q = await quote();
    await attach(fx.admin, q.id, 'westcon.txt', await formats.txt());
    const onAccount = (await request(app, fx.rep).get(`/api/attachments?parent=account&parentId=${fx.customer.id}`)).body as unknown[];
    assert.equal(onAccount.length, 0);
  });

  it('reading one stores nothing — keeping it is the attachment\'s job', async () => {
    await readIt(fx.admin, 'westcon.txt', await formats.txt());
    assert.equal(await prisma.attachment.count(), 0);
  });
});

describe('reading without headers', () => {
  it('numbers from the right: three that multiply out are a line, fewer are offered to check', () => {
    const read = readVendorQuote(rowsFromText('EDR-ENT-1Y endpoint licence  100  42.00  4,200.00\nInstallation  1  3,500.00\nMeeting on 12/09/2026 at 10\nTel  +971 4 123 4567'));
    assert.deepEqual(read.lines.map((l) => [l.vendorCode, l.quantity, l.unitPrice, l.confident]), [['EDR-ENT-1Y', 100, 42, true], [null, 1, 3500, false]]);
    assert.equal(read.documentTotal, null, 'no total printed, so none is claimed');
  });
});
