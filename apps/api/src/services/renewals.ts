import { prisma, num } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { nextReference } from '../lib/counters.js';
import { applyVat, formatAed, round2 } from '../lib/money.js';
import { notify } from './notify.js';

/**
 * Renewals.
 *
 * A reseller's income is mostly re-sold time. A deal records that something was sold
 * once; a subscription records that it is still running and when it has to be sold
 * again. Left to a spreadsheet, an expiry is invisible until the customer has already
 * gone somewhere else.
 *
 * The engine does three things on a schedule:
 *   1. flags what is inside the renewal window
 *   2. opens the renewal opportunity once, ahead of expiry, priced off the last term
 *   3. reminds the owner at each step, and marks what actually lapsed
 *
 * Everything it decides is a Settings value, because how far ahead a renewal is worth
 * working is a commercial judgement, not a constant.
 */

/** Same day-of-month, n months on. Clamps when the target month is shorter. */
export function addMonths(from: Date, months: number): Date {
  const date = new Date(from.getTime());
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  // 31 Jan + 1 month is 28 Feb, not 3 March.
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date;
}

/**
 * Last day of cover for a term.
 *
 * A vendor quotes "expires 31 Dec", not "expires 1 Jan", and the next term starts the
 * following day. Taking the anniversary itself as the end date would both overstate
 * cover by a day and push every subsequent renewal one day later than the last, so a
 * three-year chain would drift off the anniversary the customer signed up on.
 */
export const termEnd = (start: Date, months: number): Date =>
  new Date(addMonths(start, months).getTime() - 86_400_000);

/** Whole days from now until the date — negative once it is in the past. */
export const daysUntil = (date: Date): number => Math.ceil((date.getTime() - Date.now()) / 86_400_000);

export interface SubscriptionInput {
  accountId: string;
  description: string;
  productId?: string | null;
  vendorId?: string | null;
  quantity: number;
  unit?: string;
  unitPrice: number;
  unitCost?: number;
  startDate: Date;
  termMonths: number;
  endDate?: Date | null;
  autoRenew?: boolean;
  vendorRef?: string | null;
  notes?: string | null;
  ownerId?: string | null;
  sourceInvoiceId?: string | null;
  sourceDealId?: string | null;
  renewedFromId?: string | null;
}

export async function createSubscription(input: SubscriptionInput) {
  const quantity = input.quantity || 1;
  const unitPrice = input.unitPrice || 0;
  const unitCost = input.unitCost ?? 0;

  return prisma.subscription.create({
    data: {
      reference: await nextReference('subscription'),
      accountId: input.accountId,
      productId: input.productId ?? null,
      vendorId: input.vendorId ?? null,
      description: input.description,
      quantity,
      unit: input.unit ?? 'licence',
      unitPrice,
      unitCost,
      termValue: round2(quantity * unitPrice),
      termCost: round2(quantity * unitCost),
      startDate: input.startDate,
      endDate: input.endDate ?? termEnd(input.startDate, input.termMonths),
      termMonths: input.termMonths,
      autoRenew: input.autoRenew ?? true,
      vendorRef: input.vendorRef ?? null,
      notes: input.notes ?? null,
      ownerId: input.ownerId ?? null,
      sourceInvoiceId: input.sourceInvoiceId ?? null,
      sourceDealId: input.sourceDealId ?? null,
      renewedFromId: input.renewedFromId ?? null,
    },
  });
}

/**
 * Turn an issued invoice's termed lines into entitlements.
 *
 * Only lines carrying a term become subscriptions — a one-off hardware line is not
 * something that expires. Runs when the invoice is issued, because that is the point
 * the customer actually owns it, and is safe to call twice: an invoice that already
 * produced entitlements produces none.
 */
