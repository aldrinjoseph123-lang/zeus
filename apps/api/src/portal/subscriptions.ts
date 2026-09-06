import { prisma } from '../db.js';
import { portalScope, type PortalSession } from './access.js';

/**
 * What a customer sees: the services they own and when each renews.
 *
 * Scoped to the account on the session. The outbound shape is the allowlist — what the
 * customer bought, how much of it, and the dates. Never the economics: unitCost,
 * unitPrice, termValue, the vendor behind it, or the internal owner all stay in.
 *
 * States: ACTIVE and EXPIRING always; LAPSED for 30 days after it ended, so a customer
 * still sees a service that just ran out (and the renewal conversation has a peg), then
 * it drops off. CANCELLED and RENEWED never show — the first is gone, the second has a
 * live successor that shows in its place.
 */
export interface PortalSubscription {
  id: string;
  reference: string;
  description: string;
  product: string | null;
  quantity: number;
  unit: string;
  startDate: string;
  endDate: string;
  daysLeft: number;
  status: 'ACTIVE' | 'EXPIRING' | 'LAPSED';
}

const LAPSED_GRACE_DAYS = 30;
const daysLeft = (d: Date) => Math.ceil((d.getTime() - Date.now()) / 86_400_000);

export async function customerSubscriptions(session: PortalSession): Promise<PortalSubscription[]> {
  const { accountId } = portalScope(session);
  const rows = await prisma.subscription.findMany({
    where: {
      accountId,
      deletedAt: null,
      OR: [
        { status: { in: ['ACTIVE', 'EXPIRING'] } },
        { status: 'LAPSED', endDate: { gt: new Date(Date.now() - LAPSED_GRACE_DAYS * 86_400_000) } },
      ],
    },
    select: {
      id: true, reference: true, description: true, quantity: true, unit: true, startDate: true, endDate: true, status: true,
      product: { select: { name: true } },
    },
    orderBy: { endDate: 'asc' },
  });

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    description: r.description,
    product: r.product?.name ?? null,
    quantity: Number(r.quantity),
    unit: r.unit,
    startDate: r.startDate.toISOString(),
    endDate: r.endDate.toISOString(),
    daysLeft: daysLeft(r.endDate),
    status: r.status as PortalSubscription['status'],
  }));
}
