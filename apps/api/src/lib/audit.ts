import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import type { SessionUser } from '../auth/rbac.js';
import type { UndoPayload } from '../services/undo.js';

type Diff = Record<string, { from: unknown; to: unknown }>;

/** Field-by-field diff so the audit trail shows what actually changed, not a blob. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown>): Diff {
  const out: Diff = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === 'updatedAt' || key === 'createdAt') continue;
    const from = before?.[key];
    const to = after[key];
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null ? null : v?.toString?.() ?? v);
    if (norm(from) !== norm(to)) out[key] = { from: norm(from), to: norm(to) };
  }
  return out;
}

export async function audit(opts: {
  user?: SessionUser | null;
  action: string;
  entity: string;
  entityId?: string | null;
  summary?: string;
  changes?: Diff | null;
  /** How to put this back. Omit for anything that cannot or must not be reversed. */
  undo?: UndoPayload | null;
  ip?: string;
}): Promise<string | null> {
  // Audit must never break the request it is recording.
  try {
    const entry = await prisma.auditLog.create({
      data: {
        userId: opts.user?.id ?? null,
        action: opts.action,
        entity: opts.entity,
        entityId: opts.entityId ?? null,
        summary: opts.summary ?? null,
        changes: (opts.changes && Object.keys(opts.changes).length ? opts.changes : null) as never,
        // Prisma wants an explicit DbNull for "no JSON here"; a bare null is ambiguous
        // and comes back out as a JSON null that every reader then has to guard.
        undo: (opts.undo ?? Prisma.DbNull) as never,
        ip: opts.ip ?? null,
      },
      select: { id: true },
    });
    return entry.id;
  } catch (err) {
    console.error('[audit] failed to write entry', err);
    return null;
  }
}

/**
 * Undo recipes.
 *
 * The recorded diff is normalised to strings for display, which is no use for writing
 * values back — so these read the raw row instead and keep native types, which is what
 * Prisma needs on the way in.
 */

/** A row that only had deletedAt stamped: put it back by clearing it. */
export const undoSoftDelete = (model: string, module: string, id: string): UndoPayload =>
  ({ kind: 'soft-delete', model, module, id });

/** A row that is really gone: keep the whole thing so it can be recreated. */
export const undoHardDelete = (
  model: string,
  module: string,
  id: string,
  row: Record<string, unknown>,
  extra?: Pick<UndoPayload, 'children' | 'refresh'>,
): UndoPayload => ({ kind: 'hard-delete', model, module, id, before: row, ...extra });

/** An edit: keep only what changed, in the values the row actually held. */
export function undoUpdate(
  model: string,
  module: string,
  id: string,
  before: Record<string, unknown>,
  changes: Diff,
): UndoPayload | null {
  const keys = Object.keys(changes);
  if (!keys.length) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) snapshot[key] = before[key] ?? null;
  return { kind: 'update', model, module, id, before: snapshot };
}
