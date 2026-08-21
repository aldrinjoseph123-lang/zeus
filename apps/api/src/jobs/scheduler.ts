import cron, { type ScheduledTask } from 'node-cron';
import { prisma, num } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { notify, sendPendingDigests } from '../services/notify.js';
import { runDueScheduledReports } from '../services/scheduledReports.js';
import { runScheduledBackup, checkMissedBackups, weeklyAutoVerify } from '../services/backup.js';
import { dailyDataHealthSweep } from '../services/dataHealth.js';
import { daysUntil, mailPartnerAboutRegistration } from '../services/registrations.js';
import { sweepRenewals } from '../services/renewals.js';
import { ratesAreStale, refreshRates } from '../services/fx.js';
import { takePipelineSnapshot, takeWeeklyDealSnapshot } from '../services/snapshots.js';
import { logSystem, pruneSystemLogs } from '../services/systemLog.js';
import { alertOnTransitions } from '../services/healthMonitor.js';
import { componentStatuses, recordComponentChecks } from '../services/systemStatus.js';
import { recordResourceSample, pruneResourceSamples } from '../services/resources.js';
import { pruneLoginAudit, purgeExpiredLeads } from '../services/retention.js';
import { formatAed } from '../lib/money.js';

/**
 * Background alerting. Single-process cron — right shape for a team of this size;
 * a queue would be more moving parts than the workload justifies.
 * All schedules run on Gulf Standard Time so "9am" means 9am in Dubai.
 */

const TZ = 'Asia/Dubai';
const tasks: ScheduledTask[] = [];

/** Tasks coming due or already late. Runs often, notifies once per activity. */
async function taskReminders(): Promise<void> {
  const hours = Number(await getSetting<number>('pipeline.taskReminderHours', 24));
  const horizon = new Date(Date.now() + hours * 3_600_000);

  const due = await prisma.activity.findMany({
    where: {
      status: 'Open',
      type: { in: ['TASK', 'CALL', 'MEETING'] },
      dueAt: { not: null, lte: horizon },
      remindedAt: null,
      ownerId: { not: null },
    },
    include: { deal: { select: { id: true, reference: true, name: true } }, account: { select: { id: true, name: true } } },
    take: 200,
  });

  for (const activity of due) {
    const overdue = activity.dueAt! < new Date();
    await notify({
      event: overdue ? 'task_overdue' : 'task_due',
      title: overdue ? `Overdue: ${activity.subject}` : `Due soon: ${activity.subject}`,
      body: [activity.account?.name, activity.deal ? `${activity.deal.reference} ${activity.deal.name}` : null]
        .filter(Boolean).join(' · ') || undefined,
      link: activity.dealId ? `/deals/${activity.dealId}` : activity.accountId ? `/accounts/${activity.accountId}` : '/activities',
      severity: overdue ? 'warn' : 'info',
      ownerId: activity.ownerId,
      facts: [
        { title: 'Due', value: activity.dueAt!.toLocaleString('en-GB', { timeZone: TZ }) },
        { title: 'Priority', value: activity.priority },
      ],
    });
    await prisma.activity.update({ where: { id: activity.id }, data: { remindedAt: new Date() } });
  }
}

