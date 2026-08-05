import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../db.js';
import { audit, undoHardDelete, undoUpdate, diff } from '../lib/audit.js';
import { badRequest, clientIp, forbidden, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { permissionFor } from '../auth/rbac.js';
import { resolvePrice } from '../services/priceBook.js';

/**
 * Price book.
 *
 * Gated on `products` permission *and* on being allowed to see cost: the whole table is
 * buy prices, so a role with `cost` hidden has no business reading any of it. That check
 * is here rather than relying on field masking, because masking removes a field from a
 * record — it cannot hide a table whose every row is the secret.
 */

const entrySchema = z.object({
  productId: z.string().min(1, 'Pick the catalogue item this price is for.'),
  vendorId: z.string().optional().nullable(),
  cost: z.number().nonnegative('A cost cannot be negative.'),
  listPrice: z.number().nonnegative().optional().nullable(),
  currency: z.string().optional(),
  vendorSku: z.string().optional().nullable(),
  minQuantity: z.number().positive().optional(),
  validFrom: z.string().optional().nullable(),
  validTo: z.string().optional().nullable(),
  dealId: z.string().optional().nullable(),
  registrationId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
});

const include = {
  product: { select: { id: true, sku: true, name: true, listPrice: true, cost: true } },
  vendor: { select: { id: true, name: true } },
  deal: { select: { id: true, reference: true, name: true } },
};

const toDate = (v?: string | null) => (v ? new Date(v) : null);

export default async function priceBookRoutes(app: FastifyInstance): Promise<void> {
  /** Cost is the entire point of this table, so seeing it is the entry requirement. */
  const requireCostAccess = async (request: { user: Parameters<typeof permissionFor>[0] }) => {
    const fields = permissionFor(request.user, 'products').fields ?? {};
    if (fields.cost === 'hidden') {
      // A refusal, not a bad request — the caller asked a legitimate question and is
      // simply not allowed the answer, and the UI treats the two differently.
      throw forbidden('Your role cannot see buy prices, so the price book is not available to it.');
    }
  };

  app.get('/api/price-book', { preHandler: requirePermission('products', 'read') }, async (request) => {
    await requireCostAccess(request);
    const params = listParams(request.query as Record<string, unknown>, 'updatedAt');
    const f = params.filters;

    const where: Record<string, unknown> = {};
    if (f.productId) where.productId = f.productId;
    if (f.vendorId) where.vendorId = f.vendorId;
    if (f.dealId) where.dealId = f.dealId;
    // Standing prices only, unless a deal is named — special prices are deal business.
    if (f.standingOnly === 'true') where.dealId = null;
    if (f.expiring === 'true') {
      where.validTo = { not: null, lte: new Date(Date.now() + 30 * 86_400_000) };
      where.isActive = true;
    }
    if (params.search) {
      where.OR = [
        { vendorSku: { contains: params.search, mode: 'insensitive' } },
        { product: { sku: { contains: params.search, mode: 'insensitive' } } },
        { product: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.priceEntry.findMany({
        where,
        include,
        orderBy: orderBy(params, ['updatedAt', 'cost', 'minQuantity', 'validTo'], 'updatedAt'),
        skip: params.skip,
        take: params.take,
      }),
      prisma.priceEntry.count({ where }),
    ]);
    return paged(data, total, params);
  });

  /**
   * What would this line cost? The screens call this when a product is picked, so the
   * cost on a quote is the vendor's number rather than whatever someone remembers.
   */
  app.get('/api/price-book/resolve', { preHandler: requirePermission('products', 'read') }, async (request) => {
    await requireCostAccess(request);
    const q = request.query as Record<string, string>;
    if (!q.productId) throw badRequest('productId is required.');
    return resolvePrice({
      productId: q.productId,
      quantity: q.quantity ? Number(q.quantity) : 1,
      dealId: q.dealId ?? null,
      vendorId: q.vendorId ?? null,
      // The document's currency, so a dollar price lands on a dirham quote as dirhams.
      currency: q.currency ?? null,
    });
  });

  app.post('/api/price-book', { preHandler: requirePermission('products', 'create') }, async (request, reply) => {
    await requireCostAccess(request);
    const parsed = entrySchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const body = parsed.data;

    // A special price belongs to a deal; recording one without saying which deal would
    // quietly become a standing price for every customer.
    if (body.registrationId && !body.dealId) {
      const registration = await prisma.dealRegistration.findUnique({
        where: { id: body.registrationId },
        select: { dealId: true },
      });
      if (!registration) throw notFound('That deal registration no longer exists.');
      body.dealId = registration.dealId;
    }

    const entry = await prisma.priceEntry.create({
      data: {
        ...body,
        minQuantity: body.minQuantity ?? 1,
        validFrom: toDate(body.validFrom),
        validTo: toDate(body.validTo),
      },
      include,
    });

    await audit({
      user: request.user, action: 'create', entity: 'PriceEntry', entityId: entry.id,
      summary: `${entry.product.sku} at ${num(entry.cost)}${entry.deal ? ` (special on ${entry.deal.reference})` : ''}`,
      ip: clientIp(request),
    });
    return reply.status(201).send(entry);
  });

  app.patch('/api/price-book/:id', { preHandler: requirePermission('products', 'update') }, async (request) => {
    await requireCostAccess(request);
    const { id } = request.params as { id: string };
    const parsed = entrySchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const existing = await prisma.priceEntry.findUnique({ where: { id } });
    if (!existing) throw notFound('Price entry not found.');

    const entry = await prisma.priceEntry.update({
      where: { id },
      data: {
        ...parsed.data,
        validFrom: parsed.data.validFrom !== undefined ? toDate(parsed.data.validFrom) : undefined,
        validTo: parsed.data.validTo !== undefined ? toDate(parsed.data.validTo) : undefined,
      } as never,
      include,
    });

    const changes = diff(existing as unknown as Record<string, unknown>, entry as unknown as Record<string, unknown>);
    await audit({
      user: request.user, action: 'update', entity: 'PriceEntry', entityId: id,
      summary: `${entry.product.sku} at ${num(entry.cost)}`,
      changes,
      undo: undoUpdate('priceEntry', 'products', id, existing as unknown as Record<string, unknown>, changes),
      ip: clientIp(request),
    });
    return entry;
  });

  app.delete('/api/price-book/:id', { preHandler: requirePermission('products', 'delete') }, async (request) => {
    await requireCostAccess(request);
    const { id } = request.params as { id: string };
    const existing = await prisma.priceEntry.findUnique({ where: { id }, include: { product: { select: { sku: true } } } });
    if (!existing) throw notFound('Price entry not found.');

    await prisma.priceEntry.delete({ where: { id } });
    const undoId = await audit({
      user: request.user, action: 'delete', entity: 'PriceEntry', entityId: id,
      summary: `${existing.product.sku} at ${num(existing.cost)}`,
      undo: undoHardDelete('priceEntry', 'products', id, existing),
      ip: clientIp(request),
    });
    return { ok: true, undoId };
  });
}
