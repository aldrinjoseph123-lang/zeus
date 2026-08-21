import { prisma } from '../db.js';
import { env } from '../env.js';
import { getSetting } from '../lib/settings.js';
import { postToTeams, type CardFact } from './teams.js';
import { sendMail } from './graph.js';
import { dispatch } from './webhooks.js';
import { alertText, sendWhatsapp } from './whatsapp.js';

/**
 * One entry point for every alert. Each event type has a NotificationRule row
 * (edited in Settings → Notifications) that decides whether it fires and on which
 * channels. Delivery failures are logged, never thrown — an unreachable webhook
 * must not roll back a deal update.
 */

export const NOTIFICATION_EVENTS = [
  { event: 'task_due', label: 'Task due soon', thresholdDays: null as number | null, defaults: { inApp: true, email: false, teams: false } },
  { event: 'task_overdue', label: 'Task overdue', thresholdDays: null, defaults: { inApp: true, email: true, teams: false } },
  { event: 'account_stale', label: 'Account with no activity', thresholdDays: 7, defaults: { inApp: true, email: false, teams: true } },
  { event: 'deal_stale', label: 'Deal stuck in a stage', thresholdDays: 14, defaults: { inApp: true, email: false, teams: true } },
  { event: 'deal_won', label: 'Deal won', thresholdDays: null, defaults: { inApp: true, email: false, teams: true } },
  { event: 'deal_lost', label: 'Deal lost', thresholdDays: null, defaults: { inApp: true, email: false, teams: true } },
  { event: 'deal_assigned', label: 'Deal assigned to you', thresholdDays: null, defaults: { inApp: true, email: true, teams: false } },
  { event: 'lead_assigned', label: 'Lead assigned to you', thresholdDays: null, defaults: { inApp: true, email: true, teams: false } },
  { event: 'registration_expiring', label: 'Deal registration expiring', thresholdDays: 30, defaults: { inApp: true, email: true, teams: true } },
  { event: 'registration_expired', label: 'Deal registration expired', thresholdDays: 0, defaults: { inApp: true, email: true, teams: true } },
  { event: 'renewal_due', label: 'Subscription coming up for renewal', thresholdDays: 90, defaults: { inApp: true, email: true, teams: true } },
  { event: 'renewal_lapsed', label: 'Subscription lapsed without renewal', thresholdDays: 0, defaults: { inApp: true, email: true, teams: true } },
  { event: 'renewal_gap', label: 'Won deal with no renewal on file', thresholdDays: 14, defaults: { inApp: true, email: false, teams: true } },
  { event: 'approval_requested', label: 'Approval requested', thresholdDays: null, defaults: { inApp: true, email: true, teams: true } },
  { event: 'approval_decided', label: 'Approval granted or rejected', thresholdDays: null, defaults: { inApp: true, email: true, teams: false } },
  { event: 'quote_accepted', label: 'Quote accepted', thresholdDays: null, defaults: { inApp: true, email: false, teams: true } },
  { event: 'invoice_overdue', label: 'Invoice overdue', thresholdDays: 0, defaults: { inApp: true, email: true, teams: false } },
  { event: 'payment_due_soon', label: 'Customer payment due soon', thresholdDays: 5, defaults: { inApp: true, email: true, teams: false } },
  { event: 'payable_due_soon', label: 'Supplier payment due soon', thresholdDays: 5, defaults: { inApp: true, email: true, teams: true } },
  { event: 'payable_overdue', label: 'Supplier payment overdue', thresholdDays: 0, defaults: { inApp: true, email: true, teams: true } },
  { event: 'invoice_paid', label: 'Invoice paid in full', thresholdDays: null, defaults: { inApp: true, email: false, teams: true } },
  { event: 'duplicate_found', label: 'Possible duplicate created', thresholdDays: null, defaults: { inApp: true, email: false, teams: false } },
  { event: 'backup_failed', label: 'Backup failed', thresholdDays: null, defaults: { inApp: true, email: true, teams: true } },
  { event: 'backup_missed', label: 'Backup overdue — none has run in its expected window', thresholdDays: null, defaults: { inApp: true, email: true, teams: true } },
  { event: 'backup_verify_failed', label: 'Weekly backup verification found a problem', thresholdDays: null, defaults: { inApp: true, email: true, teams: true } },
  { event: 'data_integrity_failed', label: 'Daily data check found a problem', thresholdDays: null, defaults: { inApp: true, email: true, teams: true } },
  { event: 'fx_rate_suspect', label: 'Exchange rate looked wrong and was refused', thresholdDays: null, defaults: { inApp: true, email: true, teams: false } },
  { event: 'target_at_risk', label: 'Quarterly target at risk', thresholdDays: null, defaults: { inApp: true, email: false, teams: true } },
  { event: 'component_down', label: 'A system component went down', thresholdDays: null, defaults: { inApp: true, email: true, teams: true } },
  { event: 'component_recovered', label: 'A system component recovered', thresholdDays: null, defaults: { inApp: true, email: false, teams: true } },
] as const;