/** Accounts nobody has touched inside the threshold. */
async function staleAccounts(): Promise<void> {
  const days = Number(await getSetting<number>('pipeline.staleAccountDays', 7));
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const accounts = await prisma.account.findMany({
    where: {
      deletedAt: null,
      type: { in: ['CUSTOMER', 'PROSPECT', 'PARTNER'] },
      OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: cutoff } }],
    },
    include: { deals: { where: { deletedAt: null, status: 'OPEN' }, select: { amount: true } } },
    orderBy: { lastActivityAt: 'asc' },
    take: 100,
  });
  if (accounts.length === 0) return;

  // One digest per owner beats a hundred separate pings.
  const byOwner = new Map<string | null, typeof accounts>();
  for (const account of accounts) {
    const list = byOwner.get(account.ownerId) ?? [];
    list.push(account);
    byOwner.set(account.ownerId, list);
  }

  for (const [ownerId, list] of byOwner) {
    const atRisk = list.reduce((sum, a) => sum + a.deals.reduce((s, d) => s + num(d.amount), 0), 0);
    await notify({
      event: 'account_stale',
      title: `${list.length} account${list.length === 1 ? '' : 's'} with no activity for ${days}+ days`,
      body: list.slice(0, 5).map((a) => a.name).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : ''),
      link: `/accounts?stale=true&staleDays=${days}`,
      severity: 'warn',
      ownerId,
      facts: [
        { title: 'Accounts', value: String(list.length) },
        { title: 'Open pipeline at risk', value: formatAed(atRisk) },
      ],
    });
  }
}

/** Deals parked in the same stage for too long. */
async function stuckDeals(): Promise<void> {
  const days = Number(await getSetting<number>('pipeline.staleDealDays', 14));
  const cutoff = new Date(Date.now() - days * 86_400_000);

  const deals = await prisma.deal.findMany({
    where: { deletedAt: null, status: 'OPEN', stageChangedAt: { lt: cutoff } },
    include: { stage: { select: { name: true } }, account: { select: { name: true } } },
    orderBy: { amount: 'desc' },
    take: 100,
  });
  if (deals.length === 0) return;

  const byOwner = new Map<string | null, typeof deals>();
  for (const deal of deals) {
    const list = byOwner.get(deal.ownerId) ?? [];
    list.push(deal);
    byOwner.set(deal.ownerId, list);
  }

  for (const [ownerId, list] of byOwner) {
    const total = list.reduce((s, d) => s + num(d.amount), 0);
    await notify({
      event: 'deal_stale',
      title: `${list.length} deal${list.length === 1 ? '' : 's'} stuck for ${days}+ days`,
      body: list.slice(0, 5).map((d) => `${d.reference} ${d.account.name} (${d.stage.name})`).join(' · '),
      link: '/deals?sortBy=stageChangedAt&sortDir=asc',
      severity: 'warn',
      ownerId,
      facts: [
        { title: 'Deals', value: String(list.length) },
        { title: 'Value', value: formatAed(total) },
      ],
    });
  }
}

/**
 * Registrations about to lapse, both sides of the channel — losing a vendor
 * registration costs margin, and letting a partner's protection lapse quietly costs
 * the relationship. The rep is told either way; on the partner side the partner is
 * mailed too, because they are the one who has to act.
 */
