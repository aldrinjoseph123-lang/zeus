import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point backups at a throwaway dir before anything reads env, so this test never
// writes into (or prunes) the real backup directory.
process.env.BACKUP_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-bkp-'));

const { migrateTestDatabase, prisma, resetDatabase } = await import('./harness.js');
const { runBackup } = await import('../services/backup.js');

/**
 * A dump that saved locally but failed to upload offsite is not a full success — a
 * local-only copy dies with the server. It must be recorded 'partial' so the status
 * page (which counts only 'success') does not report healthy backups it does not have.
 */

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); });

describe('backup run status', () => {
  it('marks a run partial when the offsite upload fails', async () => {
    // No Microsoft 365 configured in the test DB → the OneDrive upload throws.
    const r = await runBackup({ uploadToOneDrive: true });
    const row = await prisma.backupRun.findUnique({ where: { id: r.id } });
    assert.equal(row?.status, 'partial', 'upload failure must not be recorded as success');
    assert.ok(row?.error, 'the upload error is kept on the row');
    assert.equal(r.uploaded, false);
  });

  it('marks a local-only run success', async () => {
    const r = await runBackup({ uploadToOneDrive: false });
    const row = await prisma.backupRun.findUnique({ where: { id: r.id } });
    assert.equal(row?.status, 'success');
    assert.equal(row?.error, null);
  });
});
