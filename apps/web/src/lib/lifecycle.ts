import { date, daysBetween, money } from './format';

/**
 * Lifecycle visualisation.
 *
 * Every record in Zeus travels a fixed track — a lead becomes a deal, a quote
 * becomes an invoice, an invoice becomes cash. These helpers turn a status
 * string (or, for deals and accounts, the documents hanging off the record)
 * into three answers the screen should give at a glance:
 *
 *   where am I on the track · what is behind me · what do I do next
 *
 * The track data lives here so the same definition drives the detail rail and
 * the mini bars in list views, and nothing can drift between the two.
 */

export interface RailStep {
  key: string;
  label: string;
  /** Small line under the label — a date, a count, a document number. */
  sub?: string;
  /** Overrides the "current step" colour, so a deal stage keeps its own colour. */
  color?: string;
}

export interface Track {
  steps: RailStep[];
  /** Index of the step the record is sitting on. */
  current: number;
  /** Set when the record left the track for good — "Rejected", "Lost". */
  stopped?: string;
  /** Small badge on the right — an on-track warning like "Overdue". */
  note?: string;
}

export interface Hint {
  text: string;
  tone?: 'neutral' | 'accent' | 'watch' | 'secure';
  cta?: { label: string; to?: string; onClick?: () => void; loading?: boolean };
}

const LABELS: Record<string, string> = {
  NEW: 'New', WORKING: 'Working', NURTURING: 'Nurturing', QUALIFIED: 'Qualified',
  CONVERTED: 'Converted', DISQUALIFIED: 'Disqualified',
  DRAFT: 'Draft', SENT: 'Sent', ACCEPTED: 'Accepted', REJECTED: 'Rejected', EXPIRED: 'Expired',
  PARTIAL: 'Part paid', PAID: 'Paid', OVERDUE: 'Overdue', CANCELLED: 'Cancelled',
  ISSUED: 'Issued', ACKNOWLEDGED: 'Acknowledged', PARTIALLY_RECEIVED: 'Part received',
  RECEIVED: 'Received', CLOSED: 'Closed',
};

export const statusLabel = (status: string): string => LABELS[status] ?? status.replace(/_/g, ' ');

const num = (v: unknown): number => Number(v ?? 0);

/**
 * Builds a track from a list of on-path statuses.
 * `offPath` maps a terminal status to the step it died on, so a rejected quote
 * still shows that it got as far as being sent.
 */
function build(keys: string[], status: string, offPath: Record<string, number> = {}): Track {
  const steps = keys.map((key) => ({ key, label: statusLabel(key) }));
  const index = keys.indexOf(status);
  if (index >= 0) return { steps, current: index };
  return { steps, current: offPath[status] ?? 0, stopped: statusLabel(status) };
}

// ── per-module tracks ─────────────────────────────────────────────────────────

