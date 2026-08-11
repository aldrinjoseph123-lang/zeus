import { prisma } from '../db.js';
import { pingM365 } from './graph.js';
import { pingWhatsapp } from './whatsapp.js';

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

export async function componentStatuses(): Promise<Component[]> {
  const [database, m365, whatsapp, activeHooks, backups] = await Promise.all([
    databaseComponent(),
    pingM365(),
    pingWhatsapp(),
    prisma.webhook.findMany({ where: { isActive: true }, select: { disabledAt: true } }),
    backupsComponent(),
  ]);
  const disabled = activeHooks.filter((h) => h.disabledAt).length;

  return [
    database,
    // An unconfigured integration is not "down" — nothing depends on it yet.
    { key: 'microsoft365', label: 'Microsoft 365', ok: m365.configured ? m365.ok : true, detail: m365.message },
    { key: 'whatsapp', label: 'WhatsApp', ok: whatsapp.configured ? whatsapp.ok : true, detail: whatsapp.message },
    {
      key: 'webhooks', label: 'Outbound webhooks', ok: disabled === 0,
      detail: activeHooks.length === 0 ? 'None configured.' : disabled > 0 ? `${disabled} disabled by failures.` : `${activeHooks.length} active.`,
    },
    backups,
  ];
}
