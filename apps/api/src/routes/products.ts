import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { sanitizeCustomFields } from '../lib/customFields.js';
import { audit, diff, undoHardDelete, undoUpdate } from '../lib/audit.js';
import { badRequest, clientIp, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { maskFields, stripUnwritableFields } from '../auth/rbac.js';

const productSchema = z.object({
  sku: z.string().min(1, 'SKU is required.'),
  name: z.string().min(1, 'Name is required.'),
  type: z.enum(['PRODUCT', 'SERVICE']).default('PRODUCT'),
  category: z.string().optional().nullable(),
  vendorId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  unit: z.string().default('licence'),
  listPrice: z.number().nonnegative().default(0),
  cost: z.number().nonnegative().default(0),
  currency: z.string().default('AED'),
  taxable: z.boolean().default(true),
  isActive: z.boolean().default(true),
  customFields: z.record(z.unknown()).optional(),
});

export default async function productRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/products', { preHandler: requirePermission('products', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'name');
    const where: Record<string, unknown> = {};
    if (params.filters.type) where.type = params.filters.type;
    if (params.filters.category) where.category = params.filters.category;
    if (params.filters.vendorId) where.vendorId = params.filters.vendorId;
    if (params.filters.isActive !== undefined) where.isActive = params.filters.isActive === 'true';
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { sku: { contains: params.search, mode: 'insensitive' } },
        { vendor: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: { vendor: { select: { id: true, name: true } } },
        orderBy: orderBy(params, ['name', 'sku', 'listPrice', 'category', 'createdAt'], 'name'),
        skip: params.skip,
        take: params.take,
      }),
      prisma.product.count({ where }),
    ]);
    return paged(maskFields(request.user, 'products', data), total, params);
  });

  app.get('/api/products/:id', { preHandler: requirePermission('products', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const product = await prisma.product.findUnique({ where: { id }, include: { vendor: { select: { id: true, name: true } } } });
    if (!product) throw notFound('Product not found.');
    return maskFields(request.user, 'products', product);
  });

  app.post('/api/products', { preHandler: requirePermission('products', 'create') }, async (request, reply) => {
    const parsed = productSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = stripUnwritableFields(request.user, 'products', parsed.data as Record<string, unknown>) as z.infer<typeof productSchema>;

    const clash = await prisma.product.findUnique({ where: { sku: body.sku } });
    if (clash) throw badRequest(`SKU ${body.sku} already exists.`);

    const product = await prisma.product.create({
      data: { ...body, customFields: (await sanitizeCustomFields('products', body.customFields, {}, { enforceRequired: true })) as never },
    });
    await audit({ user: request.user, action: 'create', entity: 'Product', entityId: product.id, summary: `${product.sku} ${product.name}`, ip: clientIp(request) });
    return reply.status(201).send(maskFields(request.user, 'products', product));
  });

  app.patch('/api/products/:id', { preHandler: requirePermission('products', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) throw notFound('Product not found.');

    const parsed = productSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = stripUnwritableFields(request.user, 'products', parsed.data as Record<string, unknown>);

    if ('customFields' in body) {
      body.customFields = await sanitizeCustomFields('products', body.customFields, (existing.customFields ?? {}) as Record<string, unknown>);
    }

    const product = await prisma.product.update({ where: { id }, data: body as never });
    await audit({
      user: request.user, action: 'update', entity: 'Product', entityId: id, summary: `${product.sku} ${product.name}`,
      changes: diff(existing as unknown as Record<string, unknown>, product as unknown as Record<string, unknown>),
      undo: undoUpdate('product', 'products', id, existing as unknown as Record<string, unknown>,
        diff(existing as unknown as Record<string, unknown>, product as unknown as Record<string, unknown>)),
      ip: clientIp(request),
    });
    return maskFields(request.user, 'products', product);
  });

  app.delete('/api/products/:id', { preHandler: requirePermission('products', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const used = await prisma.quoteLine.count({ where: { productId: id } });
    // Deactivate rather than delete once it has been quoted — the quote history must stay intact.
    if (used > 0) {
      await prisma.product.update({ where: { id }, data: { isActive: false } });
      await audit({ user: request.user, action: 'update', entity: 'Product', entityId: id, summary: 'Deactivated (used on quotes)', ip: clientIp(request) });
      return { ok: true, deactivated: true };
    }
    const existing = await prisma.product.findUnique({ where: { id } });
    await prisma.product.delete({ where: { id } });
    const undoId = await audit({
      user: request.user, action: 'delete', entity: 'Product', entityId: id, summary: existing?.sku,
      undo: existing ? undoHardDelete('product', 'products', id, existing) : null, ip: clientIp(request),
    });
    return { ok: true, undoId };
  });
}
