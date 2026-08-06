import { prisma, num } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { formatAed } from '../lib/money.js';
import { notify } from './notify.js';

/**
 * Manager sign-off.
 *
 * Three records can commit the company to something it cannot quietly undo: a deal
 * closing won, a purchase order going to a supplier, an invoice going to a customer.
 * Each carries an approval state, and the step that commits it is blocked until a
 * user with `approve` on that module has signed it off.
 *
 * What needs approving is a Settings question, not a code question — turn a module
 * off, or set a threshold so only the deals worth a manager's attention stop.
 */

export type Entity = 'deals' | 'purchase-orders' | 'invoices';

export const ENTITIES: Record<
  Entity,
  {
    module: 'deals' | 'invoices';
    /** For people: headings, notification titles, refusal messages. */
    label: string;
    /**
     * For the audit log. It has to match what the record's own routes write, or the
     * history of one purchase order lands under two different names and filtering by
     * either shows half of it.
     */
    auditEntity: string;
    step: string;
  }
> = {
  deals: { module: 'deals', label: 'Deal', auditEntity: 'Deal', step: 'closing it won' },
  'purchase-orders': { module: 'invoices', label: 'Purchase order', auditEntity: 'PurchaseOrder', step: 'issuing it to the supplier' },
  invoices: { module: 'invoices', label: 'Invoice', auditEntity: 'Invoice', step: 'sending it to the customer' },
};

export interface Requirement {
  required: boolean;
  /** Why it stopped — shown to the rep so the rule is never a mystery. */
  reason?: string;
}

/**
 * Does this record need a signature? Value and margin are read from the record so the
 * rule stays honest even if someone edits the figures after submitting.
 */
export async function approvalRequired(
  entity: Entity,
  record: { amount?: unknown; total?: unknown; marginPct?: number | null },
): Promise<Requirement> {
  const keys = {
    deals: ['approvals.dealsEnabled', 'approvals.dealMinAmount'],
    'purchase-orders': ['approvals.purchaseOrdersEnabled', 'approvals.purchaseOrderMinAmount'],
    invoices: ['approvals.invoicesEnabled', 'approvals.invoiceMinAmount'],
  }[entity];

  const [enabled, threshold] = await Promise.all([
    getSetting<boolean>(keys[0], true),
    getSetting<number>(keys[1], 0),
  ]);
  if (!enabled) return { required: false };

  const value = num(record.total ?? record.amount);
  const floor = Number(threshold);

  if (entity === 'deals') {
    const minMargin = Number(await getSetting<number>('approvals.dealMinMarginPct', 0));
    if (minMargin > 0 && record.marginPct !== null && record.marginPct !== undefined && record.marginPct < minMargin) {
      return { required: true, reason: `Margin of ${record.marginPct.toFixed(1)}% is under the ${minMargin}% that can be signed off by a rep.` };
    }
  }

  if (value < floor) return { required: false };
  return {
    required: true,
    reason: floor > 0
      ? `${formatAed(value)} is over the ${formatAed(floor)} a rep can sign off alone.`
      : undefined,
  };
}

type Model = 'deal' | 'purchaseOrder' | 'invoice';
const MODEL: Record<Entity, Model> = { deals: 'deal', 'purchase-orders': 'purchaseOrder', invoices: 'invoice' };

/** The Prisma delegate for an entity — one place to keep the string-to-model mapping. */
export const delegateFor = (entity: Entity) => prisma[MODEL[entity]] as unknown as {
  findUnique: (args: unknown) => Promise<Record<string, unknown> | null>;
  update: (args: unknown) => Promise<Record<string, unknown>>;
};

/**
 * The gate itself. Called from the routes that perform the committing step, never
 * from a route that only saves a draft.
 */
export function blockedReason(record: { approvalStatus: string; approvalNote?: string | null }, entity: Entity): string | null {
  const { label, step } = ENTITIES[entity];
  if (record.approvalStatus === 'PENDING') {
    return `${label} is waiting on a manager's approval. ${step[0].toUpperCase()}${step.slice(1)} is blocked until it is signed off.`;
  }
  if (record.approvalStatus === 'REJECTED') {
    return `${label} was rejected${record.approvalNote ? ` — ${record.approvalNote}` : ''}. Fix it and submit for approval again before ${step}.`;
  }
  return null;
}

/** Everyone who can sign this off, so the request lands with the right people. */
export async function approverIds(entity: Entity): Promise<string[]> {
  const { module } = ENTITIES[entity];
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, role: { select: { permissions: true } } },
  });
  return users
    .filter((u) => {
      const perms = u.role.permissions as Record<string, { approve?: boolean; update?: string }> | null;
      const perm = perms?.[module];
      return perm ? perm.approve ?? perm.update === 'all' : false;
    })
    .map((u) => u.id);
}

export async function notifyRequested(entity: Entity, opts: {
  reference: string; title: string; value: number; link: string; requestedBy: string; note?: string | null;
}): Promise<void> {
  await notify({
    event: 'approval_requested',
    title: `Approval needed — ${opts.reference}`,
    body: `${opts.title} · ${formatAed(opts.value)} · requested by ${opts.requestedBy}`,
    link: opts.link,
    severity: 'warn',
    userIds: await approverIds(entity),
    facts: [
      { title: ENTITIES[entity].label, value: opts.reference },
      { title: 'Value', value: formatAed(opts.value) },
      { title: 'Requested by', value: opts.requestedBy },
      ...(opts.note ? [{ title: 'Note', value: opts.note }] : []),
    ],
  });
}

export async function notifyDecided(entity: Entity, opts: {
  approved: boolean; reference: string; link: string; ownerId: string | null; decidedBy: string; note?: string | null;
}): Promise<void> {
  await notify({
    event: 'approval_decided',
    title: `${opts.approved ? 'Approved' : 'Rejected'} — ${opts.reference}`,
    body: `${ENTITIES[entity].label} ${opts.approved ? 'approved' : 'rejected'} by ${opts.decidedBy}${opts.note ? ` — ${opts.note}` : ''}`,
    link: opts.link,
    severity: opts.approved ? 'info' : 'warn',
    ownerId: opts.ownerId,
    facts: [
      { title: ENTITIES[entity].label, value: opts.reference },
      { title: 'Decision', value: opts.approved ? 'Approved' : 'Rejected' },
      { title: 'By', value: opts.decidedBy },
      ...(opts.note ? [{ title: 'Note', value: opts.note }] : []),
    ],
  });
}
