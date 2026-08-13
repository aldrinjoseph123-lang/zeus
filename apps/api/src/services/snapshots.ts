import { prisma, num } from '../db.js';

/**
 * A daily photograph of the open pipeline.
 *
 * The deal table only knows today. A stage change overwrites what was there before, and a
 * won deal stops being pipeline at all — so "was the pipeline healthier last month?" has
 * no answer anywhere in Zeus unless something writes one down each day.
 *
 * This is that. It cannot be backfilled: the history it would need is precisely what does
 * not exist. The first useful comparison is a month after it starts running, and the
 * screens say so rather than drawing an empty chart and letting it look broken.
 */

/** Midnight today in Dubai, as the date the photograph belongs to. */
export function pipelineDay(now = new Date()): Date {
  const dubai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  return new Date(Date.UTC(dubai.getFullYear(), dubai.getMonth(), dubai.getDate()));
}

export interface SnapshotResult {
  takenOn: Date;
  rows: number;
  openNet: number;
}

/**
 * Photograph today's open pipeline, one row per stage per owner.
 *
 * Safe to run more than once a day: the day's rows are deleted and rewritten rather than
 * added to. That is deliberate rather than an upsert — an unassigned deal has a null
 * owner, Postgres treats NULLs as distinct in a unique key, and it would quietly
 * photograph itself twice after a restart.
 */
export async function takePipelineSnapshot(now = new Date()): Promise<SnapshotResult> {
  const takenOn = pipelineDay(now);

  const deals = await prisma.deal.findMany({
    where: { deletedAt: null, status: 'OPEN' },
    select: { stageId: true, ownerId: true, amount: true, probability: true },
  });

  const buckets = new Map<string, { stageId: string; ownerId: string | null; openCount: number; openNet: number; weighted: number }>();
  for (const deal of deals) {
    const key = `${deal.stageId}::${deal.ownerId ?? ''}`;
    const bucket = buckets.get(key) ?? { stageId: deal.stageId, ownerId: deal.ownerId, openCount: 0, openNet: 0, weighted: 0 };
    bucket.openCount += 1;
    bucket.openNet += num(deal.amount);
    bucket.weighted += (num(deal.amount) * deal.probability) / 100;
    buckets.set(key, bucket);
  }

  const rows = [...buckets.values()];
  await prisma.$transaction([
    prisma.pipelineSnapshot.deleteMany({ where: { takenOn } }),
    prisma.pipelineSnapshot.createMany({ data: rows.map((r) => ({ ...r, takenOn })) }),
  ]);

  return { takenOn, rows: rows.length, openNet: rows.reduce((sum, r) => sum + r.openNet, 0) };
}

export interface TrendPoint {
  date: string;
  openCount: number;
  openNet: number;
  weighted: number;
}

/**
 * The trend, one point per day, for whoever is allowed to see it.
 *
 * `ownerIds` of null means every owner; an empty array means none, which is a reader with
 * no scope rather than a reason to show them the company's numbers.
 */
export async function pipelineTrend(
  from: Date,
  to: Date,
  ownerIds: string[] | null,
): Promise<TrendPoint[]> {
  if (ownerIds && ownerIds.length === 0) return [];

  const snapshots = await prisma.pipelineSnapshot.findMany({
    where: {
      takenOn: { gte: pipelineDay(from), lte: pipelineDay(to) },
      ...(ownerIds ? { ownerId: { in: ownerIds } } : {}),
    },
    orderBy: { takenOn: 'asc' },
  });

  const byDay = new Map<string, TrendPoint>();
  for (const row of snapshots) {
    const date = row.takenOn.toISOString().slice(0, 10);
    const point = byDay.get(date) ?? { date, openCount: 0, openNet: 0, weighted: 0 };
    point.openCount += row.openCount;
    point.openNet += num(row.openNet);
    point.weighted += num(row.weighted);
    byDay.set(date, point);
  }
  return [...byDay.values()];
}

// ── weekly per-deal movement ────────────────────────────────────────────────────

/** The Monday (date-only, Dubai week) the given moment belongs to. */
export function mondayOf(now = new Date()): Date {
  const dubai = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai' }));
  const sinceMonday = (dubai.getDay() + 6) % 7; // 0=Sun→6, 1=Mon→0 …
  return new Date(Date.UTC(dubai.getFullYear(), dubai.getMonth(), dubai.getDate() - sinceMonday));
}

/**
 * One row per open deal for this week — the raw material for week-over-week movement.
 * Idempotent: the week's rows are rewritten, so a re-run never double-counts. Only
 * OPEN deals are captured; a deal that closed is detected by its absence next week.
 */