export async function createFromInvoice(invoiceId: string, actorId?: string | null): Promise<number> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      lines: { include: { product: { select: { id: true, vendorId: true } } } },
      deal: { select: { id: true, ownerId: true } },
      subscriptions: { select: { id: true } },
    },
  });
  if (!invoice) return 0;
  if (invoice.type !== 'TAX_INVOICE') return 0;
  if (invoice.subscriptions.length > 0) return 0;

  const termed = invoice.lines.filter((line) => (line.termMonths ?? 0) > 0);
  if (!termed.length) return 0;

  // The supply date is when cover starts if it was recorded; otherwise the issue date.
  const start = invoice.supplyDate ?? invoice.issueDate;

  let created = 0;
  for (const line of termed) {
    await createSubscription({
      accountId: invoice.accountId,
      description: line.description,
      productId: line.productId,
      vendorId: line.product?.vendorId ?? null,
      quantity: num(line.quantity),
      unit: line.unit,
      unitPrice: num(line.unitPrice),
      unitCost: num(line.unitCost),
      startDate: start,
      termMonths: line.termMonths!,
      ownerId: invoice.deal?.ownerId ?? actorId ?? null,
      sourceInvoiceId: invoice.id,
      sourceDealId: invoice.dealId,
    });
    created += 1;
  }
  return created;
}

/**
 * Open the renewal opportunity for a subscription, priced off the term ending.
 * Returns the existing deal if one was already opened — the sweep must never create
 * a second one for the same term.
 */
export async function openRenewalDeal(subscriptionId: string, actorId?: string | null) {
  const sub = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { account: { select: { id: true, name: true } }, renewalDeal: { select: { id: true, reference: true } } },
  });
  if (!sub) throw new Error('Subscription not found.');
  if (sub.renewalDeal) return sub.renewalDeal;
  if (sub.status === 'CANCELLED') throw new Error(`${sub.reference} was cancelled — nothing to renew.`);

  const [upliftPct, source, defaultVat] = await Promise.all([
    getSetting<number>('renewals.upliftPct', 0),
    getSetting<string>('renewals.dealSource', 'Renewal'),
    getSetting<number>('finance.vatRate', 5),
  ]);

  const pipeline = await prisma.pipeline.findFirst({
    where: { isDefault: true, isActive: true },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
  if (!pipeline?.stages.length) throw new Error('No default pipeline with stages is configured.');
  const stage = pipeline.stages[0];

  // Last term's price, plus the standard uplift. The rep can edit it; the point is a
  // renewal that starts from a real number rather than an empty form.
  const amount = round2(num(sub.termValue) * (1 + Number(upliftPct) / 100));
  const { vatAmount, total } = applyVat(amount, Number(defaultVat));

  const deal = await prisma.deal.create({
    data: {
      reference: await nextReference('deal'),
      name: `Renewal — ${sub.description}`,
      accountId: sub.accountId,
      pipelineId: pipeline.id,
      stageId: stage.id,
      status: 'OPEN',
      type: 'SERVICE',
      amount,
      cost: round2(num(sub.termCost)),
      vatRate: Number(defaultVat),
      vatAmount,
      totalAmount: total,
      probability: stage.probability,
      // The renewal has to be closed by the day cover ends, not after it.
      closeDate: sub.endDate,
      source,
      description: `Renewal of ${sub.reference} (${sub.quantity} × ${sub.unit}), cover ends ${sub.endDate.toLocaleDateString('en-GB')}.`,
      ownerId: sub.ownerId ?? actorId ?? null,
      lastActivityAt: new Date(),
    },
    select: { id: true, reference: true },
  });

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { renewalDealId: deal.id, renewalOpenedAt: new Date(), status: 'EXPIRING' },
  });

  return deal;
}

/**
 * The nightly pass. Opens what is due, reminds on the configured steps, and marks
 * what has actually run out.
 */
