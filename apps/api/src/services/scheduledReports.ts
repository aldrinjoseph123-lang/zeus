import { prisma } from '../db.js';
import type { ScheduledReport } from '@prisma/client';
import { REPORTS, buildContext } from '../routes/reports.js';
import { sessionUserById } from '../auth/session.js';
import { tablePdf } from './pdf.js';
import { tableXlsx } from './xlsx.js';
import { sendMail } from './graph.js';

/**
 * A report from the registry, emailed out on a schedule instead of pulled by hand.
 * Runs with the scheduling admin's own read scope (via sessionUserById), so it can
 * never mail a rep's numbers to someone the screen would have refused.
 */

export function gulfParts(now: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dubai', hour: '2-digit', hour12: false, weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Sun');
  return { hour, weekday };
}

/**
 * Pure "should this fire right now" decision, kept separate from the DB fetch and
 * the mail send so it can be tested without either. A one-hour cron could see the
 * same slot twice near its edges; the 20h dedupe means nothing here has to track
 * "did today's run already happen" as a separate flag.
 */
export function isDue(schedule: Pick<ScheduledReport, 'enabled' | 'frequency' | 'hour' | 'weekday' | 'lastRunAt'>, now: Date): boolean {
  if (!schedule.enabled) return false;
  const { hour, weekday } = gulfParts(now);
  if (schedule.hour !== hour) return false;
  if (schedule.frequency === 'weekly' && schedule.weekday !== weekday) return false;
  if (schedule.lastRunAt && now.getTime() - schedule.lastRunAt.getTime() < 20 * 3_600_000) return false;
  return true;
}

async function runOne(schedule: ScheduledReport): Promise<void> {
  const def = REPORTS.find((r) => r.key === schedule.reportKey);
  if (!def) throw new Error(`No report named "${schedule.reportKey}".`);
  if (!schedule.createdById) throw new Error('No one to run this as — the schedule has no creator on file.');

  const user = await sessionUserById(schedule.createdById);
  if (!user) throw new Error('The user who scheduled this is no longer active.');
  if (!schedule.recipientEmails.length) throw new Error('No recipients on file.');

  const ctx = await buildContext({ query: {}, user });
  const result = await def.run(ctx);
  const stamp = new Date().toISOString().slice(0, 10);
  const subtitle = `${def.name} · generated ${new Date().toLocaleString('en-GB')}`;

  const buffer = schedule.format === 'xlsx'
    ? await tableXlsx({ title: def.name, columns: def.columns, rows: result.rows, summary: result.summary })
    : await tablePdf({ title: def.name, subtitle, columns: def.columns, rows: result.rows, summary: result.summary });

  await sendMail({
    to: schedule.recipientEmails,
    subject: `[Zeus] ${schedule.label || def.name} — ${stamp}`,
    html: `<p style="font-family:sans-serif;font-size:14px;color:#0a0a0a">${def.name}, attached. Generated ${new Date().toLocaleString('en-GB')}.</p>`,
    attachments: [{
      filename: `zeus-${schedule.reportKey}-${stamp}.${schedule.format}`,
      contentType: schedule.format === 'xlsx'
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'application/pdf',
      contentBytes: buffer.toString('base64'),
    }],
  });

  await prisma.scheduledReport.update({ where: { id: schedule.id }, data: { lastRunAt: new Date() } });
}

/** The hourly sweep: whatever is due this hour and has not already run today. */
export async function runDueScheduledReports(now = new Date()): Promise<number> {
  const candidates = await prisma.scheduledReport.findMany({ where: { enabled: true } });

  let sent = 0;
  for (const schedule of candidates) {
    if (!isDue(schedule, now)) continue;
    try {
      await runOne(schedule);
      sent += 1;
    } catch (err) {
      console.error(`[scheduledReports] "${schedule.reportKey}" failed:`, (err as Error).message);
    }
  }
  return sent;
}
