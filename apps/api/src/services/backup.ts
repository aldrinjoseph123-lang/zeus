import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGzip, gunzipSync, gzipSync } from 'node:zlib';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { logSystem } from './systemLog.js';

const execFileAsync = promisify(execFile);
import { getSetting } from '../lib/settings.js';
import { uploadFile } from './graph.js';
import { notify } from './notify.js';
import { encryptBuffer, decryptBuffer } from '../lib/crypto.js';

/**
 * Database backup, three kinds:
 *  - physical: pg_dump of the whole database (the original, restorable-anywhere copy)
 *  - logical:  the core business tables, one NDJSON line per record, grouped by model
 *  - config:   the tables that define how Zeus behaves (settings, roles, pipelines,
 *              custom fields, notification rules) rather than what it holds
 *
 * Every kind flows through the same pipeline: produce bytes -> gzip -> encrypt
 * (optional) -> write to whichever destinations are configured -> record what
 * happened. `runBackup()` does that unconditionally (used by the manual "Back up
 * now" buttons); `runScheduledBackup()` wraps it with the automation guards
 * (overlap, maintenance window, skip-if-unchanged) the scheduler calls instead.
 */

const KINDS = ['physical', 'logical', 'config'] as const;
export type BackupKind = (typeof KINDS)[number];

// ── what each non-physical kind exports ────────────────────────────────────────

/** The three operations every model needs across backup/automation/restore: `find`
 * for a full export, `count` as skip-if-unchanged's cheap comparison, `upsert` as
 * B3's restore-by-id. Every Prisma delegate shares this shape; the cast at each call
 * site is what a factory over heterogeneous generated types costs in this codebase's
 * house style (no bare `any`). */
interface Upsertable {
  findMany(): Promise<Array<Record<string, unknown>>>;
  count(): Promise<number>;
  upsert(args: { where: { id: string }; create: Record<string, unknown>; update: Record<string, unknown> }): Promise<unknown>;
}

export interface BackupModel { key: string; find: () => Promise<unknown[]>; count: () => Promise<number>; upsert: (row: Record<string, unknown>) => Promise<unknown> }

function modelEntry(key: string, delegate: Upsertable): BackupModel {
  return {
    key,
    find: () => delegate.findMany(),
    count: () => delegate.count(),
    upsert: (row) => delegate.upsert({ where: { id: row.id as string }, create: row, update: row }),
  };
}

/** Business data. Reads as `zeus.deal`, not `prisma.deal`, only because this is the
 * export surface, not a live query — no scope filtering, this is a backup.
 * Declaration order is also B3's restore order: every FK *within this list* points
 * backward (contact->account, deal->account/contact, quote->deal, invoice->deal,
 * subscription->product/account/deal, activity->everything before it), so applying
 * a multi-module restore in this order is dependency-safe. One FK crosses kinds —
 * Deal.pipelineId/stageId point at CONFIG_MODELS — so restoring 'deal' assumes the
 * referenced pipeline/stage already exist live, same as any other config data a
 * logical restore does not also bring back. */
export const LOGICAL_MODELS: BackupModel[] = [
  modelEntry('account', prisma.account as unknown as Upsertable),
  modelEntry('contact', prisma.contact as unknown as Upsertable),
  modelEntry('lead', prisma.lead as unknown as Upsertable),
  modelEntry('deal', prisma.deal as unknown as Upsertable),
  modelEntry('quote', prisma.quote as unknown as Upsertable),
  modelEntry('invoice', prisma.invoice as unknown as Upsertable),
  modelEntry('purchaseOrder', prisma.purchaseOrder as unknown as Upsertable),
  modelEntry('product', prisma.product as unknown as Upsertable),
  modelEntry('subscription', prisma.subscription as unknown as Upsertable),
  modelEntry('activity', prisma.activity as unknown as Upsertable),
];

/** App configuration — what makes this Zeus install behave the way it does,
 * separate from the business records it holds. Same dependency-order guarantee as
 * above (stage->pipeline is the only real cross-reference here). */
