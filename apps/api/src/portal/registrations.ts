import { prisma } from '../db.js';
import { registrationScope, type PortalSession } from './access.js';
import { resolvePartnerSwitches } from './switches.js';

/**
 * What a partner sees: their registered deals, both sides of the channel.
 *
 * "Ours" is the PARTNER-side registration — the partner's protection with us. "Vendors"
 * are the same deal's VENDOR-side registrations — our lock with each vendor. That pair
 * is the whole trust story; the countdown is the product.
 *
 * Who sees which rows is decided by registrationScope(): a member only the registrations
 * under their own name, the partner's admin all of them. Filters narrow what that scope
 * already allows and can never widen it — the facets offered (vendors, stages) are
 * drawn from the same scoped rows.
 *
 * Rules that make a sloppy internal row safe to show:
 *   - DRAFT is not a fact yet and never appears.
 *   - EXPIRED and REJECTED stay visible for 30 days, then drop off.
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
  status: 'SUBMITTED' | 'APPROVED' | 'EXPIRED' | 'REJECTED';
  submittedAt: string | null;
  approvedAt: string | null;
  expiresAt: string | null;
  /** Whole days until expiry; negative once lapsed; null when no date is set. */
  daysLeft: number | null;
  regNumber?: string | null;
}

export interface RegistrationFilters {
  q?: string;
  vendor?: string;
  status?: 'APPROVED' | 'SUBMITTED' | 'EXPIRED' | 'REJECTED';
  stage?: string;
  /** 30 | 60 | 90 days ahead, or "lapsed". */
  expiring?: string;
  sort?: 'expiry' | 'value' | 'newest';
  page?: number;
  pageSize?: number;
}

export interface PortalRegistrationPage {
  data: PortalRegistration[];
  total: number;
  page: number;
  pageSize: number;
  /** What the filters may offer — drawn from this person's own rows, nobody else's. */
  facets: { vendors: string[]; stages: string[]; statuses: string[] };
  /** "all" for the partner's admin, "mine" for a member. */
  scope: 'all' | 'mine';
}

const VISIBLE = ['SUBMITTED', 'APPROVED', 'EXPIRED', 'REJECTED'] as const;
const GRACE_DAYS = 30;
const day = 86_400_000;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const daysLeft = (d: Date | null) => (d ? Math.ceil((d.getTime() - Date.now()) / day) : null);
/** An ended registration is still worth a month on the list — then it is history. */
const stillWorthShowing = (r: { status: string; expiresAt: Date | null; updatedAt: Date }) => {
  if (r.status === 'EXPIRED') return !r.expiresAt || Date.now() - r.expiresAt.getTime() < GRACE_DAYS * day;
  if (r.status === 'REJECTED') return Date.now() - r.updatedAt.getTime() < GRACE_DAYS * day;
  return true;
};

