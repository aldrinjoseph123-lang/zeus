import { prisma } from '../db.js';
import { logSystem } from './systemLog.js';
import { LOGICAL_MODELS, CONFIG_MODELS, readNdjsonBackup, runBackup, type BackupModel } from './backup.js';

/** Invoices and purchase orders are financial documents — restoring them needs the
 * same elevated permission Verify (restore) already requires, on top of the base
 * ability to trigger a restore at all. */
const FINANCIAL_MODELS = new Set(['invoice', 'purchaseOrder']);

export function needsElevatedPermission(models: string[]): boolean {
  return models.some((m) => FINANCIAL_MODELS.has(m));
}

export interface RestorePlan { model: string; toCreate: number; toUpdate: number }

export interface RestoreOutcome {
  filename: string;
  plans: RestorePlan[];
  applied: boolean;
  safetyBackupId?: string;
  safetyBackupFilename?: string;
  created?: number;
  updated?: number;
  failed?: Array<{ model: string; id: string; error: string }>;
}

/**
 * Module-into-live restore. Two calls with the same shape: without `confirm` this
 * only reads — the backup file and a batch `findMany(id in …)` per requested model —
 * and returns a dry-run diff. With `confirm: true` it also takes a fresh safety
 * backup of the same kind first (so the restore itself is undoable the same way),
 * then upserts by id in `LOGICAL_MODELS`/`CONFIG_MODELS` declaration order, which is
 * already dependency-safe (see the comment there). No deletes: a module restore
 * only creates or updates, never removes a live record absent from the backup.
 */
export async function restoreModules(runId: string, models: string[], confirm: boolean): Promise<RestoreOutcome> {
  const run = await prisma.backupRun.findUnique({ where: { id: runId } });
  if (!run) throw new Error('Backup not found.');
  if (run.kind === 'physical') throw new Error('Physical backups restore as a whole database, not by module — use Verify (restore) instead.');
  if (!run.filename || !run.destinations.includes('local')) throw new Error('This backup has no local copy to restore from.');

  const registry: BackupModel[] = run.kind === 'logical' ? LOGICAL_MODELS : CONFIG_MODELS;
  const known = new Map(registry.map((m) => [m.key, m]));
  const requested = [...new Set(models)].filter((m) => known.has(m));
  if (!requested.length) throw new Error('No valid module selected.');

  const byModel = await readNdjsonBackup({ filename: run.filename, encrypted: run.encrypted });

  // Always applied in the registry's own order, regardless of the order requested —
  // that order is what makes a multi-module restore dependency-safe.
  const orderedKeys = registry.map((m) => m.key).filter((k) => requested.includes(k));

  const plans: RestorePlan[] = [];
  const work = new Map<string, { rows: Array<Record<string, unknown>>; liveIds: Set<string> }>();

  for (const key of orderedKeys) {
    const rows = byModel.get(key) ?? [];
    const ids = rows.map((r) => r.id as string);
    const live = ids.length
      ? await (prisma as unknown as Record<string, { findMany: (args: unknown) => Promise<Array<{ id: string }>> }>)[key]
          .findMany({ where: { id: { in: ids } }, select: { id: true } })
      : [];
    const liveIds = new Set(live.map((r) => r.id));
    work.set(key, { rows, liveIds });
    plans.push({ model: key, toCreate: ids.length - liveIds.size, toUpdate: liveIds.size });
  }

  if (!confirm) return { filename: run.filename, plans, applied: false };

  const safety = await runBackup({ kind: run.kind as 'logical' | 'config' });

  let created = 0;
  let updated = 0;
  const failed: Array<{ model: string; id: string; error: string }> = [];

  for (const key of orderedKeys) {
    const model = known.get(key)!;
    const { rows, liveIds } = work.get(key)!;
    for (const row of rows) {
      const id = row.id as string;
      try {
        await model.upsert(row);
        if (liveIds.has(id)) updated++;
        else created++;
      } catch (err) {
        failed.push({ model: key, id, error: (err as Error).message });
      }
    }
  }

  logSystem('info', 'backup', `Restored ${created} created, ${updated} updated across ${orderedKeys.length} module(s) from ${run.filename}.`, { runId, models: orderedKeys });

  return {
    filename: run.filename, plans, applied: true,
    safetyBackupId: safety.id, safetyBackupFilename: safety.filename,
    created, updated, failed,
  };
}
