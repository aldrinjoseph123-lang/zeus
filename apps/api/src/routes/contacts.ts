import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { sanitizeCustomFields } from '../lib/customFields.js';
import { audit, auditRead, diff, undoSoftDelete, undoUpdate } from '../lib/audit.js';
import { badRequest, clientIp, conflict, forbidden, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { maskFields, ownerAllowed, scopeWhere, stripUnwritableFields } from '../auth/rbac.js';
import { checkDuplicates } from '../services/dedupe.js';
import { touch } from '../lib/touch.js';

const contactSchema = z.object({
  firstName: z.string().min(1, 'First name is required.'),
  lastName: z.string().min(1, 'Last name is required.'),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  mobile: z.string().optional().nullable(),
  jobTitle: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  isPrimary: z.boolean().optional(),
  accountId: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  customFields: z.record(z.unknown()).optional(),
  ignoreDuplicates: z.boolean().optional(),
});

export default async function contactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/contacts', { preHandler: requirePermission('contacts', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>);
    const scope = await scopeWhere(request.user, 'contacts', 'read');
    const where: Record<string, unknown> = { deletedAt: null, ...scope };
    if (params.filters.accountId) where.accountId = params.filters.accountId;
    if (params.filters.ownerId) where.ownerId = params.filters.ownerId;
    if (params.search) {
      where.OR = [
        { firstName: { contains: params.search, mode: 'insensitive' } },
        { lastName: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
        { phone: { contains: params.search } },
        { account: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.contact.findMany({
        where,
        include: {
          account: { select: { id: true, name: true, type: true } },
          owner: { select: { id: true, name: true, avatarColor: true } },
        },
        orderBy: orderBy(params, ['firstName', 'lastName', 'createdAt', 'updatedAt']),
        skip: params.skip,
        take: params.take,
      }),
      prisma.contact.count({ where }),
    ]);
    return paged(maskFields(request.user, 'contacts', data), total, params);
  });

  app.get('/api/contacts/:id', { preHandler: requirePermission('contacts', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const contact = await prisma.contact.findFirst({
      where: { id, deletedAt: null },
      include: {
        account: { select: { id: true, name: true, type: true, domain: true } },
        owner: { select: { id: true, name: true, avatarColor: true } },
        deals: { where: { deletedAt: null }, include: { stage: { select: { name: true, color: true } } } },
        activities: { orderBy: { createdAt: 'desc' }, take: 50, include: { owner: { select: { name: true, avatarColor: true } } } },
        attachments: true,
      },
    });
    if (!contact) throw notFound('Contact not found.');
    if (!(await ownerAllowed(request.user, 'contacts', 'read', contact.ownerId))) throw forbidden();
    auditRead(request.user, 'Contact', contact.id, `${contact.firstName} ${contact.lastName}`, clientIp(request));
    return maskFields(request.user, 'contacts', contact);
  });

  app.post('/api/contacts', { preHandler: requirePermission('contacts', 'create') }, async (request, reply) => {
    const parsed = contactSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = stripUnwritableFields(request.user, 'contacts', parsed.data as Record<string, unknown>) as z.infer<typeof contactSchema>;

    if (body.email) {
      const dupes = await checkDuplicates({ module: 'contacts', email: body.email, name: `${body.firstName} ${body.lastName}` });
      if (dupes.hasDuplicates && !body.ignoreDuplicates) throw conflict('Possible duplicate — review before saving.', dupes);
    }

    const { ignoreDuplicates: _i, ...data } = body;
    const contact = await prisma.contact.create({
      data: {
        ...data,
        email: data.email || null,
        ownerId: data.ownerId ?? request.user.id,
        customFields: (await sanitizeCustomFields('contacts', data.customFields, {}, { enforceRequired: true })) as never,
      },
    });

    if (contact.isPrimary && contact.accountId) {
      await prisma.contact.updateMany({
        where: { accountId: contact.accountId, id: { not: contact.id } },
        data: { isPrimary: false },
      });
    }
    await touch({ accountId: contact.accountId });
    await audit({ user: request.user, action: 'create', entity: 'Contact', entityId: contact.id, summary: `${contact.firstName} ${contact.lastName}`, ip: clientIp(request) });
    return reply.status(201).send(maskFields(request.user, 'contacts', contact));
  });

  app.patch('/api/contacts/:id', { preHandler: requirePermission('contacts', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.contact.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Contact not found.');
    if (!(await ownerAllowed(request.user, 'contacts', 'update', existing.ownerId))) throw forbidden();

    const parsed = contactSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const { ignoreDuplicates: _i, ...body } = stripUnwritableFields(request.user, 'contacts', parsed.data as Record<string, unknown>);

    const contact = await prisma.contact.update({
      where: { id },
      data: {
        ...body,
        ...(body.email === '' ? { email: null } : {}),
        ...('customFields' in body
          ? { customFields: await sanitizeCustomFields('contacts', body.customFields, (existing.customFields ?? {}) as Record<string, unknown>) }
          : {}),
      } as never,
    });
    if (contact.isPrimary && contact.accountId) {
      await prisma.contact.updateMany({ where: { accountId: contact.accountId, id: { not: id } }, data: { isPrimary: false } });
    }
    await touch({ accountId: contact.accountId });
    await audit({
      user: request.user, action: 'update', entity: 'Contact', entityId: id,
      summary: `${contact.firstName} ${contact.lastName}`,
      changes: diff(existing as unknown as Record<string, unknown>, contact as unknown as Record<string, unknown>),
      undo: undoUpdate('contact', 'contacts', id, existing as unknown as Record<string, unknown>,
        diff(existing as unknown as Record<string, unknown>, contact as unknown as Record<string, unknown>)),
      ip: clientIp(request),
    });
    return maskFields(request.user, 'contacts', contact);
  });

  app.delete('/api/contacts/:id', { preHandler: requirePermission('contacts', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.contact.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Contact not found.');
    if (!(await ownerAllowed(request.user, 'contacts', 'delete', existing.ownerId))) throw forbidden();
    await prisma.contact.update({ where: { id }, data: { deletedAt: new Date() } });
    const undoId = await audit({ user: request.user, action: 'delete', entity: 'Contact', entityId: id, summary: `${existing.firstName} ${existing.lastName}`,
      undo: undoSoftDelete('contact', 'contacts', id), ip: clientIp(request) });
    return { ok: true, undoId };
  });

  /**
   * Right to erasure. Scrubs the PII fields in place rather than deleting the row —
   * the contact may still be the "attn:" on a quote or invoice that has to keep
   * meaning what it meant on the day it was issued. There is deliberately no undo:
   * an erasure that can be silently reversed is not one.
   */
  app.post('/api/contacts/:id/erase', { preHandler: requirePermission('contacts', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ reason: z.string().min(1, 'Say why this is being erased.') }).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const existing = await prisma.contact.findUnique({ where: { id } });
    if (!existing) throw notFound('Contact not found.');
    if (existing.erasedAt) throw badRequest('This contact has already been erased.');
    if (!(await ownerAllowed(request.user, 'contacts', 'delete', existing.ownerId))) throw forbidden();

    const now = new Date();
    await prisma.contact.update({
      where: { id },
      data: {
        firstName: 'Erased', lastName: 'contact', email: null, phone: null, mobile: null,
        jobTitle: null, department: null, linkedinUrl: null, description: null, customFields: {},
        deletedAt: now, erasedAt: now,
      },
    });
    await audit({
      user: request.user, action: 'update', entity: 'Contact', entityId: id,
      summary: `Personal data erased for ${existing.firstName} ${existing.lastName} — ${parsed.data.reason}`,
      ip: clientIp(request),
    });
    return { ok: true };
  });
}
