import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../services/graph.js';
import { badRequest, clientIp, listParams, notFound, paged, requirePermission } from '../lib/http.js';

/**
 * The record of every email Zeus has sent.
 *
 * Read-only apart from one action: replaying a failure. Status is what Microsoft
 * Graph actually reports — it accepts a message or refuses it — so a row says SENT
 * meaning handed over, never "delivered", which this API does not tell us.
 */
export default async function emailLogRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/email-log', { preHandler: requirePermission('audit', 'read') }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const params = listParams(q, 'createdAt');
    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.kind) where.kind = q.kind;
    if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) };
    if (params.search) {
      where.OR = [
        { subject: { contains: params.search, mode: 'insensitive' } },
        { to: { has: params.search.toLowerCase() } },
        { preview: { contains: params.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.emailLog.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (params.page - 1) * params.pageSize, take: params.pageSize,
        select: {
          id: true, createdAt: true, to: true, cc: true, subject: true, preview: true, kind: true,
          status: true, error: true, entity: true, entityId: true, attachments: true, resentFromId: true,
          user: { select: { id: true, name: true } },
        },
      }),
      prisma.emailLog.count({ where }),
    ]);
    return paged(rows, total, params);
  });

  /** Counts for the header, over the same window the list defaults to. */
  app.get('/api/email-log/summary', { preHandler: requirePermission('audit', 'read') }, async () => {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [sent, failed, total, byKind] = await Promise.all([
      prisma.emailLog.count({ where: { status: 'SENT', createdAt: { gte: since } } }),
      prisma.emailLog.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
      prisma.emailLog.count(),
      prisma.emailLog.groupBy({ by: ['kind'], _count: { _all: true }, where: { createdAt: { gte: since } } }),
    ]);
    return { last30: { sent, failed }, total, byKind: byKind.map((k) => ({ kind: k.kind, count: k._count._all })) };
  });

  /**
   * Send a failure again, exactly as it was. The stored payload is the original
   * message — same body, same attachments — so nothing is regenerated from a record
   * that may have moved on since. A success clears the payload and leaves the failure
   * in place: the log keeps the history, including that it went wrong first.
   */
  app.post('/api/email-log/:id/resend', { preHandler: requirePermission('audit', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const row = await prisma.emailLog.findUnique({ where: { id } });
    if (!row) throw notFound('That email is not in the log.');
    if (row.status !== 'FAILED') throw badRequest('Only a failed email can be sent again.');
    const payload = row.payload as { html?: string; attachments?: Array<{ filename: string; contentBytes: string; contentType: string }> } | null;
    if (!payload?.html) throw badRequest('The original message is no longer stored, so it cannot be replayed. Send it again from the record itself.');

    await sendMail({
      to: row.to, cc: row.cc, subject: row.subject, html: payload.html, attachments: payload.attachments,
      log: { kind: row.kind, entity: row.entity ?? undefined, entityId: row.entityId ?? undefined, userId: request.user.id, resentFromId: row.id },
    });
    // It went: the payload has done its job and is no longer worth keeping. DbNull, not
    // undefined — Prisma reads undefined as "leave this column alone".
    await prisma.emailLog.update({ where: { id }, data: { payload: Prisma.DbNull } });
    await audit({ user: request.user, action: 'integration', entity: 'EmailLog', entityId: id, summary: `Resent "${row.subject}" to ${row.to.join(', ')}`, ip: clientIp(request) });
    return { ok: true };
  });

  app.get('/api/email-log/:id', { preHandler: requirePermission('audit', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const row = await prisma.emailLog.findUnique({
      where: { id },
      select: {
        id: true, createdAt: true, to: true, cc: true, subject: true, preview: true, kind: true, status: true,
        error: true, entity: true, entityId: true, attachments: true, resentFromId: true, payload: true,
        user: { select: { id: true, name: true } },
      },
    });
    if (!row) throw notFound('That email is not in the log.');
    const { payload, ...rest } = row;
    return { ...rest, canResend: rest.status === 'FAILED' && Boolean((payload as { html?: string } | null)?.html) };
  });
}

/** Keep a year of history; drop the stored payload of anything older than a month. */
export async function pruneEmailLog(keepDays = 365, payloadDays = 30): Promise<number> {
  await prisma.emailLog.updateMany({
    where: { createdAt: { lt: new Date(Date.now() - payloadDays * 86_400_000) }, NOT: { payload: { equals: Prisma.DbNull } } },
    data: { payload: Prisma.DbNull },
  });
  const { count } = await prisma.emailLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - keepDays * 86_400_000) } } });
  return count;
}