export const CONFIG_MODELS: BackupModel[] = [
  modelEntry('setting', prisma.setting as unknown as Upsertable),
  modelEntry('role', prisma.role as unknown as Upsertable),
  modelEntry('pipeline', prisma.pipeline as unknown as Upsertable),
  modelEntry('stage', prisma.stage as unknown as Upsertable),
  modelEntry('customField', prisma.customField as unknown as Upsertable),
  modelEntry('notificationRule', prisma.notificationRule as unknown as Upsertable),
  modelEntry('teamsWebhook', prisma.teamsWebhook as unknown as Upsertable),
  modelEntry('scheduledReport', prisma.scheduledReport as unknown as Upsertable),
];

/**
 * One NDJSON line per record: `{"model":"deal","row":{...}}`. Flat and
 * self-describing — a restore (or a human with `grep`) can dispatch on `model`
 * without a schema to consult.
 * ponytail: loads each table fully into memory before writing; fine at this size.
 * Upgrade to a streaming write (one findMany page at a time) if a table's export
 * ever gets large enough to matter.
 */
async function dumpModels(models: Array<{ key: string; find: () => Promise<unknown[]> }>): Promise<{ data: Buffer; rowCounts: Record<string, number> }> {
  const lines: string[] = [];
  const rowCounts: Record<string, number> = {};
  for (const model of models) {
    const rows = await model.find();
    rowCounts[model.key] = rows.length;
    for (const row of rows) lines.push(JSON.stringify({ model: model.key, row }));
  }
  return { data: gzipSync(Buffer.from(lines.join('\n'), 'utf8'), { level: 9 }), rowCounts };
}

function dump(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Prisma's DATABASE_URL carries ?schema=public, which pg_dump rejects as an
    // invalid URI query param. Pull it out and hand it to pg_dump's own --schema,
    // leaving any real libpq params (sslmode, …) on the connection string.
    const url = new URL(env.DATABASE_URL);
    const schema = url.searchParams.get('schema');
    url.searchParams.delete('schema');
    const args = ['--no-owner', '--no-privileges', '--format=plain']; // --no-owner: restorable into a differently-named role
    if (schema) args.push(`--schema=${schema}`);
    args.push(url.toString());

    const child = spawn(env.PG_DUMP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const gzip = createGzip({ level: 9 });
    const chunks: Buffer[] = [];
    let stderr = '';
    let flushed = false; // gzip has emitted all output
    let ok = false; // pg_dump exited 0
    const finish = () => { if (flushed && ok) resolve(Buffer.concat(chunks)); };

    child.stdout.pipe(gzip); // ends gzip when pg_dump's stdout closes
    gzip.on('data', (c: Buffer) => chunks.push(c));
    gzip.on('end', () => { flushed = true; finish(); });
    gzip.on('error', reject);
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    child.on('error', (err) =>
      reject(new Error(`Could not run pg_dump (${env.PG_DUMP_PATH}): ${err.message}`)),
    );
    // Gate resolution on the exit code: a failed pg_dump still flushes an empty
    // gzip, and resolving on that produced silent zero-byte "successful" backups.
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`pg_dump exited ${code}: ${stderr.trim().slice(0, 500)}`));
      ok = true;
      finish();
    });
  });
}

/** Gulf-time grandfather-father-son bucket for a run started right now. Assigned
 * once at creation, not reclassified later — simplest rule that gives a sane shape
 * (~7 daily, ~4 weekly, ~12 monthly kept) without tracking history per file. */
export function tierFor(now = new Date()): 'daily' | 'weekly' | 'monthly' {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Dubai', day: '2-digit', weekday: 'short' }).formatToParts(now);
  const day = Number(parts.find((p) => p.type === 'day')?.value ?? '2');
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  if (day === 1) return 'monthly';
  if (weekday === 'Sun') return 'weekly';
  return 'daily';
}

const extFor = (kind: BackupKind) => (kind === 'physical' ? 'sql.gz' : 'ndjson.gz');