export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]['event'];

export interface NotifyInput {
  event: NotificationEvent | string;
  title: string;
  body?: string;
  /** Path within the app, e.g. /deals/abc123 — turned into an absolute link. */
  link?: string;
  severity?: 'info' | 'warn' | 'critical';
  /** Record owner — the default audience. */
  ownerId?: string | null;
  /** Extra explicit recipients on top of the rule's audience. */
  userIds?: string[];
  facts?: CardFact[];
}

async function resolveRecipients(audience: string, ownerId?: string | null, recipientIds: string[] = []): Promise<string[]> {
  const ids = new Set<string>(recipientIds);

  if (audience === 'owner' && ownerId) ids.add(ownerId);

  if (audience === 'manager' || audience === 'owner') {
    if (ownerId) {
      const owner = await prisma.user.findUnique({ where: { id: ownerId }, select: { managerId: true } });
      if (audience === 'manager' && owner?.managerId) ids.add(owner.managerId);
    }
  }

  if (audience === 'admins') {
    const admins = await prisma.user.findMany({
      where: { isActive: true, role: { name: { in: ['Administrator', 'Sales Manager'] } } },
      select: { id: true },
    });
    for (const a of admins) ids.add(a.id);
  }

  if (audience === 'all') {
    const all = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
    for (const u of all) ids.add(u.id);
  }

  return [...ids];
}

/**
 * Makes sure every event in the list above has a rule row.
 *
 * Without a row, `notify()` falls back to in-app only and the event never appears on
 * the Notifications screen to be configured — so a release that adds an event would
 * silently ship it half-wired to every database seeded before it existed. Runs at
 * boot; adding an event to NOTIFICATION_EVENTS is all that is ever needed.
 */
export async function ensureNotificationRules(): Promise<number> {
  const existing = new Set((await prisma.notificationRule.findMany({ select: { event: true } })).map((r) => r.event));
  const missing = NOTIFICATION_EVENTS.filter((e) => !existing.has(e.event));

  for (const event of missing) {
    await prisma.notificationRule.create({
      data: {
        event: event.event,
        label: event.label,
        enabled: true,
        inApp: event.defaults.inApp,
        email: event.defaults.email,
        // Teams and WhatsApp stay off until a channel is actually connected.
        teams: false,
        whatsapp: false,
        thresholdDays: event.thresholdDays,
        audience: ['deal_won', 'deal_lost', 'backup_failed', 'backup_missed', 'backup_verify_failed', 'data_integrity_failed', 'target_at_risk', 'invoice_overdue', 'component_down', 'component_recovered'].includes(event.event)
          ? 'admins'
          : 'owner',
      },
    });
  }
  return missing.length;
}

/**
 * Gulf-time quiet hours. Critical severity always bypasses it — a failed backup or a
 * down component pages immediately, quiet hours or not. Off entirely unless an admin
 * turns it on in Settings.
 */
