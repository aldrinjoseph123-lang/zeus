import { prisma } from '../db.js';
import { entitlementsForSubscription } from '../services/deliverables.js';
import { portalScope, type PortalSession } from './access.js';

/**
 * A customer's view of what one subscription includes: label, included, used,
 * remaining, valid-until, and each delivery dated with its status. The allowlist —
 * the internal notes on an entitlement or a delivery never leave. Returns null when
 * the subscription is not this account's, so the route answers 404 rather than
 * confirming the id exists.
 */
export interface PortalEntitlement {
  label: string;
  unit: string;
  included: number;
  used: number;
  remaining: number;
  validTo: string;
  deliveries: Array<{ status: 'SCHEDULED' | 'DELIVERED'; scheduledFor: string | null; deliveredAt: string | null; quantity: number; reference: string | null }>;
}

export async function portalEntitlements(session: PortalSession, subscriptionId: string): Promise<PortalEntitlement[] | null> {
  const sub = await prisma.subscription.findFirst({ where: { id: subscriptionId, deletedAt: null, ...portalScope(session) }, select: { id: true } });
  if (!sub) return null;
  const rows = await entitlementsForSubscription(subscriptionId);
  return rows.map((e) => ({
    label: e.label, unit: e.unit, included: e.included, used: e.used, remaining: e.remaining, validTo: e.validTo,
    deliveries: e.deliveries.map((d) => ({ status: d.status, scheduledFor: d.scheduledFor, deliveredAt: d.deliveredAt, quantity: d.quantity, reference: d.reference })),
  }));
}