export async function takeWeeklyDealSnapshot(now = new Date()): Promise<{ weekOf: Date; rows: number }> {
  const weekOf = mondayOf(now);
  const deals = await prisma.deal.findMany({
    where: { deletedAt: null, status: 'OPEN' },
    select: { id: true, stageId: true, ownerId: true, amount: true, status: true, stage: { select: { order: true } } },
  });
  await prisma.$transaction([
    prisma.dealSnapshot.deleteMany({ where: { weekOf } }),
    prisma.dealSnapshot.createMany({
      data: deals.map((d) => ({ dealId: d.id, weekOf, stageId: d.stageId, ownerId: d.ownerId, amount: d.amount, status: d.status, stageOrder: d.stage.order })),
    }),
  ]);
  return { weekOf, rows: deals.length };
}

export interface MovementRow {
  reference: string; name: string; owner: string; change: string;
  fromStage: string; toStage: string; fromAmount: number; toAmount: number;
}

/**
 * Compare the two most recent weekly snapshots (up to `asOf`) and classify every deal:
 * new / advanced / slipped / grew / shrank / won / lost / unchanged. `scope` is the
 * caller's deal visibility filter, so a manager sees only their team's movement.
 */
export async function weeklyDealMovement(asOf = new Date(), scope: Record<string, unknown> = {}): Promise<{ rows: MovementRow[]; thisWeek: Date | null; lastWeek: Date | null }> {
  const weeks = (await prisma.dealSnapshot.findMany({
    where: { weekOf: { lte: mondayOf(asOf) } },
    distinct: ['weekOf'], select: { weekOf: true }, orderBy: { weekOf: 'desc' }, take: 2,
  })).map((w) => w.weekOf);
  if (weeks.length < 2) return { rows: [], thisWeek: weeks[0] ?? null, lastWeek: null };

  const [thisWeek, lastWeek] = weeks;
  const [now, prev] = await Promise.all([
    prisma.dealSnapshot.findMany({ where: { weekOf: thisWeek } }),
    prisma.dealSnapshot.findMany({ where: { weekOf: lastWeek } }),
  ]);
  const nowMap = new Map(now.map((s) => [s.dealId, s]));
  const prevMap = new Map(prev.map((s) => [s.dealId, s]));
  const ids = [...new Set([...nowMap.keys(), ...prevMap.keys()])];

  const [deals, stages] = await Promise.all([
    prisma.deal.findMany({ where: { id: { in: ids }, ...scope }, select: { id: true, reference: true, name: true, status: true, owner: { select: { name: true } } } }),
    prisma.stage.findMany({ where: { id: { in: [...new Set([...now, ...prev].map((s) => s.stageId))] } }, select: { id: true, name: true } }),
  ]);
  const dealMap = new Map(deals.map((d) => [d.id, d]));
  const stageName = (id?: string) => stages.find((s) => s.id === id)?.name ?? '—';

  const rows: MovementRow[] = [];
  for (const id of ids) {
    const d = dealMap.get(id);
    if (!d) continue; // out of the caller's scope
    const n = nowMap.get(id);
    const p = prevMap.get(id);
    let change: string, fromStage = '—', toStage = '—', fromAmount = 0, toAmount = 0;
    if (p && !n) {
      change = d.status === 'WON' ? 'Won' : d.status === 'LOST' ? 'Lost' : 'Closed';
      fromStage = stageName(p.stageId); fromAmount = num(p.amount);
    } else if (n && !p) {
      change = 'New'; toStage = stageName(n.stageId); toAmount = num(n.amount);
    } else if (n && p) {
      fromStage = stageName(p.stageId); toStage = stageName(n.stageId); fromAmount = num(p.amount); toAmount = num(n.amount);
      change = n.stageOrder > p.stageOrder ? 'Advanced' : n.stageOrder < p.stageOrder ? 'Slipped' : toAmount > fromAmount ? 'Grew' : toAmount < fromAmount ? 'Shrank' : 'Unchanged';
    } else continue;
    rows.push({ reference: d.reference, name: d.name, owner: d.owner?.name ?? 'Unassigned', change, fromStage, toStage, fromAmount, toAmount });
  }
  const order = ['Won', 'Advanced', 'Grew', 'New', 'Slipped', 'Shrank', 'Lost', 'Closed', 'Unchanged'];
  rows.sort((a, b) => order.indexOf(a.change) - order.indexOf(b.change));
  return { rows, thisWeek, lastWeek };
}