export async function isQuietHours(severity?: string, now = new Date()): Promise<boolean> {
  if (severity === 'critical') return false;
  if (!(await getSetting<boolean>('notify.quietHoursEnabled', false))) return false;

  const start = Number(await getSetting<number>('notify.quietHoursStart', 21));
  const end = Number(await getSetting<number>('notify.quietHoursEnd', 7));
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;
  return start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export async function notify(input: NotifyInput): Promise<void> {
  try {
    const rule = await prisma.notificationRule.findUnique({ where: { event: input.event } });
    if (rule && !rule.enabled) return;

    const audience = rule?.audience ?? 'owner';
    const recipients = await resolveRecipients(audience, input.ownerId, [
      ...(rule?.recipientIds ?? []),
      ...(input.userIds ?? []),
    ]);

    const absoluteLink = input.link ? `${env.APP_URL.replace(/\/$/, '')}${input.link}` : undefined;
    const wantsEmail = Boolean(rule?.email);
    const deferEmail = wantsEmail && (await isQuietHours(input.severity));

    if ((rule?.inApp ?? true) && recipients.length) {
      await prisma.notification.createMany({
        data: recipients.map((userId) => ({
          userId,
          type: input.event,
          title: input.title,
          body: input.body ?? null,
          link: input.link ?? null,
          severity: input.severity ?? 'info',
          wantsEmail,
          // Stamped now for an immediate send; left null when quiet hours defer it —
          // that null is exactly what the digest sweep later looks for.
          emailedAt: wantsEmail && !deferEmail ? new Date() : null,
        })),
      });
    }

    /**
     * Anything else that asked to hear about this. Deliberately not awaited: a webhook is
     * a courtesy to another system, and a deal closing must not wait on — or fail
     * because of — somebody's endpoint being slow.
     */
    void dispatch({
      event: input.event,
      title: input.title,
      body: input.body,
      link: absoluteLink,
      severity: input.severity,
      facts: input.facts,
    }).catch((err) => console.error('[notify] webhook dispatch failed:', (err as Error).message));

    if (rule?.teams) {
      await postToTeams(
        {
          title: input.title,
          text: input.body,
          facts: input.facts,
          linkUrl: absoluteLink,
          severity: input.severity,
        },
        rule.teamsWebhookId,
      ).catch((err) => console.error('[notify] teams delivery failed:', (err as Error).message));
    }

    if (rule?.whatsapp && recipients.length) {
      const users = await prisma.user.findMany({
        where: { id: { in: recipients }, whatsappNumber: { not: null } },
        select: { whatsappNumber: true },
      });
      const text = alertText({ title: input.title, body: input.body, facts: input.facts, linkUrl: absoluteLink });
      // One send per number, and a failure on one never stops the others or the request.
      for (const user of users) {
        await sendWhatsapp(user.whatsappNumber!, text)
          .catch((err) => console.error('[notify] whatsapp delivery failed:', (err as Error).message));
      }
    }

    if (wantsEmail && !deferEmail && recipients.length) {
      const users = await prisma.user.findMany({ where: { id: { in: recipients } }, select: { email: true } });
      const to = users.map((u) => u.email).filter(Boolean);
      if (to.length) {
        await sendMail({
          to,
          subject: `[Zeus] ${input.title}`,
          html: emailTemplate(input.title, input.body, absoluteLink, input.facts),
        }).catch((err) => console.error('[notify] email delivery failed:', (err as Error).message));
      }
    }
  } catch (err) {
    console.error('[notify] failed:', (err as Error).message);
  }
}

/**
 * The quiet-hours catch-up. Everything notify() deferred (wantsEmail, never sent)
 * goes out here as one email per person instead of a flood of separate ones — the
 * point of quiet hours is not just delay, it is not paging someone fifteen times.
 * Called once, right as the window ends (see jobs/scheduler.ts).
 */
export async function sendPendingDigests(): Promise<number> {
  const pending = await prisma.notification.findMany({
    where: { wantsEmail: true, emailedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, title: true, body: true, link: true, createdAt: true },
  });
  if (!pending.length) return 0;

  const byUser = new Map<string, typeof pending>();
  for (const row of pending) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

  const users = await prisma.user.findMany({ where: { id: { in: [...byUser.keys()] } }, select: { id: true, email: true } });
  let sent = 0;

  for (const user of users) {
    const items = byUser.get(user.id) ?? [];
    if (!items.length || !user.email) continue;
    try {
      await sendMail({
        to: [user.email],
        subject: `[Zeus] ${items.length} update${items.length === 1 ? '' : 's'} while you were away`,
        html: digestTemplate(items),
      });
      await prisma.notification.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { emailedAt: new Date() } });
      sent += 1;
    } catch (err) {
      console.error(`[notify] digest failed for ${user.email}:`, (err as Error).message);
    }
  }
  return sent;
}

