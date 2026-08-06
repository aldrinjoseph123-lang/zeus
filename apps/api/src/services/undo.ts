import { prisma } from '../db.js';
import { can, type SessionUser } from '../auth/rbac.js';

/**
 * Undo.
 *
 * Every mutation already writes an audit entry. An undoable one carries the recipe for
 * putting it back — which model, which row, and what the row looked like before. Undo
 * replays that recipe; it does not try to reverse-engineer the action after the fact.
 *
 * Three kinds:
 *   soft-delete — clear deletedAt, the row never left
 *   hard-delete — recreate the row from its snapshot, same id, so links still resolve
 *   update      — write the `from` side of the recorded diff back
 *
 * What is deliberately NOT undoable: anything already filed or paid against, and the
 * approvals themselves. Reversing a signature silently would turn the control into
 * decoration — reject it and submit again instead.
 */

export type UndoKind = 'soft-delete' | 'hard-delete' | 'update';

export interface UndoPayload {
  kind: UndoKind;
  /** Prisma model name, e.g. "deal", "purchaseOrder". */
  model: string;
  id: string;
  /** Full row for a hard delete; only the changed fields for an update. */
  before?: Record<string, unknown>;
  /** RBAC module the original action needed, so undo needs it too. */
  module: string;
  /** Child rows to recreate alongside the parent — a quote is nothing without its lines. */
  children?: Record<string, Array<Record<string, unknown>>>;
  /** Totals to rebuild once the row is back, so derived money stays true. */
  refresh?: { kind: 'invoice' | 'purchaseOrder'; id: string };
}

/** Relation and derived columns that must not be written back verbatim. */
const SKIP = new Set(['createdAt', 'updatedAt', 'id']);

/** Fields Zeus computes and must never accept from a snapshot. */
const DERIVED = new Set(['amountPaid', 'quantityReceived']);

export function undoLabel(entry: { action: string; entity: string; summary: string | null }): string {
  const what = entry.summary ? `${entry.entity} ${entry.summary}` : entry.entity;
  return entry.action === 'delete' ? `Deleted ${what}` : `Changed ${what}`;
}

/**
 * Guards that stand between a stray click and a broken ledger. Returns a reason to
 * refuse, or null when the reversal is safe.
 */
export async function refuseReason(payload: UndoPayload, user: SessionUser): Promise<string | null> {
  if (!can(user, payload.module, payload.kind === 'update' ? 'update' : 'delete')) {
    return `Your role (${user.roleName}) cannot undo changes to ${payload.module}.`;
  }

  if (payload.model === 'invoice') {
    const invoice = await prisma.invoice.findUnique({ where: { id: payload.id }, select: { status: true, number: true } });
    // A restored draft is fine; touching a filed document is not.
    if (invoice && ['SENT', 'PARTIAL', 'PAID', 'OVERDUE'].includes(invoice.status)) {
      return `${invoice.number} has been issued. Raise a credit note rather than undoing it.`;
    }
  }

  if (payload.model === 'purchaseOrder') {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: payload.id },
      select: { number: true, _count: { select: { payments: true } } },
    });
    if (po && po._count.payments > 0) return `${po.number} has payments recorded against it — undo would leave the cash position wrong.`;
  }

  if (payload.kind === 'update' && payload.before && 'approvalStatus' in payload.before) {
    return 'Approvals are not undone. Reject it and submit it again so the decision stays on the record.';
  }

  return null;
}

type Delegate = {
  update: (args: unknown) => Promise<unknown>;
  create: (args: unknown) => Promise<unknown>;
  findUnique: (args: unknown) => Promise<unknown>;
};

const delegate = (model: string): Delegate => {
  const client = prisma as unknown as Record<string, Delegate>;
  const d = client[model];
  if (!d?.update) throw new Error(`Cannot undo: "${model}" is not a model Zeus can restore.`);
  return d;
};

/** Puts it back. Throws with a readable message when it cannot. */
export async function applyUndo(payload: UndoPayload): Promise<void> {
  const d = delegate(payload.model);

  if (payload.kind === 'soft-delete') {
    await d.update({ where: { id: payload.id }, data: { deletedAt: null } });
    return;
  }

  if (payload.kind === 'hard-delete') {
    if (!payload.before) throw new Error('Cannot undo: nothing was recorded about the deleted record.');
    const existing = await d.findUnique({ where: { id: payload.id } });
    if (existing) throw new Error('That record is already back — nothing to undo.');
    const data: Record<string, unknown> = { id: payload.id };
    for (const [key, value] of Object.entries(payload.before)) {
      if (SKIP.has(key) && key !== 'id') continue;
      if (DERIVED.has(key)) continue;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // Nested relation objects are not restorable as-is; the foreign keys beside
        // them are, and those are what the row actually needs.
        continue;
      }
      if (Array.isArray(value)) continue;
      data[key] = value;
    }
    for (const [relation, rows] of Object.entries(payload.children ?? {})) {
      data[relation] = { create: rows.map((row) => stripChild(row)) };
    }
    await d.create({ data });
    await rebuild(payload);
    return;
  }

  const hasChildren = Object.keys(payload.children ?? {}).length > 0;
  if ((!payload.before || Object.keys(payload.before).length === 0) && !hasChildren) {
    throw new Error('Cannot undo: no previous values were recorded for that change.');
  }
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload.before ?? {})) {
    if (SKIP.has(key) || DERIVED.has(key)) continue;
    data[key] = value;
  }

  /**
   * Line edits replace the whole set rather than diffing it, so undoing one has to put
   * the whole set back. Prisma does the delete and the recreate inside the same update,
   * which matters — a half-restored document is worse than an un-restored one.
   */
  for (const [relation, rows] of Object.entries(payload.children ?? {})) {
    data[relation] = { deleteMany: {}, create: rows.map((row) => stripChild(row)) };
  }

  await d.update({ where: { id: payload.id }, data });
  await rebuild(payload);
  await rebuild(payload);
}

/** A child row keeps its own id and columns, but not its parent link or nested objects. */
function stripChild(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'createdAt' || key === 'updatedAt') continue;
    if (key.endsWith('Id') && key !== 'productId') continue;
    if (value !== null && typeof value === 'object') continue;
    out[key] = value;
  }
  return out;
}

/** Money that Zeus derives rather than stores has to be recomputed after a restore. */
async function rebuild(payload: UndoPayload): Promise<void> {
  const commercial = await import('../lib/commercial.js');

  /**
   * Restoring lines without recomputing the document leaves totals describing the lines
   * that were there a moment ago — which is a worse state than the one being undone,
   * because it looks settled.
   */
  if (Object.keys(payload.children ?? {}).length > 0) {
    if (payload.model === 'quote') await commercial.recalcQuote(payload.id);
    else if (payload.model === 'invoice') await commercial.recalcInvoice(payload.id);
    else if (payload.model === 'purchaseOrder') await commercial.recalcPurchaseOrder(payload.id);
  }

  if (!payload.refresh) return;
  if (payload.refresh.kind === 'invoice') await commercial.refreshInvoicePayment(payload.refresh.id);
  else await commercial.refreshPurchaseOrderPayment(payload.refresh.id);
}

/** The `from` side of a recorded diff — what an update has to be set back to. */
export function beforeFromChanges(changes: Record<string, { from: unknown; to: unknown }> | null): Record<string, unknown> {
  const before: Record<string, unknown> = {};
  for (const [field, change] of Object.entries(changes ?? {})) before[field] = change.from;
  return before;
}
