import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGzip, gunzipSync } from 'node:zlib';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { logSystem } from './systemLog.js';

const execFileAsync = promisify(execFile);
import { getSetting } from '../lib/settings.js';
import { uploadFile } from './graph.js';
import { notify } from './notify.js';

/**
 * Database backup: pg_dump -> gzip -> local copy -> OneDrive/SharePoint.
 * The local copy is kept so a failed upload still leaves you with a backup.
 */

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

async function pruneLocal(dir: string, keep: number): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.startsWith('zeus-') && f.endsWith('.sql.gz')).sort().reverse();
  for (const stale of files.slice(keep)) {
    await rm(path.join(dir, stale), { force: true });
  }
}

export interface BackupResult {
  id: string;
  filename: string;
  sizeBytes: number;
  localPath: string;
  remoteUrl: string | null;
  uploaded: boolean;
  error?: string;
}

export async function runBackup(opts: { uploadToOneDrive?: boolean } = {}): Promise<BackupResult> {
  const run = await prisma.backupRun.create({ data: { status: 'running' } });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `zeus-${stamp}.sql.gz`;

  try {
    const data = await dump();

    await mkdir(env.BACKUP_DIR, { recursive: true });
    const localPath = path.join(env.BACKUP_DIR, filename);
    await writeFile(localPath, data);
    await pruneLocal(env.BACKUP_DIR, Number(await getSetting<number>('backup.retainLocal', 7)));

    let remoteUrl: string | null = null;
    let uploadError: string | undefined;

    if (opts.uploadToOneDrive !== false) {
      try {
        const folder = String(await getSetting<string>('backup.folder', 'Zeus CRM Backups')) || 'Zeus CRM Backups';
        remoteUrl = await uploadFile(`${folder}/${filename}`, data, 'application/gzip');
      } catch (err) {
        uploadError = (err as Error).message;
      }
    }

    await prisma.backupRun.update({
      where: { id: run.id },
      data: {
        // Dump succeeded, but an intended OneDrive upload failing is not a full
        // success — a local-only copy dies with the server. 'partial' keeps it out
        // of the "last good backup" health check, which only counts 'success'.
        status: uploadError ? 'partial' : 'success',
        filename,
        sizeBytes: data.byteLength,
        error: uploadError ?? null,
        finishedAt: new Date(),
      },
    });

    if (uploadError) {
      await notify({
        event: 'backup_failed',
        title: 'Backup saved locally but not uploaded',
        body: `${filename} (${(data.byteLength / 1_048_576).toFixed(1)} MB) is on the server, but the OneDrive upload failed: ${uploadError}`,
        severity: 'warn',
        userIds: [],
      });
    }

    return { id: run.id, filename, sizeBytes: data.byteLength, localPath, remoteUrl, uploaded: Boolean(remoteUrl), error: uploadError };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.backupRun.update({ where: { id: run.id }, data: { status: 'failed', error: message, finishedAt: new Date() } });
    logSystem('error', 'backup', message, { filename });
    await notify({
      event: 'backup_failed',
      title: 'Zeus backup failed',
      body: message,
      severity: 'critical',
    });
    throw err;
  }
}

export async function lastBackups(limit = 20) {
  return prisma.backupRun.findMany({ orderBy: { startedAt: 'desc' }, take: limit });
}

export interface RestoreCheck {
  ok: boolean;
  filename: string | null;
  tables: number;
  bytes: number;
  note: string;
}

async function latestBackupFile(): Promise<string | null> {
  const files = (await readdir(env.BACKUP_DIR).catch(() => []))
    .filter((f) => f.startsWith('zeus-') && f.endsWith('.sql.gz')).sort().reverse();
  return files[0] ?? null;
}

/**
 * Cheap integrity check that needs no database and no restore rights: the file must
 * be valid gzip and decompress to something that looks like a pg_dump. This is the
 * "validate only" path available without the privileged restore permission.
 * ponytail: reads the whole dump into memory to count CREATE TABLE; fine at this size.
 */
export async function validateLatestBackup(): Promise<RestoreCheck> {
  const filename = await latestBackupFile();
  if (!filename) return { ok: false, filename: null, tables: 0, bytes: 0, note: 'No local backup to validate.' };

  const gz = await readFile(path.join(env.BACKUP_DIR, filename));
  let sql: Buffer;
  try { sql = gunzipSync(gz); } catch { return { ok: false, filename, tables: 0, bytes: gz.byteLength, note: 'Backup file is not valid gzip.' }; }

  const text = sql.toString('latin1');
  const tables = (text.match(/^CREATE TABLE /gm) ?? []).length;
  const looksLikeDump = tables > 0 || /PostgreSQL database dump/.test(text);
  return {
    ok: sql.byteLength > 0 && looksLikeDump,
    filename, tables, bytes: gz.byteLength,
    note: sql.byteLength === 0 ? 'Backup decompresses to nothing.'
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
 * Prove the latest local backup is genuinely restorable: gunzip it, restore into a
 * throwaway database, count the tables, then drop it. A backup that exists but will
 * not restore is worse than none, because it is trusted.
 * ponytail: restores the whole dump to count tables; fine at this size. For a large
 * DB, a schema-only restore would verify structure far faster.
 */
export async function verifyLatestBackup(): Promise<RestoreCheck> {
  const files = (await readdir(env.BACKUP_DIR).catch(() => []))
    .filter((f) => f.startsWith('zeus-') && f.endsWith('.sql.gz')).sort().reverse();
  if (files.length === 0) return { ok: false, filename: null, tables: 0, bytes: 0, note: 'No local backup to verify.' };

  const filename = files[0];
  const gz = await readFile(path.join(env.BACKUP_DIR, filename));
  let sql: Buffer;
  try { sql = gunzipSync(gz); } catch { return { ok: false, filename, tables: 0, bytes: gz.byteLength, note: 'Backup file is not valid gzip.' }; }

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

export async function localBackupSize(): Promise<{ count: number; bytes: number }> {
  try {
    const files = (await readdir(env.BACKUP_DIR)).filter((f) => f.endsWith('.sql.gz'));
    let bytes = 0;
    for (const f of files) bytes += (await stat(path.join(env.BACKUP_DIR, f))).size;
    return { count: files.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}
