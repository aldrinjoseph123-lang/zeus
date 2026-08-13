import { prisma } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { audit } from '../lib/audit.js';
import type { SessionUser } from '../auth/rbac.js';

/**
 * Offboarding: reassign a leaving user's records to another user, one module at a
 * time. No cascade — each checked module moves the rows that user directly owns. The
 * exact moved ids are kept on the TransferJob so the whole thing reverses cleanly.
 */

interface OwnerDelegate {
  count(args: { where: object }): Promise<number>;
  findMany(args: { where: object; select: { id: true } }): Promise<Array<{ id: string }>>;
  updateMany(args: { where: object; data: { ownerId: string } }): Promise<{ count: number }>;
}

const MODULES: Record<string, { label: string; delegate: () => OwnerDelegate; soft: boolean }> = {
  accounts: { label: 'Accounts', delegate: () => prisma.account as unknown as OwnerDelegate, soft: true },
  contacts: { label: 'Contacts', delegate: () => prisma.contact as unknown as OwnerDelegate, soft: true },
  leads: { label: 'Leads', delegate: () => prisma.lead as unknown as OwnerDelegate, soft: true },
  deals: { label: 'Deals', delegate: () => prisma.deal as unknown as OwnerDelegate, soft: true },
  activities: { label: 'Activities', delegate: () => prisma.activity as unknown as OwnerDelegate, soft: false },
  purchaseOrders: { label: 'Purchase orders', delegate: () => prisma.purchaseOrder as unknown as OwnerDelegate, soft: false },
  subscriptions: { label: 'Subscriptions', delegate: () => prisma.subscription as unknown as OwnerDelegate, soft: false },
};

export const TRANSFERABLE_MODULES = Object.entries(MODULES).map(([key, m]) => ({ key, label: m.label }));

function ownedWhere(moduleKey: string, userId: string): object {
  return { ownerId: userId, ...(MODULES[moduleKey].soft ? { deletedAt: null } : {}) };
}

/** How many records the user owns per module — the numbers shown before confirming. */
export async function previewTransfer(fromUserId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(MODULES)) {
    out[key] = await MODULES[key].delegate().count({ where: ownedWhere(key, fromUserId) });
  }
  return out;
}

export async function transferOwnership(input: {
  fromUserId: string; toUserId: string; modules: string[]; deactivate: boolean; byUser: SessionUser;
}): Promise<{ jobId: string; counts: Record<string, number>; total: number }> {
  const { fromUserId, toUserId, modules, deactivate, byUser } = input;
  if (fromUserId === toUserId) throw badRequest('Choose a different user to receive the records.');

  const [from, to] = await Promise.all([
    prisma.user.findUnique({ where: { id: fromUserId }, select: { id: true, name: true } }),
    prisma.user.findUnique({ where: { id: toUserId }, select: { id: true, name: true, isActive: true } }),
  ]);
  if (!from) throw notFound('Leaving user not found.');
  if (!to) throw notFound('Recipient user not found.');
  if (!to.isActive) throw badRequest('The recipient is deactivated — pick an active user.');

  const known = modules.filter((m) => m in MODULES);
  if (known.length === 0) throw badRequest('Select at least one module to transfer.');

  const counts: Record<string, number> = {};
  const snapshot: Record<string, string[]> = {};
  for (const key of known) {
    const ids = (await MODULES[key].delegate().findMany({ where: ownedWhere(key, fromUserId), select: { id: true } })).map((r) => r.id);
    if (ids.length) await MODULES[key].delegate().updateMany({ where: { id: { in: ids } }, data: { ownerId: toUserId } });
    counts[key] = ids.length;
    snapshot[key] = ids;
  }

  if (deactivate) await prisma.user.update({ where: { id: fromUserId }, data: { isActive: false } });

  const job = await prisma.transferJob.create({
    data: { fromUserId, toUserId, byUserId: byUser.id, modules: known, counts, snapshot, deactivated: deactivate },
  });

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await audit({
    user: byUser, action: 'transfer', entity: 'User', entityId: fromUserId,
    summary: `Transferred ${total} record(s) from ${from.name} to ${to.name}${deactivate ? `, deactivated ${from.name}` : ''}`,
  });
  return { jobId: job.id, counts, total };
}

/** Undo a transfer exactly: move the recorded ids back, only if still with the recipient. */
export async function reverseTransfer(jobId: string, byUser: SessionUser): Promise<{ restored: number }> {
  const job = await prisma.transferJob.findUnique({ where: { id: jobId } });
  if (!job) throw notFound('Transfer not found.');
  if (job.reversedAt) throw badRequest('This transfer has already been reversed.');

  const snapshot = job.snapshot as Record<string, string[]>;
  let restored = 0;
  for (const [key, ids] of Object.entries(snapshot)) {
    if (!(key in MODULES) || ids.length === 0) continue;
    // Only rows still owned by the recipient — never clobber a later reassignment.
    const r = await MODULES[key].delegate().updateMany({ where: { id: { in: ids }, ownerId: job.toUserId } as object, data: { ownerId: job.fromUserId } });
    restored += r.count;
  }
  if (job.deactivated) await prisma.user.update({ where: { id: job.fromUserId }, data: { isActive: true } }).catch(() => undefined);
  await prisma.transferJob.update({ where: { id: jobId }, data: { reversedAt: new Date() } });
  await audit({ user: byUser, action: 'transfer', entity: 'User', entityId: job.fromUserId, summary: `Reversed transfer ${jobId}: ${restored} record(s) returned` });
  return { restored };
}

/** A user's full book of business as structured JSON — for archive or handover. */
export async function exportUserBook(userId: string): Promise<Record<string, unknown[]>> {
  const [accounts, contacts, leads, deals, activities] = await Promise.all([
    prisma.account.findMany({ where: ownedWhere('accounts', userId), select: { id: true, name: true, type: true, domain: true, email: true, phone: true, city: true, emirate: true } }),
    prisma.contact.findMany({ where: ownedWhere('contacts', userId), select: { id: true, firstName: true, lastName: true, email: true, phone: true, jobTitle: true, accountId: true } }),
    prisma.lead.findMany({ where: ownedWhere('leads', userId), select: { id: true, firstName: true, lastName: true, company: true, email: true, status: true } }),
    prisma.deal.findMany({ where: ownedWhere('deals', userId), select: { id: true, reference: true, name: true, amount: true, status: true, accountId: true } }),
    prisma.activity.findMany({ where: ownedWhere('activities', userId), select: { id: true, type: true, subject: true, status: true, dueAt: true } }),
  ]);
  return { accounts, contacts, leads, deals, activities };
}
