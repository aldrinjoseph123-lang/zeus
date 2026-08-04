import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../db.js';
import { audit, undoHardDelete } from '../lib/audit.js';
import { badRequest, clientIp, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { refreshInvoicePayment, refreshPurchaseOrderPayment } from '../lib/commercial.js';
import { formatAed, round2 } from '../lib/money.js';
import { notify } from '../services/notify.js';
import { touch } from '../lib/touch.js';

/**
 * Money in and money out, as individual movements.
 *
 * INCOMING attaches to a customer invoice, OUTGOING to a supplier purchase order.
 * Balances on those documents are always recomputed from these rows, so a part-payment
 * or an advance reconciles without anybody editing a running total by hand.
 */

const paymentSchema = z.object({
  direction: z.enum(['INCOMING', 'OUTGOING']),
  amount: z.number().positive('A payment must be greater than zero.'),
  paidAt: z.string().optional(),
  method: z.string().optional(),
  reference: z.string().optional().nullable(),
  currency: z.string().optional(),
  notes: z.string().optional().nullable(),
  invoiceId: z.string().optional().nullable(),
  purchaseOrderId: z.string().optional().nullable(),
});

export default async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/payments', { preHandler: requirePermission('invoices', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'paidAt');
    const f = params.filters;

    const where: Record<string, unknown> = {};
    if (f.direction) where.direction = f.direction;
    if (f.accountId) where.accountId = f.accountId;
    if (f.invoiceId) where.invoiceId = f.invoiceId;
    if (f.purchaseOrderId) where.purchaseOrderId = f.purchaseOrderId;
    if (f.method) where.method = f.method;
    if (f.from || f.to) {
      where.paidAt = { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) };
    }
    if (params.search) {
      where.OR = [
        { reference: { contains: params.search, mode: 'insensitive' } },
        { account: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total, sums] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          account: { select: { id: true, name: true } },
          invoice: { select: { id: true, number: true, total: true } },
          purchaseOrder: { select: { id: true, number: true, total: true } },
          recordedBy: { select: { id: true, name: true } },
        },
        orderBy: orderBy(params, ['paidAt', 'amount', 'method'], 'paidAt'),
        skip: params.skip,
        take: params.take,
      }),
      prisma.payment.count({ where }),
      prisma.payment.groupBy({ by: ['direction'], where, _sum: { amount: true } }),
    ]);

    return {
      ...paged(data, total, params),
      totals: {
        incoming: round2(num(sums.find((s) => s.direction === 'INCOMING')?._sum.amount)),
        outgoing: round2(num(sums.find((s) => s.direction === 'OUTGOING')?._sum.amount)),
      },
    };
  });

  app.post('/api/payments', { preHandler: requirePermission('invoices', 'update') }, async (request, reply) => {
    const parsed = paymentSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = parsed.data;

    if (body.direction === 'INCOMING' && !body.invoiceId) throw badRequest('A receipt must be recorded against an invoice.');
    if (body.direction === 'OUTGOING' && !body.purchaseOrderId) throw badRequest('A payment out must be recorded against a purchase order.');

    let accountId: string;
    let label: string;
    let outstandingBefore: number;

    if (body.invoiceId) {
      const invoice = await prisma.invoice.findUnique({ where: { id: body.invoiceId } });
      if (!invoice) throw notFound('Invoice not found.');
      if (invoice.status === 'DRAFT') throw badRequest(`${invoice.number} has not been issued yet — issue it before recording a receipt.`);
      if (invoice.status === 'CANCELLED') throw badRequest(`${invoice.number} is cancelled.`);
      accountId = invoice.accountId;
      label = invoice.number;
      outstandingBefore = num(invoice.total) - num(invoice.amountPaid);
    } else {
      const po = await prisma.purchaseOrder.findFirst({ where: { id: body.purchaseOrderId!, deletedAt: null } });
      if (!po) throw notFound('Purchase order not found.');
      if (po.direction !== 'SUPPLIER') throw badRequest('You only pay against a supplier order. A customer order is money coming in, recorded on the invoice.');
      if (po.status === 'CANCELLED') throw badRequest(`${po.number} is cancelled.`);
      // A draft is not yet a commitment — and drafts are excluded from the payables
      // position, so paying one would make money vanish from the cash view.
      if (po.status === 'DRAFT') throw badRequest(`${po.number} is still a draft — issue it before recording a payment against it.`);
      accountId = po.accountId;
      label = po.number;
      outstandingBefore = num(po.total) - num(po.amountPaid);
    }

    // Overpayment is usually a typo. Allow it, but make it deliberate and audited.
    const overpayBy = Number((body.amount - outstandingBefore).toFixed(2));
    if (overpayBy > 0.009) {
      const confirm = (request.body as Record<string, unknown>).allowOverpayment === true;
      if (!confirm) {
        throw badRequest(
          `${formatAed(body.amount)} is more than the ${formatAed(outstandingBefore)} outstanding on ${label}. Confirm to record it anyway.`,
        );
      }
    }

    const payment = await prisma.payment.create({
      data: {
        direction: body.direction,
        amount: body.amount,
        currency: body.currency ?? 'AED',
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        method: body.method ?? 'Bank Transfer',
        reference: body.reference ?? null,
        notes: body.notes ?? null,
        accountId,
        invoiceId: body.invoiceId ?? null,
        purchaseOrderId: body.purchaseOrderId ?? null,
        recordedById: request.user.id,
      },
    });

    if (body.invoiceId) await refreshInvoicePayment(body.invoiceId);
    if (body.purchaseOrderId) await refreshPurchaseOrderPayment(body.purchaseOrderId);
    await touch({ accountId });

    await audit({
      user: request.user, action: 'payment', entity: 'Payment', entityId: payment.id,
      summary: `${body.direction === 'INCOMING' ? 'Received' : 'Paid'} ${formatAed(body.amount)} against ${label}`,
      ip: clientIp(request),
    });

    // Tell the owner when an invoice is fully settled — it closes the chase loop.
    if (body.invoiceId) {
      const settled = await prisma.invoice.findUnique({ where: { id: body.invoiceId }, include: { account: true, deal: true } });
      if (settled?.status === 'PAID') {
        await notify({
          event: 'invoice_paid',
          title: `Invoice paid — ${settled.number}`,
          body: `${settled.account.name} settled ${formatAed(num(settled.total))}.`,
          link: `/invoices/${settled.id}`,
          ownerId: settled.deal?.ownerId ?? settled.createdById,
          facts: [
            { title: 'Customer', value: settled.account.name },
            { title: 'Amount', value: formatAed(num(settled.total)) },
            { title: 'Method', value: payment.method },
          ],
        });
      }
    }

    return reply.status(201).send(payment);
  });

  app.delete('/api/payments/:id', { preHandler: requirePermission('invoices', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const payment = await prisma.payment.findUnique({ where: { id } });
    if (!payment) throw notFound('Payment not found.');

    await prisma.payment.delete({ where: { id } });
    if (payment.invoiceId) await refreshInvoicePayment(payment.invoiceId);
    if (payment.purchaseOrderId) await refreshPurchaseOrderPayment(payment.purchaseOrderId);

    const undoId = await audit({
      user: request.user, action: 'delete', entity: 'Payment', entityId: id,
      summary: `Reversed ${formatAed(num(payment.amount))} ${payment.direction === 'INCOMING' ? 'receipt' : 'payment'}`,
      undo: undoHardDelete('payment', 'invoices', id, payment, {
        refresh: payment.invoiceId
          ? { kind: 'invoice', id: payment.invoiceId }
          : payment.purchaseOrderId
            ? { kind: 'purchaseOrder', id: payment.purchaseOrderId }
            : undefined,
      }),
      ip: clientIp(request),
    });
    return { ok: true, undoId };
  });

  /** Cash position: what is owed to you, what you owe, and what is already late. */
  app.get('/api/payments/position', { preHandler: requirePermission('invoices', 'read') }, async () => {
    const now = new Date();

    const [receivables, payables] = await Promise.all([
      prisma.invoice.findMany({
        where: { type: 'TAX_INVOICE', status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] } },
        select: { total: true, amountPaid: true, dueDate: true },
      }),
      prisma.purchaseOrder.findMany({
        where: { direction: 'SUPPLIER', deletedAt: null, status: { notIn: ['DRAFT', 'CANCELLED'] } },
        select: { total: true, amountPaid: true, paymentDueDate: true },
      }),
    ]);

    const sum = (rows: Array<{ total: unknown; amountPaid: unknown; due: Date | null }>) => {
      let outstanding = 0;
      let overdue = 0;
      let dueThisWeek = 0;
      const weekOut = new Date(now.getTime() + 7 * 86_400_000);
      for (const row of rows) {
        const owed = num(row.total) - num(row.amountPaid);
        if (owed <= 0) continue;
        outstanding += owed;
        if (row.due && row.due < now) overdue += owed;
        else if (row.due && row.due <= weekOut) dueThisWeek += owed;
      }
      return { outstanding: round2(outstanding), overdue: round2(overdue), dueThisWeek: round2(dueThisWeek) };
    };

    return {
      receivable: sum(receivables.map((r) => ({ total: r.total, amountPaid: r.amountPaid, due: r.dueDate }))),
      payable: sum(payables.map((p) => ({ total: p.total, amountPaid: p.amountPaid, due: p.paymentDueDate }))),
    };
  });
}
