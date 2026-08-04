import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../db.js';
import { audit, undoSoftDelete } from '../lib/audit.js';
import { badRequest, clientIp, forbidden, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { maskFields, ownerAllowed } from '../auth/rbac.js';
import { nextReference } from '../lib/counters.js';
import { formatAed, round2 } from '../lib/money.js';
import { getSetting, vatRate } from '../lib/settings.js';
import { recalcPurchaseOrder } from '../lib/commercial.js';
import { purchaseOrderPdf, type PoPdfData } from '../services/pdf.js';
import { sendMail } from '../services/graph.js';
import { emailTemplate } from '../services/notify.js';
import { touch } from '../lib/touch.js';
import { approvalRequired, blockedReason } from '../services/approvals.js';

/**
 * Purchase orders in both directions.
 *
 *   CUSTOMER — the order your client sent you. Its number is *theirs*; Zeus records it
 *              as evidence that the quote was accepted, and the scan attaches to it.
 *   SUPPLIER — the order you issued to a vendor. Zeus allocates the number, prints the
 *              document, and the payment terms create the payable you have to settle.
 */

const lineSchema = z.object({
  productId: z.string().optional().nullable(),
  description: z.string().min(1, 'Every line needs a description.'),
  quantity: z.number().positive('Quantity must be greater than zero.').default(1),
  unit: z.string().default('licence'),
  unitPrice: z.number().nonnegative().default(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxable: z.boolean().default(true),
  vatRate: z.number().min(0).max(100).default(5),
});

const poSchema = z.object({
  direction: z.enum(['CUSTOMER', 'SUPPLIER']),
  /// Required for a customer PO — it is their document number. Allocated for a supplier PO.
  number: z.string().optional(),
  accountId: z.string().min(1, 'Pick the company this order is with.'),
  contactId: z.string().optional().nullable(),
  dealId: z.string().optional().nullable(),
  quoteId: z.string().optional().nullable(),
  orderDate: z.string().optional(),
  expectedDate: z.string().optional().nullable(),
  paymentTermsDays: z.number().int().nonnegative().optional().nullable(),
  paymentDueDate: z.string().optional().nullable(),
  currency: z.string().optional(),
  discountPct: z.number().min(0).max(100).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  supplierInvoiceNumber: z.string().optional().nullable(),
  supplierInvoiceDate: z.string().optional().nullable(),
  shipToAddress: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  lines: z.array(lineSchema).optional(),
});

const include = {
  account: true,
  contact: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
  deal: { select: { id: true, reference: true, name: true } },
  quote: { select: { id: true, number: true } },
  owner: { select: { id: true, name: true } },
  lines: { orderBy: { order: 'asc' as const } },
  payments: { orderBy: { paidAt: 'desc' as const }, include: { recordedBy: { select: { name: true } } } },
  approvalRequestedBy: { select: { id: true, name: true } },
  approvalDecidedBy: { select: { id: true, name: true } },

  attachments: { orderBy: { createdAt: 'desc' as const } },
  invoices: { select: { id: true, number: true, total: true, status: true } },
};

export default async function purchaseOrderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/purchase-orders', { preHandler: requirePermission('invoices', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'orderDate');
    const f = params.filters;

    const where: Record<string, unknown> = { deletedAt: null };
    if (f.direction) where.direction = f.direction;
    if (f.status) where.status = f.status;
    if (f.accountId) where.accountId = f.accountId;
    if (f.dealId) where.dealId = f.dealId;
    if (f.unpaid === 'true') where.status = { notIn: ['CANCELLED', 'DRAFT'] };
    if (f.dueBefore) where.paymentDueDate = { lte: new Date(f.dueBefore) };
    if (params.search) {
      where.OR = [
        { number: { contains: params.search, mode: 'insensitive' } },
        { supplierInvoiceNumber: { contains: params.search, mode: 'insensitive' } },
        { account: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total, sums] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: {
          account: { select: { id: true, name: true, type: true } },
          deal: { select: { id: true, reference: true } },
          owner: { select: { id: true, name: true } },
          _count: { select: { lines: true } },
        },
        orderBy: orderBy(params, ['number', 'orderDate', 'expectedDate', 'paymentDueDate', 'total', 'status'], 'orderDate'),
        skip: params.skip,
        take: params.take,
      }),
      prisma.purchaseOrder.count({ where }),
      prisma.purchaseOrder.aggregate({ where, _sum: { total: true, amountPaid: true } }),
    ]);

    return {
      ...paged(maskFields(request.user, 'invoices', data), total, params),
      totals: {
        ordered: round2(num(sums._sum.total)),
        paid: round2(num(sums._sum.amountPaid)),
        outstanding: round2(num(sums._sum.total) - num(sums._sum.amountPaid)),
      },
    };
  });

  app.get('/api/purchase-orders/:id', { preHandler: requirePermission('invoices', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const po = await prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include });
    if (!po) throw notFound('Purchase order not found.');
    return maskFields(request.user, 'invoices', po);
  });

  app.post('/api/purchase-orders', { preHandler: requirePermission('invoices', 'create') }, async (request, reply) => {
    const parsed = poSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = parsed.data;

    if (body.direction === 'CUSTOMER' && !body.number?.trim()) {
      throw badRequest("Enter the customer's own PO number — Zeus does not allocate numbers for orders you receive.");
    }

    const [defaultVat, poTermsDays, defaultTerms] = await Promise.all([
      vatRate(),
      getSetting<number>('finance.poPaymentTermsDays', 30),
      getSetting<string>('finance.poTerms', ''),
    ]);

    const number = body.direction === 'SUPPLIER' ? await nextReference('purchaseOrder') : body.number!.trim();

    const clash = await prisma.purchaseOrder.findFirst({ where: { direction: body.direction, number, deletedAt: null } });
    if (clash) throw badRequest(`A ${body.direction.toLowerCase()} purchase order numbered ${number} already exists.`);

    const termsDays = body.paymentTermsDays ?? (body.direction === 'SUPPLIER' ? Number(poTermsDays) : null);
    const orderDate = body.orderDate ? new Date(body.orderDate) : new Date();

    const po = await prisma.purchaseOrder.create({
      data: {
        number,
        direction: body.direction,
        accountId: body.accountId,
        contactId: body.contactId ?? null,
        dealId: body.dealId ?? null,
        quoteId: body.quoteId ?? null,
        orderDate,
        expectedDate: body.expectedDate ? new Date(body.expectedDate) : null,
        paymentTermsDays: termsDays,
        paymentDueDate: body.paymentDueDate
          ? new Date(body.paymentDueDate)
          : termsDays !== null && termsDays !== undefined
            ? new Date(orderDate.getTime() + termsDays * 86_400_000)
            : null,
        currency: body.currency ?? 'AED',
        discountPct: body.discountPct ?? 0,
        vatRate: body.vatRate ?? defaultVat,
        supplierInvoiceNumber: body.supplierInvoiceNumber ?? null,
        supplierInvoiceDate: body.supplierInvoiceDate ? new Date(body.supplierInvoiceDate) : null,
        shipToAddress: body.shipToAddress ?? null,
        terms: body.terms ?? (body.direction === 'SUPPLIER' ? defaultTerms : null),
        notes: body.notes ?? null,
        ownerId: body.ownerId ?? request.user.id,
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

    await recalcPurchaseOrder(po.id);
    await touch({ accountId: body.accountId, dealId: body.dealId });
    await audit({
      user: request.user, action: 'create', entity: 'PurchaseOrder', entityId: po.id,
      summary: `${body.direction === 'SUPPLIER' ? 'Issued' : 'Received'} PO ${number}`, ip: clientIp(request),
    });

    return reply.status(201).send(await prisma.purchaseOrder.findUnique({ where: { id: po.id }, include }));
  });

  app.patch('/api/purchase-orders/:id', { preHandler: requirePermission('invoices', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Purchase order not found.');
    if (!(await ownerAllowed(request.user, 'invoices', 'update', existing.ownerId))) throw forbidden();

    const parsed = poSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const { lines, direction: _dir, ...body } = parsed.data;

    await prisma.purchaseOrder.update({
      where: { id },
      data: {
        ...body,
        orderDate: body.orderDate ? new Date(body.orderDate) : undefined,
        expectedDate: body.expectedDate !== undefined ? (body.expectedDate ? new Date(body.expectedDate) : null) : undefined,
        paymentDueDate: body.paymentDueDate !== undefined ? (body.paymentDueDate ? new Date(body.paymentDueDate) : null) : undefined,
        supplierInvoiceDate: body.supplierInvoiceDate !== undefined ? (body.supplierInvoiceDate ? new Date(body.supplierInvoiceDate) : null) : undefined,
      } as never,
    });

    if (lines) {
      const defaultVat = await vatRate();
      await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
      await prisma.purchaseOrderLine.createMany({
        data: lines.map((line, index) => ({
          ...line,
          vatRate: line.taxable ? (line.vatRate ?? defaultVat) : 0,
          purchaseOrderId: id,
          order: index,
        })),
      });
    }

    await recalcPurchaseOrder(id);
    await audit({ user: request.user, action: 'update', entity: 'PurchaseOrder', entityId: id, summary: existing.number, ip: clientIp(request) });
    return prisma.purchaseOrder.findUnique({ where: { id }, include });
  });

  app.post('/api/purchase-orders/:id/status', { preHandler: requirePermission('invoices', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const { status } = z.object({
      status: z.enum(['DRAFT', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED']),
    }).parse(request.body);

    const existing = await prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { payments: true } });
    if (!existing) throw notFound('Purchase order not found.');
    if (status === 'CANCELLED' && existing.payments.length > 0) {
      throw badRequest('Money has already moved against this order. Settle it or raise a credit with the vendor rather than cancelling.');
    }

    // Issuing a supplier PO commits us to paying for it. That needs a signature; a
    // customer's own PO is only being recorded, so it does not.
    if (status === 'ISSUED' && existing.direction === 'SUPPLIER' && existing.status === 'DRAFT') {
      const requirement = await approvalRequired('purchase-orders', { total: existing.total });
      if (requirement.required && existing.approvalStatus !== 'APPROVED') {
        throw badRequest(
          blockedReason(existing, 'purchase-orders')
            ?? `${existing.number} needs a sales manager's approval before it goes to the supplier.${requirement.reason ? ` ${requirement.reason}` : ''}`,
        );
      }
    }

    const po = await prisma.purchaseOrder.update({
      where: { id },
      data: { status, issuedAt: status === 'ISSUED' && !existing.issuedAt ? new Date() : undefined },
    });
    await audit({ user: request.user, action: 'update', entity: 'PurchaseOrder', entityId: id, summary: `${po.number} → ${status}`, ip: clientIp(request) });
    return po;
  });

  /** Record what physically arrived, per line. Status follows the quantities. */
  app.post('/api/purchase-orders/:id/receive', { preHandler: requirePermission('invoices', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const { received } = z.object({
      received: z.array(z.object({ lineId: z.string(), quantityReceived: z.number().nonnegative() })),
    }).parse(request.body);

    const po = await prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { lines: true } });
    if (!po) throw notFound('Purchase order not found.');

    for (const entry of received) {
      const line = po.lines.find((l) => l.id === entry.lineId);
      if (!line) throw badRequest('One of those lines is not on this order.');
      if (entry.quantityReceived > num(line.quantity)) {
        throw badRequest(`Cannot receive ${entry.quantityReceived} of "${line.description}" — only ${num(line.quantity)} were ordered.`);
      }
      await prisma.purchaseOrderLine.update({ where: { id: entry.lineId }, data: { quantityReceived: entry.quantityReceived } });
    }

    const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: id } });
    const allIn = lines.every((l) => num(l.quantityReceived) >= num(l.quantity));
    const anyIn = lines.some((l) => num(l.quantityReceived) > 0);
    const status = allIn ? 'RECEIVED' : anyIn ? 'PARTIALLY_RECEIVED' : po.status;

    const updated = await prisma.purchaseOrder.update({ where: { id }, data: { status } });
    await audit({ user: request.user, action: 'update', entity: 'PurchaseOrder', entityId: id, summary: `${po.number} goods receipt → ${status}`, ip: clientIp(request) });
    return updated;
  });

  /**
   * Turn a won quote into the supplier PO that fulfils it.
   * Lines come across at *cost*, because this is what you are paying the vendor —
   * not what you charged the customer.
   */
  app.post('/api/quotes/:quoteId/supplier-po', { preHandler: requirePermission('invoices', 'create') }, async (request, reply) => {
    const { quoteId } = request.params as { quoteId: string };
    const { vendorId, expectedDate } = z.object({
      vendorId: z.string().min(1, 'Pick the vendor you are buying from.'),
      expectedDate: z.string().optional().nullable(),
    }).parse(request.body);

    const quote = await prisma.quote.findUnique({ where: { id: quoteId }, include: { lines: { orderBy: { order: 'asc' } } } });
    if (!quote) throw notFound('Quote not found.');
    if (quote.lines.length === 0) throw badRequest('That quote has no lines to order.');

    const [defaultVat, poTermsDays, defaultTerms] = await Promise.all([
      vatRate(),
      getSetting<number>('finance.poPaymentTermsDays', 30),
      getSetting<string>('finance.poTerms', ''),
    ]);

    const orderDate = new Date();
    const po = await prisma.purchaseOrder.create({
      data: {
        number: await nextReference('purchaseOrder'),
        direction: 'SUPPLIER',
        accountId: vendorId,
        dealId: quote.dealId,
        quoteId: quote.id,
        orderDate,
        expectedDate: expectedDate ? new Date(expectedDate) : null,
        paymentTermsDays: Number(poTermsDays),
        paymentDueDate: new Date(orderDate.getTime() + Number(poTermsDays) * 86_400_000),
        currency: quote.currency,
        vatRate: defaultVat,
        terms: defaultTerms,
        ownerId: request.user.id,
        createdById: request.user.id,
        lines: {
          create: quote.lines.map((l, index) => ({
            productId: l.productId,
            order: index,
            description: l.description,
            quantity: l.quantity,
            unit: l.unit,
            // Buy price, not sell price.
            unitPrice: l.unitCost,
            taxable: l.taxable,
            vatRate: l.taxable ? defaultVat : 0,
          })),
        },
      },
    });

    await recalcPurchaseOrder(po.id);
    await audit({ user: request.user, action: 'create', entity: 'PurchaseOrder', entityId: po.id, summary: `${po.number} from quote ${quote.number}`, ip: clientIp(request) });
    return reply.status(201).send(await prisma.purchaseOrder.findUnique({ where: { id: po.id }, include }));
  });

  app.get('/api/purchase-orders/:id/pdf', { preHandler: requirePermission('invoices', 'read') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const po = await prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include });
    if (!po) throw notFound('Purchase order not found.');
    if (po.direction === 'CUSTOMER') {
      throw badRequest('This is the order your customer sent you — print their document, not ours. Attach the scan to this record instead.');
    }

    const pdf = await purchaseOrderPdf(po as unknown as PoPdfData);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${po.number}.pdf"`)
      .send(pdf);
  });

  app.post('/api/purchase-orders/:id/send', { preHandler: requirePermission('invoices', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({
      to: z.array(z.string().email()).min(1, 'Add at least one recipient.'),
      cc: z.array(z.string().email()).optional(),
      message: z.string().optional(),
    }).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const po = await prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include });
    if (!po) throw notFound('Purchase order not found.');
    if (po.direction === 'CUSTOMER') throw badRequest('You cannot send a customer order back to them.');

    const pdf = await purchaseOrderPdf(po as unknown as PoPdfData);
    const subject = `Purchase Order ${po.number}`;

    await sendMail({
      to: parsed.data.to,
      cc: parsed.data.cc,
      subject,
      html: emailTemplate(
        subject,
        parsed.data.message ?? `Please find attached purchase order ${po.number} for ${formatAed(num(po.total))}. Kindly acknowledge receipt and confirm the delivery date.`,
        undefined,
        [
          { title: 'Purchase order', value: po.number },
          { title: 'Value', value: formatAed(num(po.total)) },
          ...(po.expectedDate ? [{ title: 'Required by', value: new Date(po.expectedDate).toLocaleDateString('en-GB') }] : []),
        ],
      ),
      attachments: [{ filename: `${po.number}.pdf`, contentBytes: pdf.toString('base64'), contentType: 'application/pdf' }],
    });

    await prisma.purchaseOrder.update({
      where: { id },
      data: { status: po.status === 'DRAFT' ? 'ISSUED' : po.status, issuedAt: po.issuedAt ?? new Date() },
    });
    await audit({ user: request.user, action: 'send', entity: 'PurchaseOrder', entityId: id, summary: `${po.number} emailed to ${parsed.data.to.join(', ')}`, ip: clientIp(request) });
    return { ok: true };
  });

  app.delete('/api/purchase-orders/:id', { preHandler: requirePermission('invoices', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { payments: true } });
    if (!existing) throw notFound('Purchase order not found.');
    if (existing.payments.length) throw badRequest('This order has payments recorded against it.');

    await prisma.purchaseOrder.update({ where: { id }, data: { deletedAt: new Date() } });
    const undoId = await audit({ user: request.user, action: 'delete', entity: 'PurchaseOrder', entityId: id, summary: existing.number,
      undo: undoSoftDelete('purchaseOrder', 'invoices', id), ip: clientIp(request) });
    return { ok: true, undoId };
  });
}