export async function sweepRenewals(): Promise<{ opened: number; reminded: number; lapsed: number }> {
  const [leadDays, reminderSteps] = await Promise.all([
    getSetting<number>('renewals.leadDays', 90),
    getSetting<number[]>('renewals.reminderDays', [90, 30, 7]),
  ]);

  const horizon = new Date(Date.now() + Number(leadDays) * 86_400_000);
  const live = await prisma.subscription.findMany({
    where: { deletedAt: null, status: { in: ['ACTIVE', 'EXPIRING'] }, endDate: { lte: horizon } },
    include: { account: { select: { name: true } }, renewalDeal: { select: { id: true } } },
    take: 500,
  });

  let opened = 0;
  let reminded = 0;

  for (const sub of live) {
    const left = daysUntil(sub.endDate);
    if (left < 0) continue; // handled by the lapse pass below

    if (sub.status === 'ACTIVE') {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRING' } });
    }

    // Auto-renewing lines get an opportunity opened for them; the rest are worked by
    // hand, because someone decided this one is not coming back.
    if (sub.autoRenew && !sub.renewalDeal) {
      try {
        await openRenewalDeal(sub.id);
        opened += 1;
      } catch (err) {
        console.error(`[renewals] could not open a renewal for ${sub.reference}:`, (err as Error).message);
      }
    }

    // Fire the largest step that has been passed and not yet sent, so a subscription
    // created inside the window still gets one warning rather than none.
    const steps = (Array.isArray(reminderSteps) ? reminderSteps : [])
      .map(Number)
      .filter((step) => Number.isFinite(step) && step >= 0);
    const dueStep = steps
      .sort((a, b) => b - a)
      .find((step) => left <= step && (sub.lastRemindedDays === null || step < sub.lastRemindedDays));

    if (dueStep !== undefined) {
      await notify({
        event: 'renewal_due',
        title: `${sub.account.name} — ${sub.description} renews in ${left} day${left === 1 ? '' : 's'}`,
        body: `${sub.reference} · ${formatAed(num(sub.termValue))} per term · cover ends ${sub.endDate.toLocaleDateString('en-GB')}`,
        link: sub.renewalDeal ? `/deals/${sub.renewalDeal.id}` : `/renewals?search=${encodeURIComponent(sub.reference)}`,
        severity: left <= 30 ? 'critical' : 'warn',
        ownerId: sub.ownerId,
        facts: [
          { title: 'Customer', value: sub.account.name },
          { title: 'Cover ends', value: sub.endDate.toLocaleDateString('en-GB') },
          { title: 'Term value', value: formatAed(num(sub.termValue)) },
          { title: 'Auto-renew', value: sub.autoRenew ? 'Yes' : 'No' },
        ],
      });
      await prisma.subscription.update({ where: { id: sub.id }, data: { lastRemindedDays: dueStep } });
      reminded += 1;
    }
  }

  // Anything past its end date that nobody renewed. Told first, then marked, so the
  // status change never happens silently.
  const expired = await prisma.subscription.findMany({
    where: { deletedAt: null, status: { in: ['ACTIVE', 'EXPIRING'] }, endDate: { lt: new Date() } },
    include: { account: { select: { name: true } } },
    take: 200,
  });

  for (const sub of expired) {
    await notify({
      event: 'renewal_lapsed',
      title: `Lapsed — ${sub.account.name} ${sub.description}`,
      body: `${sub.reference} · cover ended ${sub.endDate.toLocaleDateString('en-GB')} · ${formatAed(num(sub.termValue))} per term`,
      link: `/renewals?status=LAPSED`,
      severity: 'critical',
      ownerId: sub.ownerId,
      facts: [
        { title: 'Customer', value: sub.account.name },
        { title: 'Ended', value: sub.endDate.toLocaleDateString('en-GB') },
        { title: 'Term value', value: formatAed(num(sub.termValue)) },
      ],
    });
  }

  const lapsed = await prisma.subscription.updateMany({
    where: { deletedAt: null, status: { in: ['ACTIVE', 'EXPIRING'] }, endDate: { lt: new Date() } },
    data: { status: 'LAPSED' },
  });

  return { opened, reminded, lapsed: lapsed.count };
}

/**
 * A renewal deal closed won: the old term is done and the next one starts the day
 * after cover ended, so a chain of renewals never leaves a gap or double-counts.
 */
export async function markRenewed(dealId: string): Promise<void> {
  const subs = await prisma.subscription.findMany({
    where: { renewalDealId: dealId, status: { notIn: ['RENEWED', 'CANCELLED'] }, deletedAt: null },
  });

  for (const sub of subs) {
    const nextStart = new Date(sub.endDate.getTime() + 86_400_000);
    const next = await createSubscription({
      accountId: sub.accountId,
      description: sub.description,
      productId: sub.productId,
      vendorId: sub.vendorId,
      quantity: num(sub.quantity),
      unit: sub.unit,
      unitPrice: num(sub.unitPrice),
      unitCost: num(sub.unitCost),
      startDate: nextStart,
      termMonths: sub.termMonths,
      autoRenew: sub.autoRenew,
      vendorRef: sub.vendorRef,
      ownerId: sub.ownerId,
      sourceDealId: dealId,
      renewedFromId: sub.id,
    });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'RENEWED' } });
    console.log(`[renewals] ${sub.reference} renewed as ${next.reference}`);
  }
}
