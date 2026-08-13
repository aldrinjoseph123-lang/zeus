import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../db.js';
import { audit, auditRead, diff, undoHardDelete, undoLineEdit, undoUpdate } from '../lib/audit.js';
import { badRequest, clientIp, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { approvalRequired, blockedReason } from '../services/approvals.js';
import { maskFields, permissionFor } from '../auth/rbac.js';
import { nextReference } from '../lib/counters.js';
import { formatAed, lineTotals } from '../lib/money.js';
import { getSetting, vatRate } from '../lib/settings.js';
import { recalcInvoice, recalcQuote, snapshotParties } from '../lib/commercial.js';
import { quotePdf, type QuotePdfData } from '../services/pdf.js';
import { sendMail } from '../services/graph.js';
import { notify, emailTemplate } from '../services/notify.js';
import { touch } from '../lib/touch.js';
import { resolvePrice } from '../services/priceBook.js';

const lineSchema = z.object({
  id: z.string().optional(),
  productId: z.string().optional().nullable(),
  description: z.string().min(1, 'Every line needs a description.'),
  quantity: z.number().positive('Quantity must be greater than zero.').default(1),
  unit: z.string().default('licence'),
  unitPrice: z.number().nonnegative().default(0),
  unitCost: z.number().nonnegative().default(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxable: z.boolean().default(true),
  termMonths: z.number().int().positive().optional().nullable(),
});

const quoteSchema = z.object({
  dealId: z.string().optional().nullable(),
  accountId: z.string().min(1, 'Pick the customer.'),
  contactId: z.string().optional().nullable(),
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED']).optional(),
  issueDate: z.string().optional(),
  validUntil: z.string().optional().nullable(),
  discountPct: z.number().min(0).max(100).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  terms: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  lines: z.array(lineSchema).default([]),
});

const quoteInclude = {
  account: true,
  contact: { select: { id: true, firstName: true, lastName: true, email: true, phone: true } },
  deal: { select: { id: true, reference: true, name: true } },
  preparedBy: { select: { id: true, name: true, email: true, phone: true } },
  lines: { orderBy: { order: 'asc' as const } },
};

type IncomingLine = z.infer<typeof lineSchema>;

/**
 * Supply the cost of each line when the caller is not allowed to set it.
 *
 * A Sales Executive cannot see `unitCost`, so it never reaches their browser — and the
 * quote editor duly posts zero for it. Taking that at face value wrote a cost of nothing
 * and a margin of everything: the quote read as 100% margin, and the manager approving it
 * was signing off a number the system had invented. On an edit it was worse, because the
 * zero overwrote a cost that had been right.
 *
 * `stripUnwritableFields` does not help here: it drops top-level keys, and this one lives
 * inside the lines array. So instead of trusting the client, the cost is taken from the
 * line as it was already stored, and failing that from the price book.
 */
async function costedLines(
  user: Parameters<typeof permissionFor>[0],
  lines: IncomingLine[],
  context: { quoteId?: string; dealId?: string | null },
): Promise<IncomingLine[]> {
  const fields = permissionFor(user, 'quotes').fields ?? {};
  if (fields.unitCost === 'write' || fields.unitCost === undefined) return lines;

  const previous = context.quoteId
    ? await prisma.quoteLine.findMany({ where: { quoteId: context.quoteId } })
    : [];
  // A stored zero is not a cost worth protecting — it means nobody ever knew one, so it
  // is better to ask the price book again than to preserve the absence for ever.
  const known = previous.filter((l) => num(l.unitCost) > 0);
  const byProduct = new Map(known.filter((l) => l.productId).map((l) => [l.productId, num(l.unitCost)]));
  const byDescription = new Map(known.map((l) => [l.description, num(l.unitCost)]));

  return Promise.all(
    lines.map(async (line) => {
      const kept = (line.productId ? byProduct.get(line.productId) : undefined) ?? byDescription.get(line.description);
      if (kept !== undefined) return { ...line, unitCost: kept };
      if (!line.productId) return { ...line, unitCost: 0 };

      const priced = await resolvePrice({
        productId: line.productId,
        quantity: line.quantity,
        dealId: context.dealId ?? null,
      });
      return { ...line, unitCost: priced.rateMissing ? 0 : priced.cost };
    }),
  );
}


/**
 * Whether the margin on this quote is one somebody should look at, as a flag rather than
 * a figure.
 *
 * A Sales Executive cannot see cost or margin, so the editor's margin warning was hidden
 * from the one person able to act on it before sending — and their browser cannot work it
 * out, because the numbers it would need are exactly the ones being withheld. A boolean is
 * not the cost, so it survives masking and the warning reaches them.
 */
async function marginFlag(quote: { subtotal: unknown; discountAmt: unknown; totalCost: unknown }) {
  const net = num(quote.subtotal) - num(quote.discountAmt);
  if (net <= 0) return null;
  const marginPct = ((net - num(quote.totalCost)) / net) * 100;
  const floor = Number(await getSetting<number>('approvals.dealMinMarginPct', 0));
  const belowFloor = marginPct < 0 || (floor > 0 && marginPct < floor);
  return belowFloor ? { belowFloor: true, negative: marginPct < 0, floorPct: floor } : null;
}

/** A quote cannot be sent until a manager has signed it off (when approval is on). */
async function ensureQuoteApproved(id: string): Promise<void> {
  const q = await prisma.quote.findUnique({ where: { id }, select: { number: true, total: true, approvalStatus: true, approvalNote: true } });
  if (!q) throw notFound('Quote not found.');
  const requirement = await approvalRequired('quotes', { total: q.total });
  if (requirement.required && q.approvalStatus !== 'APPROVED') {
    throw badRequest(
      blockedReason(q, 'quotes')
        ?? `${q.number} needs a manager's approval before it can be sent.${requirement.reason ? ` ${requirement.reason}` : ''}`,
    );
  }
}

export default async function quoteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/quotes', { preHandler: requirePermission('quotes', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'createdAt');
    const where: Record<string, unknown> = {};
    if (params.filters.status) where.status = params.filters.status;
    if (params.filters.accountId) where.accountId = params.filters.accountId;
    if (params.filters.dealId) where.dealId = params.filters.dealId;
    if (params.search) {
      where.OR = [
        { number: { contains: params.search, mode: 'insensitive' } },
        { account: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.quote.findMany({
        where,
        include: {
          account: { select: { id: true, name: true } },
          deal: { select: { id: true, reference: true } },
          preparedBy: { select: { id: true, name: true } },
        },
        orderBy: orderBy(params, ['number', 'createdAt', 'total', 'status', 'validUntil'], 'createdAt'),
        skip: params.skip,
        take: params.take,
      }),
      prisma.quote.count({ where }),
    ]);
    return paged(maskFields(request.user, 'quotes', data), total, params);
  });

  app.get('/api/quotes/:id', { preHandler: requirePermission('quotes', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const quote = await prisma.quote.findUnique({ where: { id }, include: quoteInclude });
    if (!quote) throw notFound('Quote not found.');
    auditRead(request.user, 'Quote', quote.id, quote.number, clientIp(request));
    return { ...maskFields(request.user, 'quotes', quote), marginWarning: await marginFlag(quote) };
  });

  app.post('/api/quotes', { preHandler: requirePermission('quotes', 'create') }, async (request, reply) => {
    const parsed = quoteSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = parsed.data;

    const [defaultVat, validDays, defaultTerms] = await Promise.all([
      vatRate(),
      getSetting<number>('finance.quoteValidDays', 30),
      getSetting<string>('finance.quoteTerms', ''),
    ]);

    const quote = await prisma.quote.create({
      data: {
        number: await nextReference('quote'),
        dealId: body.dealId ?? null,
        accountId: body.accountId,
        contactId: body.contactId ?? null,
        status: body.status ?? 'DRAFT',
        issueDate: body.issueDate ? new Date(body.issueDate) : new Date(),
        validUntil: body.validUntil ? new Date(body.validUntil) : new Date(Date.now() + Number(validDays) * 86_400_000),
        discountPct: body.discountPct ?? 0,
        vatRate: body.vatRate ?? defaultVat,
        terms: body.terms ?? defaultTerms,
        notes: body.notes ?? null,
        preparedById: request.user.id,
        lines: {
          create: (await costedLines(request.user, body.lines, { dealId: body.dealId })).map((line, index) => {
            const t = lineTotals(line);
            return { ...line, id: undefined, order: index, lineTotal: t.lineTotal, lineCost: t.lineCost };
          }),
        },
      },
    });

    await recalcQuote(quote.id);
    await touch({ accountId: body.accountId, dealId: body.dealId });
    await audit({ user: request.user, action: 'create', entity: 'Quote', entityId: quote.id, summary: quote.number, ip: clientIp(request) });

    const full = await prisma.quote.findUnique({ where: { id: quote.id }, include: quoteInclude });
    return reply.status(201).send(maskFields(request.user, 'quotes', full));
  });

  app.patch('/api/quotes/:id', { preHandler: requirePermission('quotes', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.quote.findUnique({ where: { id }, include: { lines: { orderBy: { order: 'asc' } } } });
    if (!existing) throw notFound('Quote not found.');
    if (existing.status === 'ACCEPTED') throw badRequest('An accepted quote is locked. Create a new version instead.');

    const parsed = quoteSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const { lines, ...body } = parsed.data;

    await prisma.quote.update({
      where: { id },
      data: {
        ...body,
        issueDate: body.issueDate ? new Date(body.issueDate) : undefined,
        validUntil: body.validUntil !== undefined ? (body.validUntil ? new Date(body.validUntil) : null) : undefined,
      } as never,
    });

    // Lines are replaced wholesale — simpler and safer than diffing an editable grid.
    if (lines) {
      const priced = await costedLines(request.user, lines, { quoteId: id, dealId: body.dealId ?? existing.dealId });
      await prisma.quoteLine.deleteMany({ where: { quoteId: id } });
      await prisma.quoteLine.createMany({
        data: priced.map((line, index) => {
          const t = lineTotals(line);
          return { ...line, id: undefined, quoteId: id, order: index, lineTotal: t.lineTotal, lineCost: t.lineCost };
        }),
      });
    }

    await recalcQuote(id);

    const after = await prisma.quote.findUniqueOrThrow({ where: { id } });
    const changes = diff(existing as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
    await audit({
      user: request.user, action: 'update', entity: 'Quote', entityId: id, summary: existing.number,
      changes,
      // Rewriting the lines is the destructive part of editing a quote, so it is the part
      // undo has to be able to reach.
      undo: lines
        ? undoLineEdit('quote', 'quotes', id, existing as unknown as Record<string, unknown>, changes, existing.lines as unknown as Array<Record<string, unknown>>)
        : undoUpdate('quote', 'quotes', id, existing as unknown as Record<string, unknown>, changes),
      ip: clientIp(request),
    });
    const full = await prisma.quote.findUniqueOrThrow({ where: { id }, include: quoteInclude });
    return { ...maskFields(request.user, 'quotes', full), marginWarning: await marginFlag(full) };
  });

  /** New version of an existing quote — keeps the old one for the audit trail. */
  app.post('/api/quotes/:id/revise', { preHandler: requirePermission('quotes', 'create') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = await prisma.quote.findUnique({ where: { id }, include: { lines: { orderBy: { order: 'asc' } } } });
    if (!source) throw notFound('Quote not found.');

    const copy = await prisma.quote.create({
      data: {
        number: source.number,
        version: source.version + 1,
        dealId: source.dealId,
        accountId: source.accountId,
        contactId: source.contactId,
        status: 'DRAFT',
        validUntil: source.validUntil,
        discountPct: source.discountPct,
        vatRate: source.vatRate,
        terms: source.terms,
        notes: source.notes,
        preparedById: request.user.id,
        lines: {
          create: source.lines.map((l) => ({
            productId: l.productId, order: l.order, description: l.description, quantity: l.quantity,
            unit: l.unit, unitPrice: l.unitPrice, unitCost: l.unitCost, discountPct: l.discountPct,
            taxable: l.taxable, lineTotal: l.lineTotal, lineCost: l.lineCost, termMonths: l.termMonths,
          })),
        },
      },
    }).catch(async () => {
      // `number` is unique — a revision gets its own number rather than colliding.
      return prisma.quote.create({
        data: {
          number: await nextReference('quote'),
          version: source.version + 1,
          dealId: source.dealId,
          accountId: source.accountId,
          contactId: source.contactId,
          status: 'DRAFT',
          validUntil: source.validUntil,
          discountPct: source.discountPct,
          vatRate: source.vatRate,
          terms: source.terms,
          notes: source.notes,
          preparedById: request.user.id,
          lines: {
            create: source.lines.map((l) => ({
              productId: l.productId, order: l.order, description: l.description, quantity: l.quantity,
              unit: l.unit, unitPrice: l.unitPrice, unitCost: l.unitCost, discountPct: l.discountPct,
              taxable: l.taxable, lineTotal: l.lineTotal, lineCost: l.lineCost, termMonths: l.termMonths,
            })),
          },
        },
      });
    });

    await recalcQuote(copy.id);
    await audit({ user: request.user, action: 'create', entity: 'Quote', entityId: copy.id, summary: `Revision of ${source.number}`, ip: clientIp(request) });
    return reply.status(201).send(await prisma.quote.findUnique({ where: { id: copy.id }, include: quoteInclude }));
  });

  app.post('/api/quotes/:id/status', { preHandler: requirePermission('quotes', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const { status } = z.object({ status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED']) }).parse(request.body);

    if (status === 'SENT') await ensureQuoteApproved(id);

    const quote = await prisma.quote.update({
      where: { id },
      data: {
        status,
        sentAt: status === 'SENT' ? new Date() : undefined,
        acceptedAt: status === 'ACCEPTED' ? new Date() : undefined,
      },
      include: { account: true, deal: true },
    });

    if (status === 'ACCEPTED') {
      await notify({
        event: 'quote_accepted',
        title: `Quote accepted — ${quote.number}`,
        body: `${quote.account.name} · ${formatAed(num(quote.total))} incl. VAT`,
        link: quote.dealId ? `/deals/${quote.dealId}` : `/quotes/${quote.id}`,
        ownerId: quote.deal?.ownerId ?? quote.preparedById,
        facts: [
          { title: 'Customer', value: quote.account.name },
          { title: 'Total', value: formatAed(num(quote.total)) },
        ],
      });
    }

    await audit({ user: request.user, action: 'update', entity: 'Quote', entityId: id, summary: `${quote.number} → ${status}`, ip: clientIp(request) });
    return maskFields(request.user, 'quotes', quote);
  });

  app.delete('/api/quotes/:id', { preHandler: requirePermission('quotes', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.quote.findUnique({ where: { id }, include: { lines: true } });
    if (!existing) throw notFound('Quote not found.');
    if (existing.status === 'ACCEPTED') throw badRequest('An accepted quote cannot be deleted.');
    await prisma.quote.delete({ where: { id } });
    const undoId = await audit({
      user: request.user, action: 'delete', entity: 'Quote', entityId: id, summary: existing.number,
      // A quote without its lines is not a restored quote.
      undo: undoHardDelete('quote', 'quotes', id, existing, { children: { lines: existing.lines } }),
      ip: clientIp(request),
    });
    return { ok: true, undoId };
  });

  app.get('/api/quotes/:id/pdf', { preHandler: requirePermission('quotes', 'read') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const quote = await prisma.quote.findUnique({ where: { id }, include: quoteInclude });
    if (!quote) throw notFound('Quote not found.');

    const pdf = await quotePdf(quote as unknown as QuotePdfData);
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${quote.number}.pdf"`)
      .send(pdf);
  });

  /** Email the quote PDF from the shared mailbox and mark it sent. */
  app.post('/api/quotes/:id/send', { preHandler: requirePermission('quotes', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      to: z.array(z.string().email()).min(1, 'Add at least one recipient.'),
      cc: z.array(z.string().email()).optional(),
      subject: z.string().optional(),
      message: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const quote = await prisma.quote.findUnique({ where: { id }, include: quoteInclude });
    if (!quote) throw notFound('Quote not found.');

    await ensureQuoteApproved(id);

    const pdf = await quotePdf(quote as unknown as QuotePdfData);
    const subject = parsed.data.subject ?? `Quotation ${quote.number} — ${quote.account.name}`;

    await sendMail({
      to: parsed.data.to,
      cc: parsed.data.cc,
      subject,
      html: emailTemplate(
        subject,
        parsed.data.message ?? `Please find attached quotation ${quote.number} for ${formatAed(num(quote.total))} including VAT.`,
        undefined,
        [
          { title: 'Quotation', value: quote.number },
          { title: 'Total', value: formatAed(num(quote.total)) },
          { title: 'Valid until', value: quote.validUntil ? new Date(quote.validUntil).toLocaleDateString('en-GB') : '—' },
        ],
      ),
      attachments: [{ filename: `${quote.number}.pdf`, contentBytes: pdf.toString('base64'), contentType: 'application/pdf' }],
    });

    await prisma.quote.update({ where: { id }, data: { status: 'SENT', sentAt: new Date() } });
    await prisma.activity.create({
      data: {
        type: 'EMAIL',
        subject: `Sent quotation ${quote.number}`,
        description: `To: ${parsed.data.to.join(', ')}`,
        status: 'Completed',
        completedAt: new Date(),
        accountId: quote.accountId,
        dealId: quote.dealId,
        contactId: quote.contactId,
        ownerId: request.user.id,
        createdById: request.user.id,
      },
    });

    await audit({ user: request.user, action: 'send', entity: 'Quote', entityId: id, summary: `${quote.number} emailed to ${parsed.data.to.join(', ')}`, ip: clientIp(request) });
    return { ok: true };
  });

  /**
   * Raise a tax invoice from an accepted quote.
   * Lines are copied across so the invoice carries the per-line detail the FTA
   * requires; they stay editable afterwards for partial delivery or staged billing.
   */
  app.post('/api/quotes/:id/invoice', { preHandler: requirePermission('invoices', 'create') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const quote = await prisma.quote.findUnique({ where: { id }, include: { lines: { orderBy: { order: 'asc' } } } });
    if (!quote) throw notFound('Quote not found.');
    if (quote.status !== 'ACCEPTED') throw badRequest('Only an accepted quote can be invoiced.');

    const [termsDays, invoiceTerms] = await Promise.all([
      getSetting<number>('finance.paymentTermsDays', 30),
      getSetting<string>('finance.invoiceTerms', ''),
    ]);
    const { poNumber, customerPoId } = z
      .object({ poNumber: z.string().optional(), customerPoId: z.string().optional() })
      .parse(request.body ?? {});

    const invoice = await prisma.invoice.create({
      data: {
        number: await nextReference('invoice'),
        type: 'TAX_INVOICE',
        quoteId: quote.id,
        dealId: quote.dealId,
        accountId: quote.accountId,
        contactId: quote.contactId,
        customerPoId: customerPoId ?? null,
        status: 'DRAFT',
        dueDate: new Date(Date.now() + Number(termsDays) * 86_400_000),
        currency: quote.currency,
        discountPct: quote.discountPct,
        vatRate: quote.vatRate,
        terms: invoiceTerms,
        poNumber: poNumber ?? null,
        createdById: request.user.id,
        lines: {
          create: quote.lines.map((l, index) => ({
            productId: l.productId,
            order: index,
            description: l.description,
            quantity: l.quantity,
            unit: l.unit,
            unitPrice: l.unitPrice,
            unitCost: l.unitCost,
            discountPct: l.discountPct,
            taxable: l.taxable,
            vatRate: l.taxable ? num(quote.vatRate) : 0,
            termMonths: l.termMonths,
          })),
        },
      },
    });

    await recalcInvoice(invoice.id);
    await snapshotParties(invoice.id);

    await audit({ user: request.user, action: 'create', entity: 'Invoice', entityId: invoice.id, summary: `${invoice.number} from ${quote.number}`, ip: clientIp(request) });
    return reply.status(201).send(await prisma.invoice.findUnique({ where: { id: invoice.id }, include: { lines: { orderBy: { order: 'asc' } }, account: true } }));
  });
}
