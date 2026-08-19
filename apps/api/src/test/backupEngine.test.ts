import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point backups at a throwaway dir before anything reads env, so this test never
// writes into (or prunes) the real backup directory.
process.env.BACKUP_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-bkp-'));
const NAS_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-nas-'));

const { migrateTestDatabase, prisma, resetDatabase } = await import('./harness.js');
const { setSetting, invalidateSettings } = await import('../lib/settings.js');
const { runBackup, tierFor, validateLatestBackup, verifyLatestBackup } = await import('../services/backup.js');
const { decryptBuffer } = await import('../lib/crypto.js');

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await resetDatabase();
  // resetDatabase() truncates the Setting table but does not know about the
  // settings module's in-memory cache — without this, a value another test wrote
  // and invalidated-in would keep reading back as "still set" after the truncate.
  invalidateSettings();
});

describe('tierFor', () => {
  it('is monthly on the 1st, weekly on Sunday, daily otherwise', () => {
    assert.equal(tierFor(new Date(Date.UTC(2026, 0, 1, 10))), 'monthly', '1st of the month wins even if it is also a Sunday');
    // 2026-08-16 is a Sunday, Gulf time (UTC+4) — pick a UTC hour that still lands
    // on Sunday after the +4 shift.
    assert.equal(tierFor(new Date(Date.UTC(2026, 7, 16, 10))), 'weekly');
    assert.equal(tierFor(new Date(Date.UTC(2026, 7, 18, 10))), 'daily');
  });
});

describe('logical and config backups', () => {
  it('exports business tables to NDJSON with a row count per model', async () => {
    await setSetting('backup.encrypted', false);
    invalidateSettings();
    await prisma.account.create({ data: { name: 'Sample Account' } });

    const result = await runBackup({ kind: 'logical', uploadToOneDrive: false });
    const row = await prisma.backupRun.findUnique({ where: { id: result.id } });
    assert.equal(row?.kind, 'logical');
    assert.equal(row?.status, 'success');
    assert.ok(row?.filename?.endsWith('.ndjson.gz'));
    assert.equal(row?.encrypted, false);
    assert.ok(row?.rowCounts && typeof (row.rowCounts as Record<string, number>).account === 'number', 'row counts recorded per model');

    const bytes = readFileSync(path.join(process.env.BACKUP_DIR!, result.filename));
    const text = gunzipSync(bytes).toString('utf8');
    const firstLine = text.split('\n').find(Boolean);
    assert.ok(firstLine, 'at least one NDJSON line');
    const parsed = JSON.parse(firstLine!);
    assert.ok('model' in parsed && 'row' in parsed);
  });

  it('exports app config tables separately from business data', async () => {
    await setSetting('backup.encrypted', false);
    invalidateSettings();

    const result = await runBackup({ kind: 'config', uploadToOneDrive: false });
    const row = await prisma.backupRun.findUnique({ where: { id: result.id } });
    assert.equal(row?.kind, 'config');
    const counts = row?.rowCounts as Record<string, number>;
    assert.ok('role' in counts && 'setting' in counts);
    assert.ok(!('account' in counts), 'business data does not leak into the config export');
  });
});

describe('encryption', () => {
  it('encrypts by default — the file on disk is not raw gzip', async () => {
    await prisma.role.create({ data: { name: 'Sample Role', permissions: {} } });
    const result = await runBackup({ kind: 'config', uploadToOneDrive: false });
    assert.ok(result.encrypted);
    assert.ok(result.filename.endsWith('.enc'));

    const bytes = readFileSync(path.join(process.env.BACKUP_DIR!, result.filename));
    assert.throws(() => gunzipSync(bytes), 'encrypted bytes are not valid gzip on their own');
    const decrypted = decryptBuffer(bytes);
    const text = gunzipSync(decrypted).toString('utf8');
    assert.ok(text.includes('"model"'));
  });

  it('records a checksum of the exact bytes written to disk', async () => {
    const result = await runBackup({ kind: 'config', uploadToOneDrive: false });
    const row = await prisma.backupRun.findUnique({ where: { id: result.id } });
    const bytes = readFileSync(path.join(process.env.BACKUP_DIR!, result.filename));
    assert.equal(row?.checksum, createHash('sha256').update(bytes).digest('hex'));
  });

  it('validate/verify decrypt an encrypted physical backup before checking it', async () => {
    await runBackup({ kind: 'physical', uploadToOneDrive: false }); // encrypted: true by default
    const validated = await validateLatestBackup();
    assert.equal(validated.ok, true, validated.note);

    const verified = await verifyLatestBackup();
    assert.equal(verified.ok, true, verified.note);
    assert.ok(verified.tables > 0);
  });
});

describe('a second destination (NAS)', () => {
  it('writes to the configured path alongside local, and records it', async () => {
    await setSetting('backup.nasPath', NAS_DIR);
    await setSetting('backup.encrypted', false);
    invalidateSettings();

    const result = await runBackup({ kind: 'config', uploadToOneDrive: false });
    assert.deepEqual(result.destinations, ['local', 'nas']);
    assert.doesNotThrow(() => readFileSync(path.join(NAS_DIR, result.filename)));
  });
});

describe('grandfather-father-son retention', () => {
  it('prunes each tier independently instead of one flat count', async () => {
    await setSetting('backup.retainDaily', 2);
    await setSetting('backup.encrypted', false);
    invalidateSettings();

    // Three daily-tier config backups in a row — retention of 2 should prune the
    // first one's file once the third lands.
    const first = await runBackup({ kind: 'config', uploadToOneDrive: false });
    await runBackup({ kind: 'config', uploadToOneDrive: false });
    await runBackup({ kind: 'config', uploadToOneDrive: false });

    assert.throws(() => readFileSync(path.join(process.env.BACKUP_DIR!, first.filename)), 'oldest of three, over a retain-2 limit, is pruned');
  });
});
