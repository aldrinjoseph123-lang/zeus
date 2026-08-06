import type { FastifyInstance } from 'fastify';
import type { ActivityType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, undoHardDelete } from '../lib/audit.js';
import { badRequest, clientIp, forbidden, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { ownerAllowed, scopeWhere } from '../auth/rbac.js';
import { touch } from '../lib/touch.js';

const activitySchema = z.object({
  type: z.enum(['TASK', 'CALL', 'MEETING', 'EMAIL', 'NOTE']).default('TASK'),
  subject: z.string().min(1, 'Subject is required.'),
  description: z.string().optional().nullable(),
  status: z.string().optional(),
  priority: z.string().optional(),
  dueAt: z.string().optional().nullable(),
  completedAt: z.string().optional().nullable(),
  durationMin: z.number().int().positive().optional().nullable(),
  outcome: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  accountId: z.string().optional().nullable(),
  contactId: z.string().optional().nullable(),
  leadId: z.string().optional().nullable(),
  dealId: z.string().optional().nullable(),
});

export default async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/activities', { preHandler: requirePermission('activities', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'dueAt');
    const scope = await scopeWhere(request.user, 'activities', 'read');
    const f = params.filters;

    const where: Record<string, unknown> = { ...scope };
    if (f.type) where.type = f.type;
    if (f.status) where.status = f.status;
    if (f.priority) where.priority = f.priority;
    if (f.ownerId) where.ownerId = f.ownerId;
    if (f.dealId) where.dealId = f.dealId;
    if (f.accountId) where.accountId = f.accountId;
    if (f.leadId) where.leadId = f.leadId;
    if (f.contactId) where.contactId = f.contactId;
    if (f.overdue === 'true') {
      where.status = 'Open';
      where.dueAt = { lt: new Date() };
    }
    if (f.dueBefore) where.dueAt = { ...(where.dueAt as object ?? {}), lte: new Date(f.dueBefore) };
    if (f.dueAfter) where.dueAt = { ...(where.dueAt as object ?? {}), gte: new Date(f.dueAfter) };
    if (params.search) where.subject = { contains: params.search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      prisma.activity.findMany({
        where,
        include: {
          owner: { select: { id: true, name: true, avatarColor: true } },
          account: { select: { id: true, name: true } },
          contact: { select: { id: true, firstName: true, lastName: true } },
          lead: { select: { id: true, company: true, firstName: true, lastName: true } },
          deal: { select: { id: true, reference: true, name: true } },
        },
        orderBy: orderBy(params, ['dueAt', 'createdAt', 'updatedAt', 'priority', 'type'], 'dueAt'),
        skip: params.skip,
        take: params.take,
      }),
      prisma.activity.count({ where }),
    ]);
    return paged(data, total, params);
  });

  app.post('/api/activities', { preHandler: requirePermission('activities', 'create') }, async (request, reply) => {
    const parsed = activitySchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = parsed.data;

    /**
     * Whether this is a record of something that happened, or a thing still to do.
     *
     * A note or an email is always already done. A call or a meeting being written up
     * has happened too — it only stays open if it carries a date still ahead of it. A
     * task is the one thing that defaults to open, because a task is by definition
     * something nobody has done yet.
     */
    const scheduled = body.dueAt ? new Date(body.dueAt).getTime() > Date.now() : false;
    const isLogged = body.type !== 'TASK' && !scheduled;
    const activity = await prisma.activity.create({
      data: {
        ...body,
        dueAt: body.dueAt ? new Date(body.dueAt) : null,
        completedAt: body.completedAt ? new Date(body.completedAt) : isLogged ? new Date() : null,
        status: body.status ?? (isLogged ? 'Completed' : 'Open'),
        ownerId: body.ownerId ?? request.user.id,
        createdById: request.user.id,
      },
    });

    await touch({ accountId: activity.accountId, dealId: activity.dealId, leadId: activity.leadId });
    await audit({ user: request.user, action: 'create', entity: 'Activity', entityId: activity.id, summary: activity.subject, ip: clientIp(request) });
    return reply.status(201).send(activity);
  });

  app.patch('/api/activities/:id', { preHandler: requirePermission('activities', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.activity.findUnique({ where: { id } });
    if (!existing) throw notFound('Activity not found.');
    if (!(await ownerAllowed(request.user, 'activities', 'update', existing.ownerId))) throw forbidden();

    const parsed = activitySchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = parsed.data;

    const data: Record<string, unknown> = { ...body };
    if (body.dueAt !== undefined) data.dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (body.completedAt !== undefined) data.completedAt = body.completedAt ? new Date(body.completedAt) : null;
    // Ticking "Completed" stamps the time without the client having to.
    if (body.status === 'Completed' && !existing.completedAt) data.completedAt = new Date();
    if (body.status && body.status !== 'Completed') data.completedAt = null;

    const activity = await prisma.activity.update({ where: { id }, data: data as never });
    await touch({ accountId: activity.accountId, dealId: activity.dealId, leadId: activity.leadId });
    await audit({ user: request.user, action: 'update', entity: 'Activity', entityId: id, summary: activity.subject, ip: clientIp(request) });
    return activity;
  });

  app.delete('/api/activities/:id', { preHandler: requirePermission('activities', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.activity.findUnique({ where: { id } });
    if (!existing) throw notFound('Activity not found.');
    if (!(await ownerAllowed(request.user, 'activities', 'delete', existing.ownerId))) throw forbidden();
    await prisma.activity.delete({ where: { id } });
    const undoId = await audit({
      user: request.user, action: 'delete', entity: 'Activity', entityId: id, summary: existing.subject,
      undo: undoHardDelete('activity', 'activities', id, existing), ip: clientIp(request),
    });
    return { ok: true, undoId };
  });

  /** "My day": overdue, due today, due this week — what the rep opens Zeus for. */
  app.get('/api/activities/my-day', { preHandler: requirePermission('activities', 'read') }, async (request) => {
    const now = new Date();
    const endOfToday = new Date(now); endOfToday.setHours(23, 59, 59, 999);
    const endOfWeek = new Date(endOfToday.getTime() + 6 * 86_400_000);
    const base = { ownerId: request.user.id, status: 'Open', type: { in: ['TASK', 'CALL', 'MEETING'] as ActivityType[] } };

    const include = {
      account: { select: { id: true, name: true } },
      deal: { select: { id: true, reference: true, name: true } },
      lead: { select: { id: true, company: true } },
    };

    const [overdue, today, thisWeek, unscheduled] = await Promise.all([
      prisma.activity.findMany({ where: { ...base, dueAt: { lt: now } }, include, orderBy: { dueAt: 'asc' }, take: 50 }),
      prisma.activity.findMany({ where: { ...base, dueAt: { gte: now, lte: endOfToday } }, include, orderBy: { dueAt: 'asc' }, take: 50 }),
      prisma.activity.findMany({ where: { ...base, dueAt: { gt: endOfToday, lte: endOfWeek } }, include, orderBy: { dueAt: 'asc' }, take: 50 }),
      prisma.activity.findMany({ where: { ...base, dueAt: null }, include, orderBy: { createdAt: 'desc' }, take: 25 }),
    ]);

    return { overdue, today, thisWeek, unscheduled };
  });
}
