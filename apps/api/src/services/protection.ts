import { prisma } from '../db.js';
import type { SessionUser } from '../auth/rbac.js';

/**
 * Partner protection — who holds an end customer, and until when.
 *
 * A partner that registers an end customer with us owns it for the protection period, so
 * a second partner arriving at the same customer is a conflict someone has to settle.
 * Today that is settled by conversation and recollection; this settles it with a date.
 *
 * Two deliberate choices, both the stricter of the options available:
 *
 *  - **Any vendor.** Whoever registered the customer first holds it, whatever is being
 *    sold. Simpler to explain to a partner, and it will one day block a firewall deal
 *    because of an email-security registration. The override is deliberately easy for
 *    exactly that day, and matching on vendor too is a one-line change if it comes often.
 *  - **Only live protection blocks.** Approved, and not yet expired. Without that,
 *    every customer ever registered would stay locked to its first partner forever and
 *    the rule would become something people route around rather than work with.
 */

/** Roles trusted to overrule a partner's protection. The same two that sign off money. */
const MAY_OVERRIDE = new Set(['Administrator', 'Sales Manager']);

export interface Protection {
  registrationId: string;
  partnerId: string;
  partnerName: string;
  dealReference: string;
  registeredAt: Date | null;
  expiresAt: Date | null;
}

/**
 * The live protection on an end customer, if any partner holds it.
 *
 * `exceptPartnerId` lets the partner already holding a customer register again without
 * being blocked by itself — a second opportunity at a customer you own is not a conflict.
 * `exceptDealId` does the same for another registration on the deal being edited.
 */
export async function liveProtectionOn(
  accountId: string,
  opts: { exceptPartnerId?: string | null; exceptDealId?: string | null } = {},
): Promise<Protection | null> {
  const held = await prisma.dealRegistration.findFirst({
    where: {
      side: 'PARTNER',
      status: 'APPROVED',
      expiresAt: { gt: new Date() },
      partnerId: { not: null, ...(opts.exceptPartnerId ? { notIn: [opts.exceptPartnerId] } : {}) },
      deal: {
        accountId,
        deletedAt: null,
        ...(opts.exceptDealId ? { id: { not: opts.exceptDealId } } : {}),
      },
    },
    orderBy: { expiresAt: 'desc' },
    select: {
      id: true,
      partnerId: true,
      submittedAt: true,
      expiresAt: true,
      partner: { select: { name: true } },
      deal: { select: { reference: true } },
    },
  });
  if (!held?.partnerId) return null;

  return {
    registrationId: held.id,
    partnerId: held.partnerId,
    partnerName: held.partner?.name ?? 'another partner',
    dealReference: held.deal.reference,
    registeredAt: held.submittedAt,
    expiresAt: held.expiresAt,
  };
}

/** Says who holds it and until when, because a date ends an argument a rule cannot. */
export function protectionMessage(p: Protection): string {
  const until = p.expiresAt ? p.expiresAt.toLocaleDateString('en-GB') : 'an unrecorded date';
  const since = p.registeredAt ? ` since ${p.registeredAt.toLocaleDateString('en-GB')}` : '';
  return `${p.partnerName} holds this customer${since}, on ${p.dealReference}, until ${until}.`;
}

export const mayOverrideProtection = (user: SessionUser): boolean => MAY_OVERRIDE.has(user.roleName);

/**
 * Vendors a partner is quoting but is not enabled to sell.
 *
 * Informs, never blocks. Enablement is the newest and least trustworthy data here, and a
 * gate built on a record someone forgot to renew stops real business to protect a
 * spreadsheet. Zeus already refuses in one place — protection — and doing it twice would
 * make it a gate rather than a record.
 *
 * A deal's vendors come from what has actually been quoted on it: the products on its
 * quote lines. A vendor-side registration counts too, since registering a deal with a
 * vendor is as firm a statement of what is being sold as a quote line.
 */
export async function unenabledVendorsOn(dealId: string, partnerAccountId: string | null): Promise<string[]> {
  if (!partnerAccountId) return [];

  const [lines, registrations] = await Promise.all([
    prisma.quoteLine.findMany({
      where: { quote: { dealId }, product: { vendorId: { not: null } } },
      select: { product: { select: { vendorId: true, vendor: { select: { name: true } } } } },
    }),
    prisma.dealRegistration.findMany({
      where: { dealId, side: 'VENDOR', vendorId: { not: null } },
      select: { vendorId: true, vendor: { select: { name: true } } },
    }),
  ]);

  const vendors = new Map<string, string>();
  for (const l of lines) if (l.product?.vendorId) vendors.set(l.product.vendorId, l.product.vendor?.name ?? 'a vendor');
  for (const r of registrations) if (r.vendorId) vendors.set(r.vendorId, r.vendor?.name ?? 'a vendor');
  if (vendors.size === 0) return [];

  // Expired enablement does not count as enabled — that is the whole point of the expiry.
  const live = await prisma.partnerEnablement.findMany({
    where: { partnerId: partnerAccountId, vendorId: { in: [...vendors.keys()] }, expiresAt: { gt: new Date() } },
    select: { vendorId: true },
  });
  for (const e of live) vendors.delete(e.vendorId);
  return [...vendors.values()];
}
