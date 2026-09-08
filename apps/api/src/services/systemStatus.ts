import { prisma } from '../db.js';
import { getM365, graphFetch, pingM365 } from './graph.js';
import { pingWhatsapp } from './whatsapp.js';
import { getSetting } from '../lib/settings.js';
import { turnstileConfig, verifyTurnstile } from '../portal/requests.js';
import { backupScheduleCount } from '../jobs/scheduler.js';

/**
 * Live health of each app component, shared by the status page and the background
 * monitor that alerts on an up→down flip. Cheap by design: the DB ping is a SELECT 1,
 * the integrations reuse their cached credential checks.
 */

export interface Component {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

async function databaseComponent(): Promise<Component> {
  const started = performance.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { key: 'database', label: 'PostgreSQL', ok: true, detail: 'Reachable.', latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { key: 'database', label: 'PostgreSQL', ok: false, detail: (err as Error).message };
  }
}

async function backupsComponent(): Promise<Component> {
  const last = await prisma.backupRun.findFirst({ where: { status: 'success' }, orderBy: { startedAt: 'desc' } });
  if (!last) return { key: 'backups', label: 'Backups', ok: false, detail: 'No successful backup yet.' };
  const ageHours = (Date.now() - last.startedAt.getTime()) / 3_600_000;
  // A daily backup that has not succeeded in over 26h is stale (24h + slack).
  return { key: 'backups', label: 'Backups', ok: ageHours <= 26, detail: `Last success ${Math.round(ageHours)}h ago (${last.filename ?? 'unknown'}).` };
}

/** Persist one sample per component — the raw material for uptime percentages. */
export async function recordComponentChecks(components: Component[]): Promise<void> {
  await prisma.componentCheck.createMany({ data: components.map((c) => ({ component: c.key, ok: c.ok })) });
}

/** % of samples that were healthy per component, over the last day and week. */
export async function uptimeSummary(): Promise<Record<string, { day: number; week: number }>> {
  const rows = await prisma.componentCheck.findMany({
    where: { at: { gte: new Date(Date.now() - 7 * 86_400_000) } },
    select: { component: true, ok: true, at: true },
  });
  const dayCut = Date.now() - 86_400_000;
  const acc: Record<string, { dOk: number; dTot: number; wOk: number; wTot: number }> = {};
  for (const r of rows) {
    const a = (acc[r.component] ??= { dOk: 0, dTot: 0, wOk: 0, wTot: 0 });
    a.wTot++; if (r.ok) a.wOk++;
    if (r.at.getTime() >= dayCut) { a.dTot++; if (r.ok) a.dOk++; }
  }
  const pct = (ok: number, tot: number) => (tot ? Math.round((ok / tot) * 1000) / 10 : 100);
  const out: Record<string, { day: number; week: number }> = {};
  for (const [k, v] of Object.entries(acc)) out[k] = { day: pct(v.dOk, v.dTot), week: pct(v.wOk, v.wTot) };
  return out;
}

/**
 * Can we actually send email, as opposed to merely holding a token?
 *
 * A valid token says the app registration is fine; it says nothing about the mailbox
 * being reachable or the Mail.Send consent still standing. The email log knows what
 * really happened to the last few sends, which is the only evidence that counts.
 */
async function emailComponent(): Promise<Component> {
  const m365 = await getM365();
  if (!m365?.config.senderUpn) {
    return { key: 'email', label: 'Outbound email', ok: true, detail: 'No sending mailbox set — nothing is trying to send.' };
  }

  const since = new Date(Date.now() - 24 * 3_600_000);
  const [failed, sent, latest] = await Promise.all([
    prisma.emailLog.count({ where: { status: 'FAILED', createdAt: { gte: since } } }),
    prisma.emailLog.count({ where: { status: 'SENT', createdAt: { gte: since } } }),
    prisma.emailLog.findFirst({ where: { status: 'FAILED' }, orderBy: { createdAt: 'desc' }, select: { error: true } }),
  ]);
  if (failed > 0) {
    return {
      key: 'email', label: 'Outbound email', ok: false,
      detail: `${failed} send${failed === 1 ? '' : 's'} failed in the last 24h${sent ? `, ${sent} went` : ''}. ${(latest?.error ?? '').slice(0, 120)}`,
    };
  }

  // Nothing has failed, so ask Graph whether the mailbox is still there. Cheap, and it
  // catches a revoked consent before somebody discovers it by sending a quote.
  try {
    const res = await graphFetch(`/users/${encodeURIComponent(m365.config.senderUpn)}?$select=id`);
    return res.ok
      ? { key: 'email', label: 'Outbound email', ok: true, detail: `${m365.config.senderUpn} reachable${sent ? ` · ${sent} sent in 24h` : ''}.` }
      : { key: 'email', label: 'Outbound email', ok: false, detail: `Mailbox check failed (${res.status}). Confirm Mail.Send is still consented.` };
  } catch (err) {
    return { key: 'email', label: 'Outbound email', ok: false, detail: (err as Error).message };
  }
}

/** Teams cards go to incoming-webhook URLs; a channel that has been deleted stops working silently. */
async function teamsComponent(): Promise<Component> {
  const hooks = await prisma.teamsWebhook.findMany({ where: { isActive: true }, select: { name: true, lastError: true, lastPostAt: true } });
  if (hooks.length === 0) return { key: 'teams', label: 'Teams alerts', ok: true, detail: 'No channel connected.' };
  const broken = hooks.filter((h) => h.lastError);
  return broken.length > 0
    ? { key: 'teams', label: 'Teams alerts', ok: false, detail: `${broken.length} of ${hooks.length} channel(s) failing: ${(broken[0].lastError ?? '').slice(0, 100)}` }
    : { key: 'teams', label: 'Teams alerts', ok: true, detail: `${hooks.length} channel(s) connected.` };
}

/** The bot check. If it is guarding the sign-in, its health is everybody's problem. */
async function botCheckComponent(): Promise<Component> {
  const [{ configured }, onLogin] = await Promise.all([turnstileConfig(), getSetting<boolean>('auth.turnstileOnLogin', false)]);
  if (!configured) return { key: 'turnstile', label: 'Bot protection', ok: true, detail: 'Not configured.' };
  // An empty token is always refused by Cloudflare — a "rejected" answer therefore proves
  // the service answered us at all, which is the only thing worth checking here.
  const result = await verifyTurnstile('heartbeat-probe', null);
  const reachable = result !== 'unavailable';
  return {
    key: 'turnstile', label: 'Bot protection', ok: reachable,
    detail: reachable
      ? `Cloudflare answering${onLogin ? ' · guarding the staff sign-in' : ' · portal request form only'}.`
      : `Cloudflare unreachable — ${onLogin ? 'sign-ins are going through unchecked' : 'the request form is unguarded'}.`,
  };
}

/**
 * Are the scheduled jobs actually registered?
 *
 * Worth its own line because of how it failed once: an install booted with backups
 * switched off registered no backup jobs, and switching them on afterwards changed
 * nothing until a restart. Everything looked configured; nothing ran. A component that
 * states what is registered turns that from a silent failure into a visible one.
 */
async function jobsComponent(): Promise<Component> {
  const backupsOn = await getSetting<boolean>('backup.enabled', false);
  const scheduled = backupScheduleCount();
  if (backupsOn && scheduled === 0) {
    return { key: 'jobs', label: 'Scheduled jobs', ok: false, detail: 'Backups are switched on but no backup job is registered. Save any backup setting, or restart the app.' };
  }
  return {
    key: 'jobs', label: 'Scheduled jobs', ok: true,
    detail: backupsOn ? `${scheduled} backup job(s) registered.` : 'Running. Backups are switched off.',
  };
}

export async function componentStatuses(): Promise<Component[]> {
  const [database, m365, whatsapp, activeHooks, backups, email, teams, botCheck, jobs] = await Promise.all([
    databaseComponent(),
    pingM365(),
    pingWhatsapp(),
    prisma.webhook.findMany({ where: { isActive: true }, select: { disabledAt: true } }),
    backupsComponent(),
    emailComponent(),
    teamsComponent(),
    botCheckComponent(),
    jobsComponent(),
  ]);
  const disabled = activeHooks.filter((h) => h.disabledAt).length;

  return [
    database,
    // An unconfigured integration is not "down" — nothing depends on it yet.
    { key: 'microsoft365', label: 'Microsoft 365', ok: m365.configured ? m365.ok : true, detail: m365.message },
    email,
    { key: 'whatsapp', label: 'WhatsApp', ok: whatsapp.configured ? whatsapp.ok : true, detail: whatsapp.message },
    teams,
    botCheck,
    {
      key: 'webhooks', label: 'Outbound webhooks', ok: disabled === 0,
      detail: activeHooks.length === 0 ? 'None configured.' : disabled > 0 ? `${disabled} disabled by failures.` : `${activeHooks.length} active.`,
    },
    backups,
    jobs,
  ];
}
