import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db.js';
import { env } from '../env.js';
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
        status: uploadError ? 'success' : 'success',
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