export async function expiringRegistrations(): Promise<void> {
  const [days, partnerMails, partnerDays] = await Promise.all([
    getSetting<number>('pipeline.registrationExpiryWarnDays', 30),
    getSetting<boolean>('pipeline.notifyPartnerOnExpiry', true),
    getSetting<number>('pipeline.partnerReminderDays', 14),
  ]);

  const include = {
    vendor: { select: { name: true } },
    partner: { select: { name: true } },
    partnerContact: { select: { firstName: true, lastName: true, email: true } },
    deal: { select: { id: true, reference: true, name: true, ownerId: true, amount: true, account: { select: { name: true } } } },
  } as const;

  const registrations = await prisma.dealRegistration.findMany({
    where: {
      status: { in: ['SUBMITTED', 'APPROVED'] },
      expiresAt: { not: null, gte: new Date(), lte: new Date(Date.now() + Number(days) * 86_400_000) },
      deal: { deletedAt: null, status: 'OPEN' },
    },
    include,
    take: 100,
  });

  for (const reg of registrations) {
    const daysLeft = daysUntil(reg.expiresAt!);
    const partnerSide = reg.side === 'PARTNER';
    const who = reg.vendor?.name ?? reg.partner?.name ?? 'Registration';

    await notify({
      event: 'registration_expiring',
      title: partnerSide
        ? `${who}'s registration on ${reg.deal.account.name} expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`
        : `${who} registration expires in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      body: `${reg.deal.reference} · ${reg.deal.account.name} · ${reg.deal.name}`,
      link: `/deals/${reg.deal.id}`,
      severity: daysLeft <= 7 ? 'critical' : 'warn',
      ownerId: reg.deal.ownerId,
      facts: [
        { title: partnerSide ? 'Partner' : 'Vendor', value: who },
        { title: 'Expires', value: reg.expiresAt!.toLocaleDateString('en-GB') },
        { title: 'Deal value', value: formatAed(num(reg.deal.amount)) },
      ],
    });

    // The partner hears once inside the window, not once a day until it lapses.
    const alreadyTold = reg.partnerNotifiedAt
      ? Date.now() - reg.partnerNotifiedAt.getTime() < Number(partnerDays) * 86_400_000
      : false;
    if (partnerSide && partnerMails && !alreadyTold && daysLeft <= Number(partnerDays)) {
      const result = await mailPartnerAboutRegistration(reg);
      if (!result.ok) console.warn(`[scheduler] partner not mailed for ${reg.deal.reference}: ${result.reason}`);
    }
  }

  // Anything already past its date gets flipped so reports stay honest — but tell
  // someone first, otherwise protection disappears with nobody the wiser.
  const lapsed = await prisma.dealRegistration.findMany({
    where: { status: { in: ['SUBMITTED', 'APPROVED'] }, expiresAt: { not: null, lt: new Date() } },
    include,
    take: 100,
  });

  for (const reg of lapsed) {
    const who = reg.vendor?.name ?? reg.partner?.name ?? 'Registration';
    await notify({
      event: 'registration_expired',
      title: reg.side === 'PARTNER'
        ? `${who}'s registration on ${reg.deal.account.name} has expired`
        : `${who} registration on ${reg.deal.reference} has expired`,
      body: `${reg.deal.reference} · ${reg.deal.account.name} · ${reg.deal.name}`,
      link: `/deals/${reg.deal.id}`,
      severity: 'critical',
      ownerId: reg.deal.ownerId,
      facts: [
        { title: reg.side === 'PARTNER' ? 'Partner' : 'Vendor', value: who },
        { title: 'Expired', value: reg.expiresAt!.toLocaleDateString('en-GB') },
        { title: 'Deal value', value: formatAed(num(reg.deal.amount)) },
      ],
    });

    if (reg.side === 'PARTNER' && partnerMails) {
      const result = await mailPartnerAboutRegistration(reg);
      if (!result.ok) console.warn(`[scheduler] partner not mailed for ${reg.deal.reference}: ${result.reason}`);
    }
  }

  await prisma.dealRegistration.updateMany({
    where: { status: { in: ['SUBMITTED', 'APPROVED'] }, expiresAt: { not: null, lt: new Date() } },
    data: { status: 'EXPIRED' },
  });
}

/**
 * Money due soon, both directions.
 *
 * Receivables: chase the customer before the date, not after it.
 * Payables: pay the vendor before the date, so a deal registration or a credit line
 * never lapses over an admin slip. Lead time is one Settings value for both.
 */
