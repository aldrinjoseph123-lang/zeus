import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { prisma } from '../db.js';
import { env } from '../env.js';

/**
 * Compute utilisation: CPU %, system RAM %, and disk % on the volume that holds the
 * data. Sampled every few minutes by the monitor and stored, so the status page can
 * graph consumption over time rather than a single instant.
 */

export interface ResourceSampleValues {
  cpuPct: number;
  memPct: number;
  diskPct: number;
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0, total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

/** Busy % across all cores, measured over a short window so it reflects "now". */
async function cpuPercent(): Promise<number> {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, 120));
  const b = cpuTimes();
  const idle = b.idle - a.idle;
  const total = b.total - a.total;
  return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
}

async function diskPercent(): Promise<number> {
  try {
    const s = await statfs(env.BACKUP_DIR || process.cwd());
    const total = s.blocks;
    const used = s.blocks - s.bfree;
    return total > 0 ? Math.round((used / total) * 1000) / 10 : 0;
  } catch {
    return 0; // statfs unsupported or path missing — report 0 rather than crash
  }
}

export async function sampleResources(): Promise<ResourceSampleValues> {
  const [cpuPct, diskPct] = await Promise.all([cpuPercent(), diskPercent()]);
  const memPct = Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1000) / 10;
  return { cpuPct, memPct, diskPct };
}

export async function recordResourceSample(): Promise<void> {
  const v = await sampleResources();
  await prisma.resourceSample.create({ data: v });
}

export async function resourceHistory(hours = 24): Promise<Array<{ at: string; cpuPct: number; memPct: number; diskPct: number }>> {
  const rows = await prisma.resourceSample.findMany({
    where: { at: { gte: new Date(Date.now() - hours * 3_600_000) } },
    orderBy: { at: 'asc' },
    select: { at: true, cpuPct: true, memPct: true, diskPct: true },
  });
  return rows.map((r) => ({ at: r.at.toISOString(), cpuPct: r.cpuPct, memPct: r.memPct, diskPct: r.diskPct }));
}

export async function pruneResourceSamples(days = 7): Promise<number> {
  const { count } = await prisma.resourceSample.deleteMany({ where: { at: { lt: new Date(Date.now() - days * 86_400_000) } } });
  return count;
}
