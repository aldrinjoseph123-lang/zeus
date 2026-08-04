import { prisma, num } from '../db.js';
import { taxDocumentTotals, type TaxLineInput } from './money.js';
import { getSetting } from './settings.js';

/**
 * Shared money logic for tax invoices, credit notes and purchase orders.
 *
 * Two rules hold everywhere:
 *   1. Totals are recomputed from the lines on the server after every write. A client
 *      may show a live preview, but it never supplies the figures that get stored.
 *   2. `amountPaid` is derived by summing Payment rows, never typed. That is what makes
 *      a part-payment, an advance and a final settlement reconcile without manual maths.
 */

function toInput(line: {
  quantity: unknown; unitPrice: unknown; unitCost?: unknown;
  discountPct: unknown; taxable: boolean; vatRate: unknown;
}): TaxLineInput {
  return {
    quantity: num(line.quantity),
    unitPrice: num(line.unitPrice),
    unitCost: num(line.unitCost ?? 0),
    discountPct: num(line.discountPct),
    taxable: line.taxable,
    vatRate: num(line.vatRate),
  };
}

/** Recompute an invoice or credit note from its lines, then refresh its paid status. */
export async function recalcInvoice(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { lines: { orderBy: { order: 'asc' } } },
  });
  if (!invoice) return;

  const totals = taxDocumentTotals(invoice.lines.map(toInput), {
    headerDiscountPct: num(invoice.discountPct),
    defaultVatRate: num(invoice.vatRate),
  });

  await prisma.$transaction([
    ...invoice.lines.map((line, index) =>
      prisma.invoiceLine.update({
        where: { id: line.id },
        data: { lineTotal: totals.lines[index].lineTotal, lineVat: totals.lines[index].lineVat, lineCost: totals.lines[index].lineCost },
      }),
    ),
    prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        subtotal: totals.subtotal,
        discountAmt: totals.discountAmt,
        vatAmount: totals.vatAmount,
        total: totals.total,
      },
    }),
  ]);

  await refreshInvoicePayment(invoiceId);
}

/** Recompute a purchase order from its lines, then refresh its paid status. */
export async function recalcPurchaseOrder(poId: string): Promise<void> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { lines: { orderBy: { order: 'asc' } } },
  });
  if (!po) return;

  const totals = taxDocumentTotals(po.lines.map(toInput), {
    headerDiscountPct: num(po.discountPct),
    defaultVatRate: num(po.vatRate),
  });

  await prisma.$transaction([
    ...po.lines.map((line, index) =>
      prisma.purchaseOrderLine.update({
        where: { id: line.id },
        data: { lineTotal: totals.lines[index].lineTotal, lineVat: totals.lines[index].lineVat },
      }),
    ),
    prisma.purchaseOrder.update({
      where: { id: poId },
      data: {
        subtotal: totals.subtotal,
        discountAmt: totals.discountAmt,
        vatAmount: totals.vatAmount,
        total: totals.total,
      },
    }),
  ]);

  await refreshPurchaseOrderPayment(poId);
}

/**
 * Sum the payments against an invoice and move its status to match the money.
 * Credit notes raised against it reduce what is collectable, so they count as paid.
 */
export async function refreshInvoicePayment(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { payments: true, creditNotes: { where: { status: { not: 'CANCELLED' } } } },
  });
  if (!invoice) return;

  const received = invoice.payments.reduce((sum, p) => sum + num(p.amount), 0);
  const credited = invoice.creditNotes.reduce((sum, c) => sum + num(c.total), 0);
  const settled = received + credited;
  const total = num(invoice.total);

  // Don't drag a draft or cancelled document into a payment status.
  let status = invoice.status;
  if (invoice.status !== 'DRAFT' && invoice.status !== 'CANCELLED') {
    if (settled >= total && total > 0) status = 'PAID';
    else if (settled > 0) status = 'PARTIAL';
    else if (invoice.dueDate && invoice.dueDate < new Date()) status = 'OVERDUE';
    else status = 'SENT';
  }

  await prisma.invoice.update({ where: { id: invoiceId }, data: { amountPaid: settled, status } });
}

export async function refreshPurchaseOrderPayment(poId: string): Promise<void> {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId }, include: { payments: true } });
  if (!po) return;
  const paid = po.payments.reduce((sum, p) => sum + num(p.amount), 0);
  await prisma.purchaseOrder.update({ where: { id: poId }, data: { amountPaid: paid } });
}

/** Outstanding balance on either document type. */
export const outstanding = (total: unknown, paid: unknown): number => num(total) - num(paid);

/**
 * Freeze the legal party details onto an invoice at issue.
 * The FTA requires the invoice to show the parties as they were when it was issued;
 * editing the account later must not rewrite a document already filed.
 */
export async function snapshotParties(invoiceId: string): Promise<void> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { account: true } });
  if (!invoice || invoice.supplierTrn) return; // already frozen

  const [name, legalName, trn, line1, line2, city, emirate, country, poBox, placeOfSupply] = await Promise.all([
    getSetting<string>('company.name', ''),
    getSetting<string>('company.legalName', ''),
    getSetting<string>('company.trn', ''),
    getSetting<string>('company.addressLine1', ''),
    getSetting<string>('company.addressLine2', ''),
    getSetting<string>('company.city', ''),
    getSetting<string>('company.emirate', ''),
    getSetting<string>('company.country', ''),
    getSetting<string>('company.poBox', ''),
    getSetting<string>('company.placeOfSupply', ''),
  ]);

  const supplierAddress = [line1, line2, poBox ? `P.O. Box ${poBox}` : '', city, emirate, country]
    .filter(Boolean).join(', ');
  const a = invoice.account;
  const recipientAddress = [a.addressLine1, a.addressLine2, a.poBox ? `P.O. Box ${a.poBox}` : '', a.city, a.emirate, a.country]
    .filter(Boolean).join(', ');

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      supplierName: legalName || name,
      supplierTrn: trn,
      supplierAddress,
      recipientName: a.name,
      recipientTrn: a.trn,
      recipientAddress,
      placeOfSupply: invoice.placeOfSupply ?? placeOfSupply,
    },
  });
}

/** Warn the caller about anything the FTA expects that is missing before issue. */
export async function complianceGaps(invoiceId: string): Promise<string[]> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { account: true, lines: true },
  });
  if (!invoice) return [];

  const gaps: string[] = [];
  const companyTrn = invoice.supplierTrn ?? (await getSetting<string>('company.trn', ''));

  if (!companyTrn) gaps.push('Your own TRN is not set — add it in Settings → Company.');
  if (invoice.lines.length === 0) gaps.push('The document has no line items.');
  if (!invoice.account.trn && num(invoice.total) >= 10_000) {
    gaps.push(`${invoice.account.name} has no TRN on file. A full tax invoice above AED 10,000 must show the recipient's TRN.`);
  }
  if (invoice.currency !== 'AED' && !invoice.exchangeRate) {
    gaps.push(`Currency is ${invoice.currency} but no exchange rate is set — AED equivalents are required on the face of the invoice.`);
  }
  if (invoice.type === 'CREDIT_NOTE' && !invoice.originalInvoiceId) {
    gaps.push('A credit note must reference the tax invoice it corrects.');
  }
  return gaps;
}