/** Keeps a separate count per (kind, tier) bucket instead of one flat "keep newest
 * N" — a monthly backup from three months ago must survive a week of daily churn. */
async function pruneLocal(): Promise<void> {
  const [retainDaily, retainWeekly, retainMonthly] = await Promise.all([
    getSetting<number>('backup.retainDaily', 7),
    getSetting<number>('backup.retainWeekly', 4),
    getSetting<number>('backup.retainMonthly', 12),
  ]);
  const retain: Record<string, number> = { daily: Number(retainDaily), weekly: Number(retainWeekly), monthly: Number(retainMonthly) };

  for (const kind of KINDS) {
    for (const tier of ['daily', 'weekly', 'monthly'] as const) {
      const runs = await prisma.backupRun.findMany({
        where: { kind, tier, filename: { not: null }, destinations: { has: 'local' } },
        orderBy: { startedAt: 'desc' },
        select: { filename: true },
      });
      for (const stale of runs.slice(retain[tier])) {
        if (stale.filename) await rm(path.join(env.BACKUP_DIR, stale.filename), { force: true });
      }
    }
  }
}

interface WriteResult { destinations: string[]; localPath: string; remoteUrl: string | null; errors: string[] }

/** Local is unconditional (a backup that only exists in the cloud is one API outage
 * away from being no backup at all); NAS and OneDrive are each independent — one
 * failing does not cost the other its chance to succeed. */
async function writeToDestinations(filename: string, data: Buffer, opts: { uploadToOneDrive: boolean }): Promise<WriteResult> {
  const destinations: string[] = [];
  const errors: string[] = [];

  await mkdir(env.BACKUP_DIR, { recursive: true });
  const localPath = path.join(env.BACKUP_DIR, filename);
  await writeFile(localPath, data);
  destinations.push('local');

  const nasPath = String(await getSetting<string>('backup.nasPath', ''));
  if (nasPath) {
    try {
      await mkdir(nasPath, { recursive: true });
      await writeFile(path.join(nasPath, filename), data);
      destinations.push('nas');
    } catch (err) {
      errors.push(`NAS: ${(err as Error).message}`);
    }
  }

  let remoteUrl: string | null = null;
  if (opts.uploadToOneDrive) {
    try {
      const folder = String(await getSetting<string>('backup.folder', 'Zeus CRM Backups')) || 'Zeus CRM Backups';
      remoteUrl = await uploadFile(`${folder}/${filename}`, data, 'application/gzip');
      destinations.push('onedrive');
    } catch (err) {
      errors.push(`OneDrive: ${(err as Error).message}`);
    }
  }

  return { destinations, localPath, remoteUrl, errors };
}

export interface BackupResult {
  id: string;
  filename: string;
  sizeBytes: number;
  localPath: string;
  remoteUrl: string | null;
  destinations: string[];
  encrypted: boolean;
  error?: string;
}