// Nurturing is a holding pattern beside "working", not a rung on the ladder —
// showing it inline would tick it off for every lead that never went near it.
export const LEAD_STEPS = ['NEW', 'WORKING', 'QUALIFIED', 'CONVERTED'];
export const QUOTE_STEPS = ['DRAFT', 'SENT', 'ACCEPTED'];
export const INVOICE_STEPS = ['DRAFT', 'SENT', 'PARTIAL', 'PAID'];
export const PO_STEPS = ['DRAFT', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

export function leadTrack(status: string): Track {
  if (status === 'NURTURING') return { ...build(LEAD_STEPS, 'WORKING'), note: 'Nurturing' };
  return build(LEAD_STEPS, status, { DISQUALIFIED: 1 });
}

export const quoteTrack = (status: string): Track => build(QUOTE_STEPS, status, { REJECTED: 1, EXPIRED: 1 });

export function invoiceTrack(status: string): Track {
  // Overdue is not a separate place on the track — it is "sent" with the clock run out.
  if (status === 'OVERDUE') return { ...build(INVOICE_STEPS, 'SENT'), note: 'Overdue' };
  return build(INVOICE_STEPS, status, { CANCELLED: 0 });
}

export const poTrack = (status: string): Track => build(PO_STEPS, status, { CANCELLED: 0 });

// ── document-derived tracks ───────────────────────────────────────────────────

interface JourneyDocs {
  quotes: Array<{ status: string }>;
  invoices: Array<{ status: string }>;
}

/**
 * A deal's commercial journey, read off the documents rather than a status
 * column: the deal is only "invoiced" once an invoice actually left draft.
 */
export function dealJourney(deal: { status: string; lostReason?: string | null } & JourneyDocs): Track {
  const quoted = deal.quotes.length > 0;
  const accepted = deal.quotes.some((q) => q.status === 'ACCEPTED');
  const live = deal.invoices.filter((i) => i.status !== 'DRAFT' && i.status !== 'CANCELLED');
  const settled = live.length > 0 && live.every((i) => i.status === 'PAID');

  const steps: RailStep[] = [
    { key: 'deal', label: 'Deal open' },
    { key: 'quote', label: 'Quoted', sub: quoted ? `${deal.quotes.length} quote${deal.quotes.length === 1 ? '' : 's'}` : undefined },
    { key: 'accepted', label: 'Accepted' },
    { key: 'invoice', label: 'Invoiced', sub: live.length ? `${live.length} raised` : undefined },
    { key: 'paid', label: 'Paid' },
  ];

  const current = settled ? 4 : live.length ? 3 : accepted ? 2 : quoted ? 1 : 0;
  if (deal.status === 'LOST') return { steps, current, stopped: `Lost${deal.lostReason ? ` — ${deal.lostReason}` : ''}` };
  return { steps, current, note: deal.status === 'WON' ? 'Won' : undefined };
}

/** How far a company has travelled with us, from first prospect to paying customer. */
export function accountJourney(account: { type: string; deals: Array<{ status: string }> } & JourneyDocs): Track {
  const steps: RailStep[] = [
    { key: 'prospect', label: 'Prospect' },
    { key: 'pipeline', label: 'In pipeline', sub: account.deals.length ? `${account.deals.length} deal${account.deals.length === 1 ? '' : 's'}` : undefined },
    { key: 'quoted', label: 'Quoted' },
    { key: 'won', label: 'Won' },
    { key: 'paid', label: 'Paying' },
  ];
  const paid = account.invoices.some((i) => i.status === 'PAID' || i.status === 'PARTIAL');
  const won = account.deals.some((d) => d.status === 'WON');
  const current = paid ? 4 : won ? 3 : account.quotes.length ? 2 : account.deals.length ? 1 : 0;
  return { steps, current };
}

// ── next step ─────────────────────────────────────────────────────────────────

export function leadHint(lead: { status: string; lastActivityAt: string | null; createdAt: string }): Hint {
  const quiet = daysBetween(lead.lastActivityAt ?? lead.createdAt) ?? 0;
  switch (lead.status) {
    case 'NEW':
      return { text: 'Make first contact and log the call or email against the lead.', tone: 'accent' };
    case 'WORKING':
      return {
        text: quiet >= 7
          ? `No activity for ${quiet} days. Follow up, or park it as nurturing so it stops looking live.`
          : 'Qualify budget, authority and timing — then mark it Qualified.',
        tone: quiet >= 7 ? 'watch' : 'neutral',
      };
    case 'NURTURING':
      return { text: 'Parked. Book a follow-up task so it comes back to you instead of going quiet.', tone: 'neutral' };
    case 'QUALIFIED':
      return { text: 'Ready to convert — this creates the account, the contact and the deal in one step.', tone: 'accent' };
    case 'CONVERTED':
      return { text: 'Converted. The work now happens on the deal.', tone: 'secure' };
    default:
      return { text: 'Disqualified. Nothing further unless the customer comes back.', tone: 'neutral' };
  }
}

export function quoteHint(quote: { status: string; validUntil: string | null }): Hint {
  const daysLeft = quote.validUntil ? -(daysBetween(quote.validUntil) ?? 0) : null;
  switch (quote.status) {
    case 'DRAFT':
      return { text: 'Add the lines, check the margin, then email it to the customer.', tone: 'accent' };
    case 'SENT':
      return {
        text: daysLeft !== null && daysLeft <= 5
          ? `Validity runs out ${daysLeft < 0 ? `${-daysLeft} days ago` : `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`} (${date(quote.validUntil)}) — chase acceptance now.`
          : `With the customer${quote.validUntil ? ` until ${date(quote.validUntil)}` : ''}. Chase acceptance and log the reply.`,
        tone: daysLeft !== null && daysLeft <= 5 ? 'watch' : 'neutral',
      };
    case 'ACCEPTED':
      return { text: 'Accepted and locked. Raise the tax invoice from it — the figures carry over untouched.', tone: 'secure' };
    case 'EXPIRED':
      return { text: 'Expired. Create a new version with fresh pricing if the customer is still live.', tone: 'watch' };
    default:
      return { text: 'Rejected. A new version keeps the history and lets you re-price.', tone: 'neutral' };
  }
}

export function invoiceHint(invoice: {
  status: string; dueDate: string | null; total: string | number; amountPaid: string | number;
}): Hint {
  const outstanding = num(invoice.total) - num(invoice.amountPaid);
  const overdueBy = invoice.dueDate ? daysBetween(invoice.dueDate) ?? 0 : 0;
  switch (invoice.status) {
    case 'DRAFT':
      return { text: 'Check the TRNs and the totals, then issue it. Once sent, the figures lock.', tone: 'accent' };
    case 'SENT':
      return {
        text: invoice.dueDate && overdueBy > -5
          ? `Due ${date(invoice.dueDate)} — inside the reminder window. Chase the payment now.`
          : `${money(outstanding)} due${invoice.dueDate ? ` on ${date(invoice.dueDate)}` : ''}. Record the receipt when it lands.`,
        tone: invoice.dueDate && overdueBy > -5 ? 'watch' : 'neutral',
      };
    case 'PARTIAL':
      return { text: `${money(outstanding)} still outstanding of ${money(invoice.total)}. Chase the balance.`, tone: 'watch' };
    case 'OVERDUE':
      return { text: `${money(outstanding)} overdue by ${overdueBy} day${overdueBy === 1 ? '' : 's'}. Escalate to the customer's accounts team.`, tone: 'accent' };
    case 'PAID':
      return { text: 'Settled in full. Nothing outstanding.', tone: 'secure' };
    default:
      return { text: 'Cancelled. Raise a fresh invoice if the sale is still on.', tone: 'neutral' };
  }
}

export function poHint(po: {
  status: string; direction: string; paymentDueDate: string | null;
  total: string | number; amountPaid: string | number;
}): Hint {
  const customer = po.direction === 'CUSTOMER';
  const outstanding = num(po.total) - num(po.amountPaid);
  const dueIn = po.paymentDueDate ? -(daysBetween(po.paymentDueDate) ?? 0) : null;

  if (customer) {
    switch (po.status) {
      case 'DRAFT':
        return { text: "Attach their signed PO, then mark it issued so it counts as evidence against the deal.", tone: 'accent' };
      case 'CLOSED':
        return { text: 'Closed. Everything on this order has been delivered and invoiced.', tone: 'secure' };
      default:
        return { text: 'Order in hand — raise the tax invoice against it and quote their PO number on the invoice.', tone: 'accent' };
    }
  }

  switch (po.status) {
    case 'DRAFT':
      return { text: 'Check the buy price against the vendor quote, then issue it to the supplier.', tone: 'accent' };
    case 'ISSUED':
      return { text: 'Sent to the supplier. Chase the order acknowledgement.', tone: 'neutral' };
    case 'ACKNOWLEDGED':
      return { text: 'Acknowledged. Receive the lines as the licences or hardware arrive.', tone: 'neutral' };
    case 'PARTIALLY_RECEIVED':
      return { text: 'Part received. Update the received quantities as the rest lands.', tone: 'watch' };
    case 'RECEIVED':
      return {
        text: dueIn !== null && dueIn <= 5
          ? `Fully received. ${money(outstanding)} payable ${dueIn < 0 ? `${-dueIn} days ago` : `in ${dueIn} day${dueIn === 1 ? '' : 's'}`} — pay it and close the order.`
          : `Fully received. ${money(outstanding)} payable${po.paymentDueDate ? ` by ${date(po.paymentDueDate)}` : ''}.`,
        tone: dueIn !== null && dueIn <= 5 ? 'accent' : 'neutral',
      };
    case 'CLOSED':
      return { text: 'Received and paid. This order is done.', tone: 'secure' };
    default:
      return { text: 'Cancelled. Nothing owed on this order.', tone: 'neutral' };
  }
}

/** Next step for a deal, driven by the same journey the rail shows. */
export function dealHint(deal: {
  status: string;
  invoices: Array<{ status: string; total: string | number; amountPaid?: string | number }>;
} & JourneyDocs): Hint {
  if (deal.status === 'LOST') return { text: 'Lost. Keep the account warm for the next renewal cycle.', tone: 'neutral' };

  const accepted = deal.quotes.some((q) => q.status === 'ACCEPTED');
  const live = deal.invoices.filter((i) => i.status !== 'DRAFT' && i.status !== 'CANCELLED');
  const outstanding = live.reduce((sum, i) => sum + num(i.total) - num(i.amountPaid), 0);

  if (!deal.quotes.length) return { text: 'Nothing quoted yet — build the quotation so the customer has a number.', tone: 'accent' };
  if (!accepted) return { text: 'Quote is with the customer. Chase acceptance, then raise the invoice from it.', tone: 'neutral' };
  if (!live.length) return { text: 'Quote accepted — raise the tax invoice from it so the money starts moving.', tone: 'accent' };
  if (outstanding > 0) return { text: `${money(outstanding)} still to collect across ${live.length} invoice${live.length === 1 ? '' : 's'}.`, tone: 'watch' };
  if (deal.status === 'OPEN') return { text: 'Invoiced and paid in full — mark the deal won so the forecast is honest.', tone: 'secure' };
  return { text: 'Won, invoiced and collected. Nothing outstanding.', tone: 'secure' };
}

export function accountHint(account: { type: string; deals: Array<{ status: string }> } & JourneyDocs): Hint {
  const open = account.deals.filter((d) => d.status === 'OPEN');
  if (!account.deals.length) return { text: 'No deal open with this company. Create one to put it in the pipeline.', tone: 'accent' };
  if (!account.quotes.length) return { text: `${open.length} open deal${open.length === 1 ? '' : 's'} and nothing quoted yet — get a number in front of them.`, tone: 'accent' };
  if (!account.deals.some((d) => d.status === 'WON')) return { text: 'Quoted and waiting. Chase acceptance on the open quotes.', tone: 'neutral' };
  if (!account.invoices.length) return { text: 'Business won but nothing invoiced. Raise the invoice from the accepted quote.', tone: 'accent' };
  return { text: 'Established customer. Watch the renewal dates and keep the relationship warm.', tone: 'secure' };
}