async function paymentsDueSoon(): Promise<void> {
  const days = Number(await getSetting<number>('finance.paymentReminderDays', 5));
  const now = new Date();
  const horizon = new Date(now.getTime() + days * 86_400_000);

  const [receivables, payables] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        type: 'TAX_INVOICE',
        status: { in: ['SENT', 'PARTIAL'] },
        dueDate: { not: null, gte: now, lte: horizon },
      },
      include: { account: { select: { name: true } }, deal: { select: { id: true, ownerId: true } } },
      take: 100,
    }),
    prisma.purchaseOrder.findMany({
      where: {
        direction: 'SUPPLIER',
        deletedAt: null,
        status: { notIn: ['DRAFT', 'CANCELLED'] },
        paymentDueDate: { not: null, gte: now, lte: horizon },
      },
      include: { account: { select: { name: true } } },
      take: 100,
    }),
  ]);

  for (const invoice of receivables) {
    const owed = num(invoice.total) - num(invoice.amountPaid);
    if (owed <= 0) continue;
    const daysLeft = Math.ceil((invoice.dueDate!.getTime() - now.getTime()) / 86_400_000);
    await notify({
      event: 'payment_due_soon',
      title: `${invoice.account.name} owes ${formatAed(owed)} in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      body: `Invoice ${invoice.number} falls due on ${invoice.dueDate!.toLocaleDateString('en-GB', { timeZone: TZ })}. Chase it now rather than after the date.`,
      link: `/invoices/${invoice.id}`,
      severity: 'info',
      ownerId: invoice.deal?.ownerId ?? invoice.createdById,
      facts: [
        { title: 'Invoice', value: invoice.number },
        { title: 'Outstanding', value: formatAed(owed) },
        { title: 'Due', value: invoice.dueDate!.toLocaleDateString('en-GB', { timeZone: TZ }) },
      ],
    });
  }

  for (const po of payables) {
    const owed = num(po.total) - num(po.amountPaid);
    if (owed <= 0) continue;
    const daysLeft = Math.ceil((po.paymentDueDate!.getTime() - now.getTime()) / 86_400_000);
    await notify({
      event: 'payable_due_soon',
      title: `Pay ${po.account.name} ${formatAed(owed)} within ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      body: `Purchase order ${po.number} falls due on ${po.paymentDueDate!.toLocaleDateString('en-GB', { timeZone: TZ })}.`,
      link: `/purchase-orders/${po.id}`,
      severity: daysLeft <= 2 ? 'warn' : 'info',
      ownerId: po.ownerId,
      facts: [
        { title: 'Purchase order', value: po.number },
        { title: 'Supplier', value: po.account.name },
        { title: 'Outstanding', value: formatAed(owed) },
        { title: 'Due', value: po.paymentDueDate!.toLocaleDateString('en-GB', { timeZone: TZ }) },
      ],
    });
  }
}

/** Supplier payments already past their date — reputational, so it gets its own event. */
async function overduePayables(): Promise<void> {
  const overdue = await prisma.purchaseOrder.findMany({
    where: {
      direction: 'SUPPLIER',
      deletedAt: null,
      status: { notIn: ['DRAFT', 'CANCELLED'] },
      paymentDueDate: { not: null, lt: new Date() },
    },
    include: { account: { select: { name: true } } },
    take: 100,
  });

  const unpaid = overdue.filter((po) => num(po.total) - num(po.amountPaid) > 0);
  if (unpaid.length === 0) return;

  const owed = unpaid.reduce((sum, po) => sum + (num(po.total) - num(po.amountPaid)), 0);
  await notify({
    event: 'payable_overdue',
    title: `${unpaid.length} supplier payment${unpaid.length === 1 ? '' : 's'} overdue`,
    body: unpaid.slice(0, 5).map((po) => `${po.number} ${po.account.name}`).join(' · '),
    link: '/purchase-orders?direction=SUPPLIER&unpaid=true',
    severity: 'warn',
    facts: [{ title: 'Total overdue', value: formatAed(owed) }],
  });
}

async function overdueInvoices(): Promise<void> {
  const overdue = await prisma.invoice.findMany({
    where: { type: 'TAX_INVOICE', status: { in: ['SENT', 'PARTIAL'] }, dueDate: { lt: new Date() } },
    include: { account: { select: { name: true } } },
    take: 100,
  });
  if (overdue.length === 0) return;

  await prisma.invoice.updateMany({
    where: { type: 'TAX_INVOICE', status: 'SENT', dueDate: { lt: new Date() } },
    data: { status: 'OVERDUE' },
  });

  const outstanding = overdue.reduce((s, i) => s + (num(i.total) - num(i.amountPaid)), 0);
  await notify({
    event: 'invoice_overdue',
    title: `${overdue.length} overdue invoice${overdue.length === 1 ? '' : 's'}`,
    body: overdue.slice(0, 5).map((i) => `${i.number} ${i.account.name}`).join(' · '),
    link: '/invoices?overdue=true',
    severity: 'warn',
    facts: [{ title: 'Outstanding', value: formatAed(outstanding) }],
  });
}

