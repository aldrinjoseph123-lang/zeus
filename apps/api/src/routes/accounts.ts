import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { sanitizeCustomFields } from '../lib/customFields.js';
import { audit, auditRead, diff, undoSoftDelete, undoUpdate } from '../lib/audit.js';
import { badRequest, clientIp, conflict, forbidden, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { maskFields, ownerAllowed, scopeWhere, stripUnwritableFields } from '../auth/rbac.js';
import { checkDuplicates, extractDomain } from '../services/dedupe.js';

const accountSchema = z.object({
  name: z.string().min(1, 'Account name is required.'),
  type: z.enum(['CUSTOMER', 'PARTNER', 'VENDOR', 'PROSPECT']).default('PROSPECT'),
  domain: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  employeeBand: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().optional().nullable(),
  trn: z.string().optional().nullable(),
  addressLine1: z.string().optional().nullable(),
  addressLine2: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  emirate: z.string().optional().nullable(),
  country: z.string().optional(),
  poBox: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  customFields: z.record(z.unknown()).optional(),
  /** Set by the client after the user has seen and dismissed the duplicate warning. */
  ignoreDuplicates: z.boolean().optional(),
});

const listSelect = {
  id: true, name: true, type: true, domain: true, industry: true, emirate: true, city: true,
  phone: true, email: true, lastActivityAt: true, createdAt: true, updatedAt: true,
  owner: { select: { id: true, name: true, avatarColor: true } },
  _count: { select: { contacts: true, deals: true } },
};

export default async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/accounts', { preHandler: requirePermission('accounts', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>);
    const scope = await scopeWhere(request.user, 'accounts', 'read');

    const where: Record<string, unknown> = { deletedAt: null, ...scope };
    if (params.filters.type) where.type = params.filters.type;
    if (params.filters.ownerId) where.ownerId = params.filters.ownerId;
    if (params.filters.industry) where.industry = params.filters.industry;
    if (params.filters.emirate) where.emirate = params.filters.emirate;
    if (params.filters.stale === 'true') {
      const days = Number(params.filters.staleDays ?? 7);
      where.OR = [
        { lastActivityAt: null },
        { lastActivityAt: { lt: new Date(Date.now() - days * 86_400_000) } },
      ];
    }
    if (params.search) {
      where.AND = [
        {
          OR: [
            { name: { contains: params.search, mode: 'insensitive' } },
            { domain: { contains: params.search.toLowerCase() } },
            { email: { contains: params.search, mode: 'insensitive' } },
            { trn: { contains: params.search } },
          ],
        },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.account.findMany({
        where,
        select: listSelect,
        orderBy: orderBy(params, ['name', 'createdAt', 'updatedAt', 'lastActivityAt', 'type']),
        skip: params.skip,
        take: params.take,
      }),
      prisma.account.count({ where }),
    ]);

    return paged(maskFields(request.user, 'accounts', data), total, params);
  });

  app.get('/api/accounts/:id', { preHandler: requirePermission('accounts', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const account = await prisma.account.findFirst({
      where: { id, deletedAt: null },
      include: {
        owner: { select: { id: true, name: true, avatarColor: true } },
        contacts: { where: { deletedAt: null }, orderBy: { isPrimary: 'desc' } },
        deals: {
          where: { deletedAt: null },
          orderBy: { updatedAt: 'desc' },
          take: 50,
          include: { stage: { select: { id: true, name: true, color: true, isWon: true, isLost: true } }, owner: { select: { name: true } } },
        },
        quotes: { orderBy: { createdAt: 'desc' }, take: 20 },
        invoices: { orderBy: { createdAt: 'desc' }, take: 20 },
        activities: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { owner: { select: { name: true, avatarColor: true } } },
        },
        attachments: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!account) throw notFound('Account not found.');
    if (!(await ownerAllowed(request.user, 'accounts', 'read', account.ownerId))) throw forbidden();
    auditRead(request.user, 'Account', account.id, account.name, clientIp(request));
    return maskFields(request.user, 'accounts', account);
  });

  /** Pre-flight duplicate check the form calls as the user types the domain. */
  app.get('/api/accounts/check-duplicates', { preHandler: requirePermission('accounts', 'read') }, async (request) => {
    const q = request.query as Record<string, string>;
    return checkDuplicates({
      module: 'accounts',
      name: q.name,
      company: q.name,
      email: q.email,
      website: q.website,
      domain: q.domain ? extractDomain(q.domain) : undefined,
      excludeId: q.excludeId,
    });
  });

  app.post('/api/accounts', { preHandler: requirePermission('accounts', 'create') }, async (request, reply) => {
    const parsed = accountSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = stripUnwritableFields(request.user, 'accounts', parsed.data as Record<string, unknown>) as z.infer<typeof accountSchema>;

    const domain = extractDomain(body.domain) ?? extractDomain(body.website) ?? extractDomain(body.email);
    const dupes = await checkDuplicates({ module: 'accounts', name: body.name, company: body.name, email: body.email, website: body.website, domain });
    if ((dupes.blocked || dupes.hasDuplicates) && !body.ignoreDuplicates) {
      throw conflict('Possible duplicate — review before saving.', dupes);
    }

    const { ignoreDuplicates: _ignored, ...data } = body;
    const account = await prisma.account.create({
      data: {
        ...data,
        domain,
        ownerId: data.ownerId ?? request.user.id,
        customFields: (await sanitizeCustomFields('accounts', data.customFields, {}, { enforceRequired: true })) as never,
        lastActivityAt: new Date(),
      },
    });

    await audit({ user: request.user, action: 'create', entity: 'Account', entityId: account.id, summary: account.name, ip: clientIp(request) });
    return reply.status(201).send(maskFields(request.user, 'accounts', account));
  });

  app.patch('/api/accounts/:id', { preHandler: requirePermission('accounts', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.account.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Account not found.');
    if (!(await ownerAllowed(request.user, 'accounts', 'update', existing.ownerId))) throw forbidden();

    const parsed = accountSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const { ignoreDuplicates: _ignored, ...body } = stripUnwritableFields(request.user, 'accounts', parsed.data as Record<string, unknown>);

    const data: Record<string, unknown> = { ...body };
    if ('domain' in body || 'website' in body || 'email' in body) {
      data.domain =
        extractDomain((body.domain as string) ?? existing.domain) ??
        extractDomain((body.website as string) ?? existing.website) ??
        extractDomain((body.email as string) ?? existing.email);
    }

    if ('customFields' in body) {
      data.customFields = await sanitizeCustomFields('accounts', body.customFields, (existing.customFields ?? {}) as Record<string, unknown>);
    }

    const account = await prisma.account.update({ where: { id }, data: data as never });
    await audit({
      user: request.user, action: 'update', entity: 'Account', entityId: id, summary: account.name,
      changes: diff(existing as unknown as Record<string, unknown>, account as unknown as Record<string, unknown>),
      undo: undoUpdate('account', 'accounts', id, existing as unknown as Record<string, unknown>,
        diff(existing as unknown as Record<string, unknown>, account as unknown as Record<string, unknown>)),
      ip: clientIp(request),
    });
    return maskFields(request.user, 'accounts', account);
  });

  app.delete('/api/accounts/:id', { preHandler: requirePermission('accounts', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.account.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Account not found.');
    if (!(await ownerAllowed(request.user, 'accounts', 'delete', existing.ownerId))) throw forbidden();

    const openDeals = await prisma.deal.count({ where: { accountId: id, status: 'OPEN', deletedAt: null } });
    if (openDeals > 0) throw badRequest(`This account has ${openDeals} open deal(s). Close or move them first.`);

    // Soft delete — a mis-click should never destroy customer history.
    await prisma.account.update({ where: { id }, data: { deletedAt: new Date() } });
    const undoId = await audit({ user: request.user, action: 'delete', entity: 'Account', entityId: id, summary: existing.name,
      undo: undoSoftDelete('account', 'accounts', id), ip: clientIp(request) });
    return { ok: true, undoId };
  });

  /** Merge a duplicate into a survivor: move children across, soft-delete the loser. */
  app.post('/api/accounts/:id/merge', { preHandler: requirePermission('accounts', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const { intoId } = z.object({ intoId: z.string() }).parse(request.body);
    if (id === intoId) throw badRequest('Pick a different account to merge into.');

    const [loser, winner] = await Promise.all([
      prisma.account.findFirst({ where: { id, deletedAt: null } }),
      prisma.account.findFirst({ where: { id: intoId, deletedAt: null } }),
    ]);
    if (!loser || !winner) throw notFound('One of the accounts no longer exists.');

    await prisma.$transaction([
      prisma.contact.updateMany({ where: { accountId: id }, data: { accountId: intoId } }),
      prisma.deal.updateMany({ where: { accountId: id }, data: { accountId: intoId } }),
      prisma.deal.updateMany({ where: { partnerAccountId: id }, data: { partnerAccountId: intoId } }),
      prisma.quote.updateMany({ where: { accountId: id }, data: { accountId: intoId } }),
      prisma.invoice.updateMany({ where: { accountId: id }, data: { accountId: intoId } }),
      prisma.activity.updateMany({ where: { accountId: id }, data: { accountId: intoId } }),
      prisma.attachment.updateMany({ where: { accountId: id }, data: { accountId: intoId } }),
      prisma.product.updateMany({ where: { vendorId: id }, data: { vendorId: intoId } }),
      prisma.dealRegistration.updateMany({ where: { vendorId: id }, data: { vendorId: intoId } }),
      prisma.account.update({ where: { id }, data: { deletedAt: new Date() } }),
      prisma.account.update({ where: { id: intoId }, data: { lastActivityAt: new Date() } }),
    ]);

    await audit({
      user: request.user, action: 'merge', entity: 'Account', entityId: intoId,
      summary: `Merged "${loser.name}" into "${winner.name}"`, ip: clientIp(request),
    });
    return { ok: true, survivorId: intoId };
  });
}
