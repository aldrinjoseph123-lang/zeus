import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';

/**
 * Data retention.
 *
 * Two nightly sweeps: one clears out login IP/geo history the audit trail was keeping
 * forever, the other hard-purges leads that were soft-deleted and never touched again.
 * Everything else — accounts, contacts, deals, invoices — stays archived rather than
 * auto-destroyed, because those can carry invoices and other records downstream that a
 * blind purge would orphan or silently break the legal trail for.
 */

/** Login/2FA audit rows carry an IP — that is personal data with its own clock. */
export async function pruneLoginAudit(): Promise<number> {
  const days = Number(await getSetting<number>('auth.loginAuditRetentionDays', 180));
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const result = await prisma.auditLog.deleteMany({
    where: { action: { in: ['login', 'login_failed', 'login_pending_2fa'] }, at: { lt: cutoff } },
  });
  return result.count;
}

/**
 * A soft-deleted lead with nothing pointing at it (no activity logged, no file
 * attached) is safe to hard-delete outright — nothing downstream references it.
 */
export async function purgeExpiredLeads(): Promise<number> {
  const days = Number(await getSetting<number>('retention.deletedLeadDays', 0));
  if (days <= 0) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const candidates = await prisma.lead.findMany({
    where: { deletedAt: { not: null, lt: cutoff } },
    select: { id: true, _count: { select: { activities: true, attachments: true } } },
  });
  const purgeable = candidates.filter((l) => l._count.activities === 0 && l._count.attachments === 0).map((l) => l.id);
  if (!purgeable.length) return 0;

  const result = await prisma.lead.deleteMany({ where: { id: { in: purgeable } } });
  return result.count;
}
