import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../db.js';
import { audit, undoHardDelete } from '../lib/audit.js';
import { badRequest, clientIp, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { maskFields } from '../auth/rbac.js';
import { nextReference } from '../lib/counters.js';
import { formatAed, round2 } from '../lib/money.js';
import { getSetting, vatRate } from '../lib/settings.js';
import { complianceGaps, recalcInvoice, snapshotParties } from '../lib/commercial.js';
import { invoicePdf, type InvoicePdfData } from '../services/pdf.js';
import { sendMail } from '../services/graph.js';
import { emailTemplate } from '../services/notify.js';
import { touch } from '../lib/touch.js';
import { approvalRequired, blockedReason } from '../services/approvals.js';
import { createFromInvoice } from '../services/renewals.js';

const lineSchema = z.object({
  productId: z.string().optional().nullable(),
  description: z.string().min(1, 'Every line needs a description.'),
  quantity: z.number().positive('Quantity must be greater than zero.').default(1),
  unit: z.string().default('licence'),
  unitPrice: z.number().default(0),
  unitCost: z.number().nonnegative().default(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxable: z.boolean().default(true),
  vatRate: z.number().min(0).max(100).default(5),
  termMonths: z.number().int().positive().optional().nullable(),
});

const invoiceSchema = z.object({
  accountId: z.string().min(1, 'Pick the customer.'),
  contactId: z.string().optional().nullable(),
  dealId: z.string().optional().nullable(),
  quoteId: z.string().optional().nullable(),
  customerPoId: z.string().optional().nullable(),
  issueDate: z.string().optional(),
  supplyDate: z.string().optional().nullable(),
  dueDate: z.string().optional().nullable(),
  currency: z.string().optional(),
  exchangeRate: z.number().positive().optional().nullable(),
  discountPct: z.number().min(0).max(100).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  placeOfSupply: z.string().optional().nullable(),
  reverseCharge: z.boolean().optional(),
  poNumber: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  lines: z.array(lineSchema).optional(),
});

const include = {
  account: true,
  contact: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
  deal: { select: { id: true, reference: true, name: true } },
  quote: { select: { id: true, number: true } },
  customerPo: { select: { id: true, number: true, orderDate: true } },
  originalInvoice: { select: { id: true, number: true, issueDate: true, total: true } },
  creditNotes: { select: { id: true, number: true, total: true, status: true, issueDate: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  lines: { orderBy: { order: 'asc' as const } },
  payments: { orderBy: { paidAt: 'desc' as const }, include: { recordedBy: { select: { name: true } } } },
  approvalRequestedBy: { select: { id: true, name: true } },
  approvalDecidedBy: { select: { id: true, name: true } },

};

/** A posted document is a filed tax record — its figures must not move. */
const POSTED = new Set(['SENT', 'PARTIAL', 'PAID', 'OVERDUE']);

export default async function invoiceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/invoices', { preHandler: requirePermission('invoices', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'issueDate');
    const f = params.filters;

    const where: Record<string, unknown> = {};
    where.type = f.type ?? 'TAX_INVOICE';
    if (f.type === 'ALL') delete where.type;
    if (f.status) where.status = f.status;
    if (f.accountId) where.accountId = f.accountId;
    if (f.dealId) where.dealId = f.dealId;
    if (f.overdue === 'true') {
      where.status = { in: ['SENT', 'PARTIAL', 'OVERDUE'] };
      where.dueDate = { lt: new Date() };
    }
    if (f.dueBefore) where.dueDate = { lte: new Date(f.dueBefore) };
    if (f.from || f.to) {
      where.issueDate = { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) };
    }
    if (params.search) {
      where.OR = [
        { number: { contains: params.search, mode: 'insensitive' } },
        { poNumber: { contains: params.search, mode: 'insensitive' } },
        { account: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total, sums] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          account: { select: { id: true, name: true, trn: true } },
          deal: { select: { id: true, reference: true } },
          originalInvoice: { select: { id: true, number: true } },
        },
        orderBy: orderBy(params, ['number', 'issueDate', 'dueDate', 'total', 'status'], 'issueDate'),
        skip: params.skip,
        take: params.take,
      }),
      prisma.invoice.count({ where }),
      prisma.invoice.aggregate({ where, _sum: { total: true, amountPaid: true, vatAmount: true } }),
    ]);

    return {
      ...paged(maskFields(request.user, 'invoices', data), total, params),
      totals: {
        invoiced: round2(num(sums._sum.total)),
        vat: round2(num(sums._sum.vatAmount)),
        received: round2(num(sums._sum.amountPaid)),
        // Summing floats drifts; money leaving the API is always rounded to fils.
        outstanding: round2(num(sums._sum.total) - num(sums._sum.amountPaid)),
      },
    };
  });

  app.get('/api/invoices/:id', { preHandler: requirePermission('invoices', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const invoice = await prisma.invoice.findUnique({ where: { id }, include });
    if (!invoice) throw notFound('Invoice not found.');
    return { ...maskFields(request.user, 'invoices', invoice), complianceGaps: await complianceGaps(id) };
  });

  app.post('/api/invoices', { preHandler: requirePermission('invoices', 'create') }, async (request, reply) => {
    const parsed = invoiceSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = parsed.data;

    const [defaultVat, termsDays, defaultTerms] = await Promise.all([
      vatRate(),
      getSetting<number>('finance.paymentTermsDays', 30),
      getSetting<string>('finance.invoiceTerms', ''),
    ]);

    const invoice = await prisma.invoice.create({
      data: {
        number: await nextReference('invoice'),
        type: 'TAX_INVOICE',
        accountId: body.accountId,
        contactId: body.contactId ?? null,
        dealId: body.dealId ?? null,
        quoteId: body.quoteId ?? null,
        customerPoId: body.customerPoId ?? null,
        issueDate: body.issueDate ? new Date(body.issueDate) : new Date(),
        supplyDate: body.supplyDate ? new Date(body.supplyDate) : null,
        dueDate: body.dueDate ? new Date(body.dueDate) : new Date(Date.now() + Number(termsDays) * 86_400_000),
        currency: body.currency ?? 'AED',
        exchangeRate: body.exchangeRate ?? null,
        discountPct: body.discountPct ?? 0,
        vatRate: body.vatRate ?? defaultVat,
        placeOfSupply: body.placeOfSupply ?? null,
        reverseCharge: body.reverseCharge ?? false,
        poNumber: body.poNumber ?? null,
        terms: body.terms ?? defaultTerms,
        notes: body.notes ?? null,
        createdById: request.user.id,
        lines: {
          create: (body.lines ?? []).map((line, index) => ({
            ...line,
            vatRate: line.taxable ? (line.vatRate ?? defaultVat) : 0,
            order: index,
          })),
        },
      },
    });

    await recalcInvoice(invoice.id);
    await touch({ accountId: body.accountId, dealId: body.dealId });
    await audit({ user: request.user, action: 'create', entity: 'Invoice', entityId: invoice.id, summary: invoice.number, ip: clientIp(request) });

    return reply.status(201).send(await prisma.invoice.findUnique({ where: { id: invoice.id }, include }));
  });

  app.patch('/api/invoices/:id', { preHandler: requirePermission('invoices', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.invoice.findUnique({ where: { id } });
    if (!existing) throw notFound('Invoice not found.');

    const parsed = invoiceSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const { lines, ...body } = parsed.data;

    // Once issued, the figures are a filed tax record. Only soft fields may move.
    if (POSTED.has(existing.status)) {
      const financial = ['lines', 'discountPct', 'vatRate', 'issueDate', 'currency', 'exchangeRate', 'accountId'];
      const attempted = financial.filter((k) => k === 'lines' ? lines !== undefined : (body as Record<string, unknown>)[k] !== undefined);
      if (attempted.length) {
        throw badRequest(
          `${existing.number} has already been issued, so its figures are locked. Raise a credit note to correct it, or cancel and reissue if it was never sent.`,
        );
      }
    }

    await prisma.invoice.update({
      where: { id },
      data: {
        ...body,
        issueDate: body.issueDate ? new Date(body.issueDate) : undefined,
        supplyDate: body.supplyDate !== undefined ? (body.supplyDate ? new Date(body.supplyDate) : null) : undefined,
        dueDate: body.dueDate !== undefined ? (body.dueDate ? new Date(body.dueDate) : null) : undefined,
      } as never,
    });

    if (lines) {
      const defaultVat = await vatRate();
      await prisma.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await prisma.invoiceLine.createMany({
        data: lines.map((line, index) => ({
          ...line,
          vatRate: line.taxable ? (line.vatRate ?? defaultVat) : 0,
          invoiceId: id,
          order: index,
        })),
      });
    }

    await recalcInvoice(id);
    await audit({ user: request.user, action: 'update', entity: 'Invoice', entityId: id, summary: existing.number, ip: clientIp(request) });
    return prisma.invoice.findUnique({ where: { id }, include });
  });

  /** Issue, cancel, or move an invoice's status. Issuing freezes the party details. */
  app.post('/api/invoices/:id/status', { preHandler: requirePermission('invoices', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const { status } = z.object({ status: z.enum(['DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED']) }).parse(request.body);

    const existing = await prisma.invoice.findUnique({ where: { id }, include: { payments: true } });
    if (!existing) throw notFound('Invoice not found.');

    if (status === 'CANCELLED' && existing.payments.length > 0) {
      throw badRequest('This invoice has payments recorded against it. Raise a credit note instead of cancelling.');
    }
    if (status === 'SENT' && existing.status === 'DRAFT') {
      // Issuing a tax invoice is the point of no return — the figures lock and only a
      // credit note can undo them. Manager signs it off first.
      const requirement = await approvalRequired('invoices', { total: existing.total });
      if (requirement.required && existing.approvalStatus !== 'APPROVED') {
        throw badRequest(
          blockedReason(existing, 'invoices')
            ?? `${existing.number} needs a sales manager's approval before it goes to the customer.${requirement.reason ? ` ${requirement.reason}` : ''}`,
        );
      }

      const blocking = (await complianceGaps(id)).filter((gap) => gap.blocking);
      if (blocking.length) throw badRequest(blocking[0].message);
      await snapshotParties(id);
    }

    // Issuing the invoice is the moment the customer owns what is on it, so termed
    // lines become entitlements with an expiry Zeus will chase.
    if (status === 'SENT' && existing.status === 'DRAFT' && (await getSetting<boolean>('renewals.autoCreateFromInvoice', true))) {
      const made = await createFromInvoice(id, request.user.id)
        .catch((err) => { console.error('[renewals] could not create entitlements:', (err as Error).message); return 0; });
      if (made) app.log.info(`created ${made} entitlement(s) from ${existing.number}`);
    }

    const invoice = await prisma.invoice.update({
      where: { id },
      data: { status, sentAt: status === 'SENT' && !existing.sentAt ? new Date() : undefined },
      include: { account: true },
    });

    await audit({ user: request.user, action: 'update', entity: 'Invoice', entityId: id, summary: `${invoice.number} → ${status}`, ip: clientIp(request) });
    return invoice;
  });

  /**
   * Raise a Tax Credit Note against an issued invoice.
   * Lines default to the original so a full reversal is one click; edit them down for
   * a partial credit.
   */
  app.post('/api/invoices/:id/credit-note', { preHandler: requirePermission('invoices', 'create') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      reason: z.string().min(1, 'A reason is required on a credit note.'),
      lines: z.array(lineSchema).optional(),
      issueDate: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const original = await prisma.invoice.findUnique({ where: { id }, include: { lines: { orderBy: { order: 'asc' } } } });
    if (!original) throw notFound('Invoice not found.');
    if (original.type !== 'TAX_INVOICE') throw badRequest('You can only credit a tax invoice.');
    if (original.status === 'DRAFT') throw badRequest('This invoice has not been issued yet — edit it directly instead of crediting it.');

    const lines = parsed.data.lines ?? original.lines.map((l) => ({
      productId: l.productId, description: l.description, quantity: num(l.quantity), unit: l.unit,
      unitPrice: num(l.unitPrice), unitCost: num(l.unitCost), discountPct: num(l.discountPct),
      taxable: l.taxable, vatRate: num(l.vatRate), termMonths: l.termMonths,
    }));

    const note = await prisma.invoice.create({
      data: {
        number: await nextReference('creditNote'),
        type: 'CREDIT_NOTE',
        originalInvoiceId: original.id,
        creditReason: parsed.data.reason,
        accountId: original.accountId,
        contactId: original.contactId,
        dealId: original.dealId,
        quoteId: original.quoteId,
        issueDate: parsed.data.issueDate ? new Date(parsed.data.issueDate) : new Date(),
        currency: original.currency,
        exchangeRate: original.exchangeRate,
        discountPct: original.discountPct,
        vatRate: original.vatRate,
        placeOfSupply: original.placeOfSupply,
        reverseCharge: original.reverseCharge,
        // A credit note carries the same parties as the invoice it corrects.
        supplierName: original.supplierName, supplierTrn: original.supplierTrn, supplierAddress: original.supplierAddress,
        recipientName: original.recipientName, recipientTrn: original.recipientTrn, recipientAddress: original.recipientAddress,
        createdById: request.user.id,
        lines: { create: lines.map((line, index) => ({ ...line, order: index })) },
      },
    });

    await recalcInvoice(note.id);
    if (!note.supplierTrn) await snapshotParties(note.id);
    // Crediting changes what is collectable on the original.
    await recalcInvoice(original.id);

    await audit({
      user: request.user, action: 'create', entity: 'Invoice', entityId: note.id,
      summary: `Credit note ${note.number} against ${original.number} — ${parsed.data.reason}`, ip: clientIp(request),
    });

    return reply.status(201).send(await prisma.invoice.findUnique({ where: { id: note.id }, include }));
  });

  app.get('/api/invoices/:id/pdf', { preHandler: requirePermission('invoices', 'read') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const invoice = await prisma.invoice.findUnique({ where: { id }, include });
    if (!invoice) throw notFound('Invoice not found.');

    const pdf = await invoicePdf(invoice as unknown as InvoicePdfData);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${invoice.number}.pdf"`)
      .send(pdf);
  });

  app.post('/api/invoices/:id/send', { preHandler: requirePermission('invoices', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      to: z.array(z.string().email()).min(1, 'Add at least one recipient.'),
      cc: z.array(z.string().email()).optional(),
      subject: z.string().optional(),
      message: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const invoice = await prisma.invoice.findUnique({ where: { id }, include });
    if (!invoice) throw notFound('Invoice not found.');

    if (invoice.status === 'DRAFT') await snapshotParties(id);
    const fresh = await prisma.invoice.findUnique({ where: { id }, include });
    const label = fresh!.type === 'CREDIT_NOTE' ? 'Tax Credit Note' : 'Tax Invoice';

    const pdf = await invoicePdf(fresh as unknown as InvoicePdfData);
    const subject = parsed.data.subject ?? `${label} ${fresh!.number} — ${fresh!.account.name}`;

    await sendMail({
      to: parsed.data.to,
      cc: parsed.data.cc,
      subject,
      html: emailTemplate(
        subject,
        parsed.data.message ?? `Please find attached ${label.toLowerCase()} ${fresh!.number} for ${formatAed(num(fresh!.total))}.`,
        undefined,
        [
          { title: label, value: fresh!.number },
          { title: 'Amount', value: formatAed(num(fresh!.total)) },
          ...(fresh!.dueDate ? [{ title: 'Due', value: new Date(fresh!.dueDate).toLocaleDateString('en-GB') }] : []),
        ],
      ),
      attachments: [{ filename: `${fresh!.number}.pdf`, contentBytes: pdf.toString('base64'), contentType: 'application/pdf' }],
    });

    await prisma.invoice.update({
      where: { id },
      data: { status: fresh!.status === 'DRAFT' ? 'SENT' : fresh!.status, sentAt: fresh!.sentAt ?? new Date() },
    });
    await prisma.activity.create({
      data: {
        type: 'EMAIL',
        subject: `Sent ${label.toLowerCase()} ${fresh!.number}`,
        description: `To: ${parsed.data.to.join(', ')}`,
        status: 'Completed',
        completedAt: new Date(),
        accountId: fresh!.accountId,
        dealId: fresh!.dealId,
        contactId: fresh!.contactId,
        ownerId: request.user.id,
        createdById: request.user.id,
      },
    });

    await audit({ user: request.user, action: 'send', entity: 'Invoice', entityId: id, summary: `${fresh!.number} emailed to ${parsed.data.to.join(', ')}`, ip: clientIp(request) });
    return { ok: true };
  });

  app.delete('/api/invoices/:id', { preHandler: requirePermission('invoices', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.invoice.findUnique({ where: { id }, include: { payments: true, creditNotes: true, lines: true } });
    if (!existing) throw notFound('Invoice not found.');
    if (existing.status !== 'DRAFT') {
      throw badRequest('Only a draft can be deleted. An issued tax document must be cancelled or credited so the number stays in the sequence.');
    }
    if (existing.payments.length || existing.creditNotes.length) throw badRequest('This invoice has payments or credit notes against it.');

    await prisma.invoice.delete({ where: { id } });
    const undoId = await audit({
      user: request.user, action: 'delete', entity: 'Invoice', entityId: id, summary: existing.number,
      undo: undoHardDelete('invoice', 'invoices', id, existing, { children: { lines: existing.lines } }),
      ip: clientIp(request),
    });
    return { ok: true, undoId };
  });

  /** Receivables ageing straight off the ledger, for the dashboard. */
  app.get('/api/invoices/ageing', { preHandler: requirePermission('invoices', 'read') }, async () => {
    const open = await prisma.invoice.findMany({
      where: { type: 'TAX_INVOICE', status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] } },
      select: { id: true, number: true, total: true, amountPaid: true, dueDate: true, account: { select: { id: true, name: true } } },
      orderBy: { dueDate: 'asc' },
    });

    const buckets = [
      { label: 'Not due', min: -Infinity, max: -1 },
      { label: '1-30 days', min: 0, max: 30 },
      { label: '31-60 days', min: 31, max: 60 },
      { label: '61-90 days', min: 61, max: 90 },
      { label: '90+ days', min: 91, max: Infinity },
    ].map((b) => ({ ...b, count: 0, amount: 0 }));

    for (const invoice of open) {
      const owed = num(invoice.total) - num(invoice.amountPaid);
      if (owed <= 0) continue;
      const daysLate = invoice.dueDate ? Math.floor((Date.now() - invoice.dueDate.getTime()) / 86_400_000) : 0;
      const bucket = buckets.find((b) => daysLate >= b.min && daysLate <= b.max);
      if (bucket) { bucket.count += 1; bucket.amount = round2(bucket.amount + owed); }
    }

    return {
      buckets: buckets.map(({ label, count, amount }) => ({ label, count, amount })),
      totalOutstanding: round2(open.reduce((s, i) => s + Math.max(0, num(i.total) - num(i.amountPaid)), 0)),
    };
  });
}