export async function runBackup(opts: { kind?: BackupKind; uploadToOneDrive?: boolean } = {}): Promise<BackupResult> {
  const kind = opts.kind ?? 'physical';
  const tier = tierFor();
  const run = await prisma.backupRun.create({ data: { status: 'running', kind, tier } });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `zeus-${kind}-${stamp}.${extFor(kind)}`;

  try {
    const { data: raw, rowCounts } = kind === 'physical'
      ? { data: await dump(), rowCounts: null as Record<string, number> | null }
      : await dumpModels(kind === 'logical' ? LOGICAL_MODELS : CONFIG_MODELS);

    const encrypted = await getSetting<boolean>('backup.encrypted', true);
    const data = encrypted ? encryptBuffer(raw) : raw;
    const finalFilename = encrypted ? `${filename}.enc` : filename;
    const checksum = createHash('sha256').update(data).digest('hex');

    const { destinations, localPath, remoteUrl, errors } = await writeToDestinations(finalFilename, data, {
      uploadToOneDrive: opts.uploadToOneDrive !== false,
    });

    const uploadError = errors.length ? errors.join('; ') : null;
    await prisma.backupRun.update({
      where: { id: run.id },
      data: {
        // A local-only copy dies with the server, so an intended-but-failed extra
        // destination is 'partial', not a full success — matches the health check,
        // which only counts 'success'.
        status: uploadError ? 'partial' : 'success',
        filename: finalFilename,
        sizeBytes: data.byteLength,
        destinations,
        encrypted,
        checksum,
        rowCounts: rowCounts ?? undefined,
        error: uploadError,
        finishedAt: new Date(),
      },
    });
    // Prune only after this run's own row carries its final `destinations` — pruning
    // earlier would query for "local" backups before this one had recorded having
    // written to local, undercounting the very run just created.
    await pruneLocal();

    if (uploadError) {
      await notify({
        event: 'backup_failed',
        title: `${kind === 'physical' ? 'Backup' : `${kind[0].toUpperCase()}${kind.slice(1)} backup`} saved locally, but not everywhere`,
        body: `${finalFilename} (${(data.byteLength / 1_048_576).toFixed(1)} MB) is on the server. ${uploadError}`,
        severity: 'warn',
        userIds: [],
      });
    }

    return { id: run.id, filename: finalFilename, sizeBytes: data.byteLength, localPath, remoteUrl, destinations, encrypted, error: uploadError ?? undefined };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.backupRun.update({ where: { id: run.id }, data: { status: 'failed', error: message, finishedAt: new Date() } });
    logSystem('error', 'backup', message, { filename, kind });
    await notify({
      event: 'backup_failed',
      title: `Zeus ${kind} backup failed`,
      body: message,
      severity: 'critical',
    });
    throw err;
  }
}

export async function lastBackups(limit = 20) {
  return prisma.backupRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
}

// ── automation (B2): guards the scheduler applies that a manual "Back up now"
// click deliberately skips — an admin pressing the button wants it to run now. ──

/** Same wrap-safe hour-range check `isQuietHours` uses. Gates logical/config's own
 * fixed schedule; physical keeps its own admin-set `backup.cron` and is not
 * re-gated by this — the admin already chose when it runs. */
