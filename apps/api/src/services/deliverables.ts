import { prisma } from '../db.js';

/**
 * Deliverables — what a subscription includes and how much of it is left.
 *
 * Remaining is always derived: entitlement quantity minus the sum of its deliveries.
 * Nothing stores a running balance, so nothing can drift. One place computes it for
 * the internal UI, the portal, and the integrity sweep alike.
 */
export interface DeliverySummary {
  id: string;
  quantity: number;
  status: 'SCHEDULED' | 'DELIVERED';
  scheduledFor: string | null;
  deliveredAt: string | null;
  reference: string | null;
}
export interface EntitlementSummary {
  id: string;
  label: string;
  unit: string;
  included: number;
  used: number;
  remaining: number;
  validFrom: string;
  validTo: string;
  deliveries: DeliverySummary[];
}

export async function entitlementsForSubscription(subscriptionId: string): Promise<EntitlementSummary[]> {
  const rows = await prisma.entitlement.findMany({
    where: { subscriptionId },
    include: { deliveries: { orderBy: [{ deliveredAt: 'asc' }, { scheduledFor: 'asc' }] } },
    orderBy: { validTo: 'asc' },
  });
  return rows.map((e) => {
    const included = Number(e.quantity);
    // Both scheduled and delivered draw the entitlement down: a booked assessment is
    // spoken for even before it happens, so "remaining" means "still bookable".
    const used = e.deliveries.reduce((sum, d) => sum + Number(d.quantity), 0);
    return {
      id: e.id,
      label: e.label,
      unit: e.unit,
      included,
      used,
      remaining: included - used,
      validFrom: e.validFrom.toISOString(),
      validTo: e.validTo.toISOString(),
      deliveries: e.deliveries.map((d) => ({
        id: d.id,
        quantity: Number(d.quantity),
        status: d.status as DeliverySummary['status'],
        scheduledFor: d.scheduledFor?.toISOString() ?? null,
        deliveredAt: d.deliveredAt?.toISOString() ?? null,
        reference: d.reference,
      })),
    };
  });
}

/**
 * Entitlements with value the customer has not used and time running out — a delivery
 * reminder for the team and an upsell prompt in one. Within `withinDays` of the valid-to
 * date and still something remaining.
 */
export async function unusedEntitlements(withinDays = 60): Promise<Array<{ id: string; label: string; remaining: number; unit: string; validTo: Date; subscription: { id: string; reference: string; account: { name: string }; ownerId: string | null } }>> {
  const soon = new Date(Date.now() + withinDays * 86_400_000);
  const rows = await prisma.entitlement.findMany({
    where: { validTo: { gt: new Date(), lt: soon } },
    include: { deliveries: { select: { quantity: true } }, subscription: { select: { id: true, reference: true, deletedAt: true, ownerId: true, account: { select: { name: true } } } } },
  });
  return rows
    .filter((e) => !e.subscription.deletedAt)
    .map((e) => ({ e, remaining: Number(e.quantity) - e.deliveries.reduce((s, d) => s + Number(d.quantity), 0) }))
    .filter(({ remaining }) => remaining > 0)
    .map(({ e, remaining }) => ({ id: e.id, label: e.label, remaining, unit: e.unit, validTo: e.validTo, subscription: e.subscription }));
}