/** Weekly nudge when the quarter's committed + weighted pipeline will not cover target. */
async function targetCheck(): Promise<void> {
  const now = new Date();
  const quarter = Math.floor(now.getMonth() / 3) + 1;
  const qStart = new Date(Date.UTC(now.getFullYear(), (quarter - 1) * 3, 1));
  const qEnd = new Date(Date.UTC(now.getFullYear(), quarter * 3, 1));

  const target = await prisma.target.findFirst({ where: { userId: null, year: now.getFullYear(), quarter } });
  if (!target || num(target.amount) === 0) return;

  const [won, open] = await Promise.all([
    prisma.deal.aggregate({ where: { deletedAt: null, status: 'WON', closedAt: { gte: qStart, lt: qEnd } }, _sum: { amount: true } }),
    prisma.deal.findMany({ where: { deletedAt: null, status: 'OPEN', closeDate: { lt: qEnd } }, select: { amount: true, probability: true } }),
  ]);

  const achieved = num(won._sum.amount);
  const weighted = open.reduce((s, d) => s + (num(d.amount) * d.probability) / 100, 0);
  const coverage = ((achieved + weighted) / num(target.amount)) * 100;
  if (coverage >= 100) return;

  await notify({
    event: 'target_at_risk',
    title: `Q${quarter} target coverage at ${coverage.toFixed(0)}%`,
    body: `Committed ${formatAed(achieved)} plus weighted pipeline ${formatAed(weighted)} against a ${formatAed(num(target.amount))} target.`,
    link: '/',
    severity: coverage < 70 ? 'critical' : 'warn',
    facts: [
      { title: 'Target', value: formatAed(num(target.amount)) },
      { title: 'Won so far', value: formatAed(achieved) },
      { title: 'Weighted pipeline', value: formatAed(weighted) },
      { title: 'Gap', value: formatAed(Math.max(0, num(target.amount) - achieved - weighted)) },
    ],
  });
}

/**
 * Keep the exchange rates current. Vendor costs are converted with these, so a stale
 * rate quietly misprices every quote built that day.
 */
async function exchangeRates(): Promise<void> {
  const result = await refreshRates();
  if (result.updated.length > 0) {
    console.log(`[scheduler] rates updated: ${result.updated.map((c) => `${c}=${result.rates[c]}`).join(', ')}`);
  }

  // A refusal is worth a person's attention: it means the feed disagrees with the stored
  // rate by more than a market move explains, and nothing was written.
  for (const [currency, reason] of Object.entries(result.skipped)) {
    if (!reason.startsWith('Refused')) continue;
    await notify({
      event: 'fx_rate_suspect',
      title: `Exchange rate for ${currency} was refused`,
      body: reason,
      link: '/settings/finance',
      severity: 'warn',
      facts: [{ title: 'Currency', value: currency }],
    });
  }
}

