import { prisma } from '../db.js';
import { portalScope, type PortalSession } from './access.js';
import { resolvePartnerSwitches } from './switches.js';

/**
 * What a partner sees: their registered deals, both sides of the channel.
 *
 * "Ours" is the PARTNER-side registration — the partner's protection with us. "Vendors"
 * are the same deal's VENDOR-side registrations — our lock with each vendor. That pair
 * is the whole trust story; the countdown is the product.
 *
 * Rules that make a sloppy internal row safe to show:
 *   - DRAFT is not a fact yet and never appears; REJECTED never appears.
 *   - EXPIRED stays visible for 30 days after its date, then drops off.
 *   - A missing date is "pending", never a blank.
 * The shape below is the allowlist: nothing else on the row is serialised — not the
 * approved discount, not the deal's amount unless the switch says so, not the notes.
 */
export interface PortalRegistration {
  id: string;
  deal: {
    reference: string;
    endCustomer: string;
    /** Where the opportunity stands in our pipeline — "Proposal", "Negotiation", "Won". */
    stage?: string;
    value?: number;
    /** The total on the latest quote we sent the customer, if there is one. */
    quoted?: number;
  };
  ours: RegistrationSide;
  vendors: Array<RegistrationSide & { vendor: string }>;
}
export interface RegistrationSide {
  status: 'SUBMITTED' | 'APPROVED' | 'EXPIRED';
  submittedAt: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  /** Whole days until expiry; negative once lapsed; null when no date is set. */
  daysLeft: number | null;
  regNumber?: string | null;
}

const VISIBLE = ['SUBMITTED', 'APPROVED', 'EXPIRED'] as const;
const EXPIRED_GRACE_DAYS = 30;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const daysLeft = (d: Date | null) => (d ? Math.ceil((d.getTime() - Date.now()) / 86_400_000) : null);
const stillWorthShowing = (r: { status: string; expiresAt: Date | null }) =>
  r.status !== 'EXPIRED' || !r.expiresAt || Date.now() - r.expiresAt.getTime() < EXPIRED_GRACE_DAYS * 86_400_000;

export async function partnerRegistrations(session: PortalSession): Promise<PortalRegistration[]> {
  const { accountId } = portalScope(session);
  const { showRegNumber, showDealValue, showStage, showQuotedValue } = await resolvePartnerSwitches(accountId);

  const rows = await prisma.dealRegistration.findMany({
    where: { side: 'PARTNER', partnerId: accountId, status: { in: [...VISIBLE] }, deal: { deletedAt: null } },
    select: {
      id: true, status: true, submittedAt: true, approvedAt: true, expiresAt: true, regNumber: true,
      deal: {
        select: {
          id: true, reference: true, amount: true,
          stage: { select: { name: true, isWon: true, isLost: true } },
          account: { select: { name: true } },
          // "What did you quote them" is the latest quote that actually went out — a draft
          // is not a number the customer has seen, and a rejected one is not the offer.
          quotes: { where: { status: { in: ['SENT', 'ACCEPTED'] } }, orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }], take: 1, select: { total: true } },
          registrations: {
            where: { side: 'VENDOR', status: { in: [...VISIBLE] } },
            select: { status: true, submittedAt: true, approvedAt: true, expiresAt: true, regNumber: true, vendor: { select: { name: true } } },
            orderBy: { expiresAt: 'asc' },
          },
        },
      },
    },
    orderBy: [{ expiresAt: 'asc' }],
  });

  const side = (r: { status: string; submittedAt: Date | null; approvedAt: Date | null; expiresAt: Date | null; regNumber: string | null }): RegistrationSide => ({
    status: r.status as RegistrationSide['status'],
    submittedAt: iso(r.submittedAt),
    approvedAt: iso(r.approvedAt),
    expiresAt: iso(r.expiresAt),
    daysLeft: daysLeft(r.expiresAt),
    ...(showRegNumber ? { regNumber: r.regNumber } : {}),
  });

  return rows
    .filter(stillWorthShowing)
    .map((r) => ({
      id: r.id,
      deal: {
        reference: r.deal.reference,
        endCustomer: r.deal.account.name,
        ...(showStage ? { stage: r.deal.stage.isWon ? 'Won' : r.deal.stage.isLost ? 'Lost' : r.deal.stage.name } : {}),
        ...(showDealValue ? { value: Number(r.deal.amount) } : {}),
        ...(showQuotedValue && r.deal.quotes[0] ? { quoted: Number(r.deal.quotes[0].total) } : {}),
      },
      ours: side(r),
      vendors: r.deal.registrations.filter(stillWorthShowing).map((v) => ({ ...side(v), vendor: v.vendor?.name ?? 'Vendor' })),
    }))
    // Soonest expiry first; rows with no date go last.
    .sort((a, b) => (a.ours.daysLeft ?? Number.MAX_SAFE_INTEGER) - (b.ours.daysLeft ?? Number.MAX_SAFE_INTEGER));
}