function digestTemplate(items: Array<{ title: string; body: string | null; link: string | null }>): string {
  const rows = items
    .map((i) => `<tr><td style="padding:12px 0;border-top:1px solid #ebebe8">
      <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:#0a0a0a">${escapeHtml(i.title)}</p>
      ${i.body ? `<p style="margin:0;font-size:13px;color:#4a4a4a">${escapeHtml(i.body)}</p>` : ''}
      ${i.link ? `<a href="${env.APP_URL.replace(/\/$/, '')}${i.link}" style="font-size:12px;color:#e11d2e;text-decoration:none">Open in Zeus &rsaquo;</a>` : ''}
    </td></tr>`)
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d8d8d4">
        <tr><td style="background:#0a0a0a;padding:18px 24px">
          <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.08em">ZEUS</span>
          <span style="color:#e11d2e;font-size:16px;font-weight:700">.</span>
        </td></tr>
        <tr><td style="padding:24px">
          <h1 style="margin:0 0 4px;font-size:18px;color:#0a0a0a">While you were away</h1>
          <p style="margin:0 0 8px;font-size:13px;color:#6b6b6b">${items.length} update${items.length === 1 ? '' : 's'} held for quiet hours.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>
        </td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid #ebebe8;color:#999;font-size:11px">
          Sent by Zeus CRM. Manage alerts in Settings &rsaquo; Notifications.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

export function emailTemplate(title: string, body?: string, link?: string, facts?: CardFact[]): string {
  const rows = (facts ?? [])
    .map(
      (f) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#6b6b6b;font-size:13px;white-space:nowrap">${escapeHtml(f.title)}</td>` +
        `<td style="padding:6px 0;color:#0a0a0a;font-size:13px;font-weight:600">${escapeHtml(f.value)}</td></tr>`,
    )
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:'Segoe UI',Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f4;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #d8d8d4">
        <tr><td style="background:#0a0a0a;padding:18px 24px">
          <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.08em">ZEUS</span>
          <span style="color:#e11d2e;font-size:16px;font-weight:700">.</span>
        </td></tr>
        <tr><td style="padding:24px">
          <h1 style="margin:0 0 12px;font-size:18px;color:#0a0a0a">${escapeHtml(title)}</h1>
          ${body ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#4a4a4a">${escapeHtml(body)}</p>` : ''}
          ${rows ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px">${rows}</table>` : ''}
          ${link ? `<a href="${link}" style="display:inline-block;background:#e11d2e;color:#ffffff;text-decoration:none;padding:10px 20px;font-size:13px;font-weight:600;letter-spacing:.04em">OPEN IN ZEUS</a>` : ''}
        </td></tr>
        <tr><td style="padding:14px 24px;border-top:1px solid #ebebe8;color:#999;font-size:11px">
          Sent by Zeus CRM. Manage alerts in Settings &rsaquo; Notifications.
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
