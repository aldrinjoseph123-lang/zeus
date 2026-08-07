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