async function safely(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[scheduler] ${name} failed:`, (err as Error).message);
    logSystem('error', 'cron', `${name} failed: ${(err as Error).message}`, { job: name });
  }
}

export function startScheduler(): void {
  // Task reminders: often enough to be useful, rare enough to stay quiet.
  tasks.push(cron.schedule('*/15 * * * *', () => void safely('taskReminders', taskReminders), { timezone: TZ }));

  // Rates before the working day, every day — a weekend quote needs a rate too.
  tasks.push(cron.schedule('0 7 * * *', () => void safely('exchangeRates', exchangeRates), { timezone: TZ }));

  // And once at boot if they are stale, so a machine that was off over a long weekend
  // is not pricing quotes off last week's rate. Deliberately not awaited: the API must
  // come up whether or not a third-party feed is reachable.
  void safely('exchangeRates', async () => {
    if (await ratesAreStale()) await exchangeRates();
  });

  /**
   * Photograph the pipeline at the end of the working day rather than the start, so the
   * day's moves are in the picture. Every day including weekends — a flat line over a
   * weekend is information, and a gap is just a hole in the chart.
   */
  tasks.push(cron.schedule('0 19 * * *', () => void safely('pipelineSnapshot', async () => {
    const { takenOn, rows, openNet } = await takePipelineSnapshot();
    console.log(`[scheduler] pipeline photographed for ${takenOn.toISOString().slice(0, 10)}: ${rows} row(s), ${formatAed(openNet)} open`);
  }), { timezone: TZ }));

  // Weekly per-deal snapshot for week-over-week movement. Monday 06:00 GST.
  tasks.push(cron.schedule('0 6 * * 1', () => void safely('weeklyDealSnapshot', async () => {
    const { weekOf, rows } = await takeWeeklyDealSnapshot();
    console.log(`[scheduler] weekly deal snapshot for ${weekOf.toISOString().slice(0, 10)}: ${rows} open deal(s)`);
  }), { timezone: TZ }));

  // Watch component health every 5 minutes: one snapshot, recorded for uptime and
  // checked for an up→down flip to alert admins.
  tasks.push(cron.schedule('*/5 * * * *', () => void safely('healthMonitor', async () => {
    const components = await componentStatuses();
    await recordComponentChecks(components);
    await recordResourceSample();
    await alertOnTransitions(components);
  }), { timezone: TZ }));

  // Trim the system log and health samples so they cannot grow without bound. 03:00 GST.
  tasks.push(cron.schedule('0 3 * * *', () => void safely('pruneSystemLogs', async () => {
    const removed = await pruneSystemLogs(30);
    const { count } = await prisma.componentCheck.deleteMany({ where: { at: { lt: new Date(Date.now() - 30 * 86_400_000) } } });
    const resources = await pruneResourceSamples(7);
    if (removed || count || resources) console.log(`[scheduler] pruned ${removed} log + ${count} health + ${resources} resource rows`);
  }), { timezone: TZ }));

  // Daily data-integrity sweep. 05:30 GST — after the 01:00-05:00 backup window has
  // closed, so it reads a settled database, and well before the 08:30 morning digest
  // so anything it finds is already in the log by the time someone reads their alerts.
  tasks.push(cron.schedule('30 5 * * *', () => void safely('dataHealth', async () => {
    const report = await dailyDataHealthSweep();
    if (!report.ok) console.log(`[scheduler] data integrity: ${report.findings.length} problem(s) found`);
  }), { timezone: TZ }));

  // Data retention: login IP history and long-abandoned leads. 03:15 GST.
  tasks.push(cron.schedule('15 3 * * *', () => void safely('retention', async () => {
    const loginRows = await pruneLoginAudit();
    const leads = await purgeExpiredLeads();
    if (loginRows || leads) console.log(`[scheduler] retention: ${loginRows} login-audit rows, ${leads} abandoned leads purged`);
  }), { timezone: TZ }));

  // Quiet-hours catch-up: everything notify() held overnight goes out as one email
  // per person right as the default window ends. 07:00 GST.
  tasks.push(cron.schedule('0 7 * * *', () => void safely('notificationDigest', async () => {
    const sent = await sendPendingDigests();
    if (sent) console.log(`[scheduler] sent ${sent} quiet-hours digest email(s)`);
  }), { timezone: TZ }));

  // Scheduled reports: whatever is due this hour, checked hourly. :05 to sit clear of
  // the top-of-hour jobs above.
  tasks.push(cron.schedule('5 * * * *', () => void safely('scheduledReports', async () => {
    const sent = await runDueScheduledReports();
    if (sent) console.log(`[scheduler] emailed ${sent} scheduled report(s)`);
  }), { timezone: TZ }));

  // Morning digest, 08:30 GST on working days (Mon-Fri in the UAE).
  tasks.push(cron.schedule('30 8 * * 1-5', async () => {
    await safely('staleAccounts', staleAccounts);
    await safely('stuckDeals', stuckDeals);
    await safely('expiringRegistrations', expiringRegistrations);
    await safely('renewals', async () => {
      const { opened, reminded, lapsed, gaps } = await sweepRenewals();
      if (opened || reminded || lapsed || gaps) console.log(`[scheduler] renewals: ${opened} opened, ${reminded} reminded, ${lapsed} lapsed, ${gaps} gaps flagged`);
    });
    await safely('overdueInvoices', overdueInvoices);
    await safely('paymentsDueSoon', paymentsDueSoon);
    await safely('overduePayables', overduePayables);
    await safely('missedBackupCheck', checkMissedBackups);
  }, { timezone: TZ }));

  // Sunday evening, before the UAE working week starts.
  tasks.push(cron.schedule('0 18 * * 0', () => void safely('targetCheck', targetCheck), { timezone: TZ }));

  // Backup, three kinds on their own cadence: physical on the admin-set
  // `backup.cron` (nightly by default), logical daily and config weekly — both
  // fixed at a quarter and three-quarters past the maintenance window's start hour,
  // so moving `backup.windowStartHour` shifts all three together. Each goes through
  // `runScheduledBackup`, which applies the overlap/window/skip-if-unchanged guards
  // a manual "Back up now" click deliberately bypasses.
  // Reading settings hits the database. If that is briefly unreachable at boot, an
  // unhandled rejection here would take the whole API down — so it is caught and the
  // API starts anyway, with backups simply not scheduled.
  void (async () => {
    try {
      const enabled = await getSetting<boolean>('backup.enabled', false);
      if (!enabled) return;

      const physicalExpr = String(await getSetting<string>('backup.cron', '0 2 * * *'));
      const windowStart = Number(await getSetting<number>('backup.windowStartHour', 1)) % 24;
      const logicalExpr = `15 ${windowStart} * * *`;
      const configExpr = `45 ${windowStart} * * 0`;

      const schedule = (kind: 'physical' | 'logical' | 'config', expression: string): void => {
        if (!cron.validate(expression)) {
          console.error(`[scheduler] ${kind} backup cron "${expression}" is not a valid cron expression — disabled.`);
          return;
        }
        tasks.push(cron.schedule(expression, () => void safely(`backup:${kind}`, async () => {
          const result = await runScheduledBackup(kind);
          if ('skipped' in result) console.log(`[scheduler] ${kind} backup skipped: ${result.skipped}`);
        }), { timezone: TZ }));
        console.log(`[scheduler] ${kind} backup scheduled (${expression} ${TZ})`);
      };

      schedule('physical', physicalExpr);
      schedule('logical', logicalExpr);
      schedule('config', configExpr);

      // Weekly proof the backups are actually restorable, well clear of the
      // maintenance window so it checks that week's fresh files, not last week's.
      tasks.push(cron.schedule('0 6 * * 1', () => void safely('weeklyAutoVerify', weeklyAutoVerify), { timezone: TZ }));
      console.log(`[scheduler] weekly backup verification scheduled (0 6 * * 1 ${TZ})`);
    } catch (err) {
      console.error('[scheduler] could not read the backup schedule — backups not scheduled:', (err as Error).message);
    }
  })();

  console.log(`[scheduler] started — ${tasks.length} job(s), timezone ${TZ}`);
}

export function stopScheduler(): void {
  for (const task of tasks) task.stop();
  tasks.length = 0;
}

/** Exposed so an admin can fire the digest manually from Settings. */
export const JOBS = { pipelineSnapshot: async () => { await takePipelineSnapshot(); }, taskReminders, staleAccounts, stuckDeals, expiringRegistrations, overdueInvoices, paymentsDueSoon, overduePayables, targetCheck, exchangeRates };