export async function partnerRegistrations(session: PortalSession, filters: RegistrationFilters = {}): Promise<PortalRegistrationPage> {
  const scope = registrationScope(session);
  const { showRegNumber, showDealValue, showStage, showQuotedValue } = await resolvePartnerSwitches(session.accountId);

  // One scoped query, everything after in memory. A partner has hundreds of these at
  // most, and the grace rule cannot be expressed as a where clause anyway.
  const rows = await prisma.dealRegistration.findMany({
    where: { side: 'PARTNER', ...scope, status: { in: [...VISIBLE] }, deal: { deletedAt: null } },
    select: {
      id: true, status: true, submittedAt: true, approvedAt: true, expiresAt: true, regNumber: true, updatedAt: true,
      deal: {
        select: {
          id: true, reference: true, amount: true,
          stage: { select: { name: true, isWon: true, isLost: true } },
          account: { select: { name: true } },
          quotes: { where: { status: { in: ['SENT', 'ACCEPTED'] } }, orderBy: [{ sentAt: 'desc' }, { createdAt: 'desc' }], take: 1, select: { total: true } },
          registrations: {
            where: { side: 'VENDOR', status: { in: [...VISIBLE] } },
            select: { status: true, submittedAt: true, approvedAt: true, expiresAt: true, regNumber: true, updatedAt: true, vendor: { select: { name: true } } },
            orderBy: { expiresAt: 'asc' },
          },
        },
      },
    },
    take: 2000,
  });

  const side = (r: { status: string; submittedAt: Date | null; approvedAt: Date | null; expiresAt: Date | null; regNumber: string | null }): RegistrationSide => ({
    status: r.status as RegistrationSide['status'],
    submittedAt: iso(r.submittedAt),
    approvedAt: iso(r.approvedAt),
    expiresAt: iso(r.expiresAt),
    daysLeft: daysLeft(r.expiresAt),
    ...(showRegNumber ? { regNumber: r.regNumber } : {}),
  });
  const stageOf = (d: { stage: { name: string; isWon: boolean; isLost: boolean } }) => (d.stage.isWon ? 'Won' : d.stage.isLost ? 'Lost' : d.stage.name);

  const live = rows.filter(stillWorthShowing).map((r) => ({
    raw: r,
    stage: stageOf(r.deal),
    vendors: r.deal.registrations.filter(stillWorthShowing),
    shaped: {
      id: r.id,
      deal: {
        reference: r.deal.reference,
        endCustomer: r.deal.account.name,
        ...(showStage ? { stage: stageOf(r.deal) } : {}),
        ...(showDealValue ? { value: Number(r.deal.amount) } : {}),
        ...(showQuotedValue && r.deal.quotes[0] ? { quoted: Number(r.deal.quotes[0].total) } : {}),
      },
      ours: side(r),
      vendors: r.deal.registrations.filter(stillWorthShowing).map((v) => ({ ...side(v), vendor: v.vendor?.name ?? 'Vendor' })),
    } as PortalRegistration,
  }));

  // Facets come from the scoped rows before any filter, so a filter never hides the
  // way back — and a stage a partner may not see is not offered as something to pick.
  const facets = {
    vendors: [...new Set(live.flatMap((x) => x.vendors.map((v) => v.vendor?.name ?? 'Vendor')))].sort(),
    stages: showStage ? [...new Set(live.map((x) => x.stage))].sort() : [],
    statuses: [...new Set(live.map((x) => x.raw.status))].sort(),
  };

  const q = filters.q?.trim().toLowerCase();
  const window = filters.expiring === 'lapsed' ? null : Number(filters.expiring);
  const picked = live.filter((x) => {
    if (q && !`${x.raw.deal.reference} ${x.raw.deal.account.name}`.toLowerCase().includes(q)) return false;
    if (filters.status && x.raw.status !== filters.status) return false;
    if (filters.vendor && !x.vendors.some((v) => (v.vendor?.name ?? 'Vendor') === filters.vendor)) return false;
    if (filters.stage && showStage && x.stage !== filters.stage) return false;
    if (filters.expiring === 'lapsed' && !(x.raw.expiresAt && x.raw.expiresAt.getTime() < Date.now())) return false;
    if (window && window > 0) {
      const t = x.raw.expiresAt?.getTime();
      if (!t || t < Date.now() || t > Date.now() + window * day) return false;
    }
    return true;
  });

  const far = Number.MAX_SAFE_INTEGER;
  if (filters.sort === 'value' && showDealValue) picked.sort((a, b) => Number(b.raw.deal.amount) - Number(a.raw.deal.amount));
  else if (filters.sort === 'newest') picked.sort((a, b) => (b.raw.submittedAt?.getTime() ?? 0) - (a.raw.submittedAt?.getTime() ?? 0));
  else picked.sort((a, b) => (a.shaped.ours.daysLeft ?? far) - (b.shaped.ours.daysLeft ?? far)); // soonest expiry first; no date last

  const pageSize = Math.min(100, Math.max(1, filters.pageSize ?? 25));
  const page = Math.max(1, filters.page ?? 1);
  return {
    data: picked.slice((page - 1) * pageSize, page * pageSize).map((x) => x.shaped),
    total: picked.length,
    page,
    pageSize,
    facets,
    scope: session.role === 'admin' ? 'all' : 'mine',
  };
}
