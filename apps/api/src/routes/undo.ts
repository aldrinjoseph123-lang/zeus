import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, notFound } from '../lib/http.js';
import { applyUndo, refuseReason, undoLabel, type UndoPayload } from '../services/undo.js';
import { getSetting } from '../lib/settings.js';

/**
 * Undo, driven off the audit log.
 *
 * Anyone can undo their own recent change; undoing someone else's needs the same
 * permission the original action needed, which the guard already checks. An undo is
 * itself audited — the trail shows the change and the reversal, never a gap.
 */

export default async function undoRoutes(app: FastifyInstance): Promise<void> {
  /** This user's recent reversible changes — what the header panel lists. */
  app.get('/api/undo/recent', async (request) => {
    const hours = Number(await getSetting<number>('undo.windowHours', 72));
    const entries = await prisma.auditLog.findMany({
      where: {
        userId: request.user.id,
        undo: { not: Prisma.DbNull },
        undoneAt: null,
        at: { gte: new Date(Date.now() - hours * 3_600_000) },
      },
      orderBy: { at: 'desc' },
      take: 20,
      select: { id: true, action: true, entity: true, entityId: true, summary: true, at: true, undo: true },
    });

    return entries.flatMap((entry) => {
      const payload = entry.undo as unknown as UndoPayload | null;
      // Older rows predate the undo column, and JSON null reads back as a value.
      if (!payload?.kind) return [];
      return [{
        id: entry.id,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        label: undoLabel(entry),
        at: entry.at,
        kind: payload.kind,
      }];
    });
  });

  app.post('/api/undo/:id', async (request) => {
    const { id } = request.params as { id: string };
    const entry = await prisma.auditLog.findUnique({ where: { id } });
    if (!entry) throw notFound('That change is no longer on record.');
    const stored = entry.undo as unknown as UndoPayload | null;
    if (!stored?.kind) throw badRequest('That action cannot be undone.');
    if (entry.undoneAt) throw badRequest('That change has already been undone.');

    const hours = Number(await getSetting<number>('undo.windowHours', 72));
    if (Date.now() - entry.at.getTime() > hours * 3_600_000) {
      throw badRequest(`Undo only reaches back ${hours} hours. Restore it by hand, or widen the window in Settings.`);
    }

    const payload = stored;
    const refusal = await refuseReason(payload, request.user);
    if (refusal) throw badRequest(refusal);

    try {
      await applyUndo(payload);
    } catch (err) {
      throw badRequest((err as Error).message);
    }

    await prisma.auditLog.update({
      where: { id },
      data: { undoneAt: new Date(), undoneById: request.user.id },
    });
    await audit({
      user: request.user, action: 'undo', entity: entry.entity, entityId: entry.entityId,
      summary: `Undid: ${undoLabel(entry)}`, ip: clientIp(request),
    });

    return { ok: true, entity: entry.entity, entityId: entry.entityId, label: undoLabel(entry) };
  });
}