async function inMaintenanceWindow(now = new Date()): Promise<boolean> {
  const start = Number(await getSetting<number>('backup.windowStartHour', 1));
  const end = Number(await getSetting<number>('backup.windowEndHour', 5));
  if (start === end) return true;
  const hour = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Dubai', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

async function backupInProgress(): Promise<boolean> {
  return (await prisma.backupRun.count({ where: { status: 'running' } })) > 0;
}

async function recordSkip(kind: BackupKind, reason: string, rowCounts?: Record<string, number>): Promise<{ id: string; skipped: string }> {
  const run = await prisma.backupRun.create({
    data: { status: 'skipped', kind, tier: tierFor(), error: reason, rowCounts: rowCounts ?? undefined, finishedAt: new Date() },
  });
  logSystem('info', 'backup', `${kind} backup skipped: ${reason}`, { kind });
  return { id: run.id, skipped: reason };
}

/**
 * What the scheduler calls instead of `runBackup()` directly. Three guards, only
 * the first applying to every kind:
 *  - never start a second run while one is already in flight
 *  - logical/config only fire inside the maintenance window
 *  - logical/config skip if every model's row count matches the last run's —
 *    a count match is a cheap, imperfect signal (an edit that doesn't change row
 *    count slips through) but right-sized for config data that rarely churns.
 * A skip still writes a `BackupRun` row (status 'skipped') so it is visible on the
 * Backups page and counts as "on schedule" for the missed-run check below.
 */
export async function runScheduledBackup(kind: BackupKind, now = new Date()): Promise<BackupResult | { id: string; skipped: string }> {
  if (await backupInProgress()) return recordSkip(kind, 'Another backup is already running.');

  if (kind !== 'physical') {
    if (!(await inMaintenanceWindow(now))) return recordSkip(kind, 'Outside the maintenance window.');

    const models = kind === 'logical' ? LOGICAL_MODELS : CONFIG_MODELS;
    const counts: Record<string, number> = {};
    for (const model of models) counts[model.key] = await model.count();

    const last = await prisma.backupRun.findFirst({
      where: { kind, status: { in: ['success', 'partial', 'skipped'] } },
      orderBy: { startedAt: 'desc' },
    });
    const previous = last?.rowCounts as Record<string, number> | undefined;
    const unchanged = previous && models.every((m) => previous[m.key] === counts[m.key]);
    if (unchanged) return recordSkip(kind, 'No changes since the last backup of this kind.', counts);
  }

  return runBackup({ kind });
}

const MISSED_GRACE_HOURS: Record<BackupKind, number> = { physical: 36, logical: 36, config: 216 };

/**
 * A kind with no success/partial/skipped run inside its grace window has been
 * missed — a 'skipped' run still counts, since "nothing changed" is a legitimate
 * reason not to have a fresh file. Checked once a day; alerts every day it is still
 * overdue rather than only on the transition, the same way a failed backup keeps
 * mattering until someone fixes it.
 */
export async function checkMissedBackups(): Promise<void> {
  if (!(await getSetting<boolean>('backup.enabled', false))) return;

  for (const kind of KINDS) {
    const last = await prisma.backupRun.findFirst({
      where: { kind, status: { in: ['success', 'partial', 'skipped'] } },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    const graceMs = MISSED_GRACE_HOURS[kind] * 3_600_000;
    if (last && Date.now() - last.startedAt.getTime() <= graceMs) continue;

    await notify({
      event: 'backup_missed',
      title: `${kind[0].toUpperCase()}${kind.slice(1)} backup is overdue`,
      body: last
        ? `Last ${kind} backup ran ${last.startedAt.toLocaleString('en-GB', { timeZone: 'Asia/Dubai' })} — over ${MISSED_GRACE_HOURS[kind]}h ago.`
        : `No ${kind} backup has ever run.`,
      severity: 'critical',
    });
  }
}

export interface RestoreCheck {
  ok: boolean;
  filename: string | null;
  tables: number;
  bytes: number;
  note: string;
}

/** The most recent physical backup that actually landed locally — validate/verify
 * are pg_dump-specific (they gunzip a SQL script), so they operate on this kind
 * only. Driven by BackupRun, not a directory listing: it already knows exactly
 * which file is newest and whether it is encrypted, with no filename parsing. */
async function latestPhysicalBackup() {
  return prisma.backupRun.findFirst({
    where: { kind: 'physical', status: { in: ['success', 'partial'] }, filename: { not: null }, destinations: { has: 'local' } },
    orderBy: { startedAt: 'desc' },
  });
}

async function readAndDecompress(filename: string, encrypted: boolean): Promise<{ sql: Buffer; gz: Buffer } | { error: string; gz: Buffer }> {
  const raw = await readFile(path.join(env.BACKUP_DIR, filename));
  try {
    const compressed = encrypted ? decryptBuffer(raw) : raw;
    return { sql: gunzipSync(compressed), gz: raw };
  } catch (err) {
    return { error: encrypted ? `Could not decrypt or decompress: ${(err as Error).message}` : 'Backup file is not valid gzip.', gz: raw };
  }
}

/**
 * Reads a logical/config `BackupRun`'s file back into `{model -> rows}`, the
 * dual of `dumpModels()`. Same decrypt/decompress path `validateLatestBackup` uses
 * for physical — content-agnostic, so it works unchanged here too.
 */
export async function readNdjsonBackup(run: { filename: string; encrypted: boolean }): Promise<Map<string, Array<Record<string, unknown>>>> {
  const result = await readAndDecompress(run.filename, run.encrypted);
  if ('error' in result) throw new Error(result.error);

  const byModel = new Map<string, Array<Record<string, unknown>>>();
  for (const line of result.sql.toString('utf8').split('\n')) {
    if (!line) continue;
    const { model, row } = JSON.parse(line) as { model: string; row: Record<string, unknown> };
    (byModel.get(model) ?? byModel.set(model, []).get(model)!).push(row);
  }
  return byModel;
}

export interface ParityCheck {
  ok: boolean;
  filename: string | null;
  mismatches: Array<{ model: string; expected: number; actual: number }>;
  note: string;
}

async function latestOfKind(kind: 'logical' | 'config') {
  return prisma.backupRun.findFirst({
    where: { kind, status: { in: ['success', 'partial'] }, filename: { not: null }, destinations: { has: 'local' } },
    orderBy: { startedAt: 'desc' },
  });
}

/**
 * Logical/config's analogue of Validate: does the file's actual content still match
 * what `BackupRun.rowCounts` recorded at the moment it was written? Catches
 * corruption or truncation between then and now — the file could otherwise look
 * fine (valid gzip, valid JSON lines) while quietly missing records.
 */
export async function checkBackupParity(runId: string): Promise<ParityCheck> {
  const run = await prisma.backupRun.findUnique({ where: { id: runId } });
  if (!run || !run.filename || !run.destinations.includes('local')) {
    return { ok: false, filename: run?.filename ?? null, mismatches: [], note: 'Backup not found, or has no local copy to check.' };
  }
  if (run.kind === 'physical') {
    return { ok: false, filename: run.filename, mismatches: [], note: 'Physical backups are checked with Validate/Verify, not row-count parity.' };
  }

  let byModel: Map<string, Array<Record<string, unknown>>>;
  try {
    byModel = await readNdjsonBackup({ filename: run.filename, encrypted: run.encrypted });
  } catch (err) {
    return { ok: false, filename: run.filename, mismatches: [], note: (err as Error).message };
  }

  const expected = (run.rowCounts as Record<string, number> | null) ?? {};
  const mismatches: Array<{ model: string; expected: number; actual: number }> = [];
  for (const [model, count] of Object.entries(expected)) {
    const actual = byModel.get(model)?.length ?? 0;
    if (actual !== count) mismatches.push({ model, expected: count, actual });
  }

  return {
    ok: mismatches.length === 0,
    filename: run.filename,
    mismatches,
    note: mismatches.length === 0
      ? `${Object.keys(expected).length} model(s), row counts match what was recorded at backup time.`
      : `${mismatches.length} model(s) do not match the count recorded at backup time — the file may be corrupted or truncated.`,
  };
}

/**
 * Cheap integrity check that needs no database and no restore rights: the file must
 * decrypt (if encrypted) and decompress to something that looks like a pg_dump.
 * This is the "validate only" path available without the privileged restore
 * permission.
 * ponytail: reads the whole dump into memory to count CREATE TABLE; fine at this size.
 */
export async function validateLatestBackup(): Promise<RestoreCheck> {
  const run = await latestPhysicalBackup();
  if (!run?.filename) return { ok: false, filename: null, tables: 0, bytes: 0, note: 'No local physical backup to validate.' };

  const result = await readAndDecompress(run.filename, run.encrypted);
  if ('error' in result) return { ok: false, filename: run.filename, tables: 0, bytes: result.gz.byteLength, note: result.error };

  const text = result.sql.toString('latin1');
  const tables = (text.match(/^CREATE TABLE /gm) ?? []).length;
  const looksLikeDump = tables > 0 || /PostgreSQL database dump/.test(text);
  return {
    ok: result.sql.byteLength > 0 && looksLikeDump,
    filename: run.filename, tables, bytes: result.gz.byteLength,
    note: result.sql.byteLength === 0 ? 'Backup decompresses to nothing.'
      : looksLikeDump ? `Valid gzip, ${tables} CREATE TABLE statements.`
        : 'Decompressed, but does not look like a database dump.',
  };
}

/** Restore into a throwaway psql stdin stream; ON_ERROR_STOP=0 so a benign notice
 *  (e.g. "schema public already exists") does not fail the run — the table count is
 *  the real success signal. */
function psqlRestore(psql: string, url: string, input: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(psql, [url, '-q', '-v', 'ON_ERROR_STOP=0'], { stdio: ['pipe', 'ignore', 'pipe'] });
    child.on('error', reject);
    child.on('close', () => resolve());
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Prove the latest local physical backup is genuinely restorable: decrypt/gunzip
 * it, restore into a throwaway database, count the tables, then drop it. A backup
 * that exists but will not restore is worse than none, because it is trusted.
 * ponytail: restores the whole dump to count tables; fine at this size. For a large
 * DB, a schema-only restore would verify structure far faster.
 */
export async function verifyLatestBackup(): Promise<RestoreCheck> {
  const run = await latestPhysicalBackup();
  if (!run?.filename) return { ok: false, filename: null, tables: 0, bytes: 0, note: 'No local physical backup to verify.' };

  const result = await readAndDecompress(run.filename, run.encrypted);
  if ('error' in result) return { ok: false, filename: run.filename, tables: 0, bytes: result.gz.byteLength, note: result.error };
  const { sql, gz } = result;
  const filename = run.filename;

  const psql = env.PG_DUMP_PATH.replace(/pg_dump(\.exe)?$/i, 'psql$1');
  const base = new URL(env.DATABASE_URL);
  base.searchParams.delete('schema'); // psql rejects Prisma's ?schema= just as pg_dump does
  const scratch = `zeus_verify_${randomBytes(6).toString('hex')}`;
  const adminUrl = new URL(base.toString()); adminUrl.pathname = '/postgres';
  const targetUrl = new URL(base.toString()); targetUrl.pathname = `/${scratch}`;

  try {
    await execFileAsync(psql, [adminUrl.toString(), '-q', '-c', `CREATE DATABASE "${scratch}"`], { timeout: 30_000 });
    await psqlRestore(psql, targetUrl.toString(), sql);
    const { stdout } = await execFileAsync(psql, [targetUrl.toString(), '-tAc', "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"], { timeout: 30_000 });
    const tables = Number(stdout.trim()) || 0;
    if (tables > 0) logSystem('info', 'backup', `Backup verified: ${filename} restored ${tables} tables.`, { filename });
    return { ok: tables > 0, filename, tables, bytes: gz.byteLength, note: tables > 0 ? `Restored cleanly — ${tables} tables.` : 'Restore produced no tables.' };
  } catch (err) {
    logSystem('error', 'backup', `Backup verify failed: ${(err as Error).message}`, { filename });
    return { ok: false, filename, tables: 0, bytes: gz.byteLength, note: (err as Error).message.slice(0, 300) };
  } finally {
    await execFileAsync(psql, [adminUrl.toString(), '-q', '-c', `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`], { timeout: 30_000 }).catch(() => undefined);
  }
}

/**
 * Weekly proof that the backups being made are backups that would actually help:
 * physical's real restore-check plus row-count parity on the most recent local
 * logical and config file. One alert for the whole sweep rather than one per kind —
 * a bad night that touches all three is one incident, not three.
 */
export async function weeklyAutoVerify(): Promise<void> {
  const failures: string[] = [];

  const physical = await verifyLatestBackup();
  if (!physical.ok && physical.filename) failures.push(`physical (${physical.filename}): ${physical.note}`);

  for (const kind of ['logical', 'config'] as const) {
    const run = await latestOfKind(kind);
    if (!run) continue;
    const parity = await checkBackupParity(run.id);
    if (!parity.ok) failures.push(`${kind} (${parity.filename}): ${parity.note}`);
  }

  if (failures.length) {
    await notify({
      event: 'backup_verify_failed',
      title: 'Weekly backup verification found a problem',
      body: failures.join('\n'),
      severity: 'critical',
    });
  }
}

export async function localBackupSize(): Promise<{ count: number; bytes: number }> {
  try {
    const runs = await prisma.backupRun.findMany({ where: { filename: { not: null }, destinations: { has: 'local' } }, select: { filename: true } });
    let bytes = 0;
    let count = 0;
    for (const run of runs) {
      try {
        bytes += (await stat(path.join(env.BACKUP_DIR, run.filename!))).size;
        count += 1;
      } catch {
        // File pruned or moved since the run was recorded — skip rather than fail the whole tally.
      }
    }
    return { count, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}
