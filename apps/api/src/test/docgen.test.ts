import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateTestDatabase, prisma } from './harness.js';
import {
  quotePdf, invoicePdf, purchaseOrderPdf, tablePdf,
  type QuotePdfData, type InvoicePdfData, type PoPdfData, type TableColumn,
} from '../services/pdf.js';
import { tableXlsx, templateXlsx } from '../services/xlsx.js';

/**
 * Document generation, driven with hostile data. These generators run on whatever
 * a rep typed — long free-text terms, Arabic company names, emoji, punctuation that
 * happens to be illegal in a spreadsheet tab name — and a single throw here becomes
 * a 500 on "download PDF". The bar is: never throw, always return a real file.
 */

// A string designed to break things: RTL, emoji, markup, quotes, control chars.
const NASTY = 'شركة 🚀 <script>alert(1)</script> & "quotes\' \t\n \\ /back A'.repeat(3);
const LONG = 'x'.repeat(5000);

function isPdf(buf: Buffer): boolean {
  return buf.length > 0 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}
function isXlsx(buf: Buffer): boolean {
  // xlsx is a zip; zip files start with "PK\x03\x04".
  return buf.length > 0 && buf[0] === 0x50 && buf[1] === 0x4b;
}

const account = {
  name: NASTY, trn: null, addressLine1: null, addressLine2: null,
  city: null, emirate: null, country: 'AE', poBox: null, phone: null, email: null,
};

function quote(over: Partial<QuotePdfData> = {}): QuotePdfData {
  return {
    number: 'Q-0001', version: 1, status: 'draft', issueDate: new Date(), validUntil: null,
    currency: 'AED', subtotal: 1000, discountPct: 0, discountAmt: 0, vatRate: 5, vatAmount: 50, total: 1050,
    terms: LONG, notes: NASTY, account, contact: null, preparedBy: null, deal: null,
    lines: [{ description: NASTY, quantity: 2, unit: 'ea', unitPrice: 500, discountPct: 0, lineTotal: 1000, taxable: true, termMonths: null }],
    ...over,
  };
}

function invoice(over: Partial<InvoicePdfData> = {}): InvoicePdfData {
  return {
    number: 'INV-0001', type: 'TAX_INVOICE', status: 'issued', issueDate: new Date(), supplyDate: null, dueDate: null,
    currency: 'AED', exchangeRate: 1, subtotal: 1000, discountPct: 0, discountAmt: 0, vatAmount: 50, total: 1050, amountPaid: 0,
    poNumber: null, terms: LONG, notes: NASTY, creditReason: null, reverseCharge: false, placeOfSupply: null,
    supplierName: NASTY, supplierTrn: null, supplierAddress: NASTY, recipientName: NASTY, recipientTrn: null, recipientAddress: null,
    account, contact: null, deal: null, originalInvoice: null, customerPo: null,
    lines: [{ description: NASTY, quantity: 1, unit: 'ea', unitPrice: 1000, discountPct: 0, taxable: true, vatRate: 5, lineTotal: 1000, lineVat: 50, termMonths: 12 }],
    ...over,
  };
}

function po(over: Partial<PoPdfData> = {}): PoPdfData {
  return {
    number: 'PO-0001', status: 'draft', orderDate: new Date(), expectedDate: null, paymentDueDate: null, paymentTermsDays: null,
    currency: 'AED', subtotal: 1000, discountPct: 0, discountAmt: 0, vatAmount: 50, total: 1050,
    shipToAddress: NASTY, terms: LONG, notes: NASTY,
    account, contact: null, deal: null, quote: null, owner: null,
    lines: [{ description: NASTY, quantity: 1, unit: 'ea', unitPrice: 1000, discountPct: 0, taxable: true, vatRate: 5, lineTotal: 1000, lineVat: 50, termMonths: null }],
    ...over,
  };
}

const columns: TableColumn[] = [
  { key: 'name', label: 'Name', format: 'text' },
  { key: 'amount', label: 'Amount', format: 'money', align: 'right' },
  { key: 'when', label: 'When', format: 'date' },
];

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });

describe('PDF generation survives hostile data', () => {
  it('quote: nasty strings, long terms, missing optionals', async () => {
    assert.ok(isPdf(await quotePdf(quote())));
  });

  it('quote: empty line list and null money fields', async () => {
    assert.ok(isPdf(await quotePdf(quote({ lines: [], subtotal: null, vatAmount: null, total: null }))));
  });

  it('invoice: tax invoice with everything awkward', async () => {
    assert.ok(isPdf(await invoicePdf(invoice())));
  });

  it('invoice: credit note with no original and empty lines', async () => {
    assert.ok(isPdf(await invoicePdf(invoice({ type: 'CREDIT_NOTE', creditReason: NASTY, lines: [] }))));
  });

  it('purchase order: nasty data, missing optionals', async () => {
    assert.ok(isPdf(await purchaseOrderPdf(po())));
  });

  it('table pdf: illegal-looking title and empty rows', async () => {
    assert.ok(isPdf(await tablePdf({ title: 'Deals: Q1/Q2 [draft] *?', columns, rows: [] })));
    assert.ok(isPdf(await tablePdf({ title: NASTY, columns, rows: [{ name: NASTY, amount: 12.5, when: new Date() }] })));
  });
});

describe('XLSX generation survives hostile data', () => {
  it('table: normal title and rows', async () => {
    assert.ok(isXlsx(await tableXlsx({ title: 'Deals report', columns, rows: [{ name: NASTY, amount: 10, when: new Date() }] })));
  });

  it('table: title with characters illegal in a sheet name', async () => {
    // Excel forbids : \ / ? * [ ] in a tab name; a report titled this way must not throw.
    assert.ok(isXlsx(await tableXlsx({ title: 'Deals: Q1/Q2 [draft] *?', columns, rows: [] })));
  });

  it('table: empty title', async () => {
    assert.ok(isXlsx(await tableXlsx({ title: '', columns, rows: [] })));
  });

  it('template: required and optional columns with long labels', async () => {
    assert.ok(isXlsx(await templateXlsx({
      title: 'Import: contacts/accounts [v2]',
      columns: [
        { label: LONG, required: true, type: 'text' },
        { label: 'Email', type: 'text', values: ['a', 'b'] },
        { label: 'When', type: 'date' },
      ],
    })));
  });
});
