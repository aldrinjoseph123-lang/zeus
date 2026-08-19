import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point backups at a throwaway dir before anything reads env, so this test never
// writes into (or prunes) the real backup directory.
process.env.BACKUP_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-bkp-'));

const { migrateTestDatabase, prisma, resetDatabase } = await import('./harness.js');
const { setSetting, invalidateSettings } = await import('../lib/settings.js');
const { runBackup, checkBackupParity, weeklyAutoVerify } = await import('../services/backup.js');
const { restoreModules, needsElevatedPermission } = await import('../services/restore.js');

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await resetDatabase();
  invalidateSettings();
  await setSetting('backup.encrypted', false);
  invalidateSettings();
});

describe('needsElevatedPermission', () => {
  it('flags invoice and purchaseOrder, nothing else', () => {
    assert.equal(needsElevatedPermission(['account', 'contact']), false);
    assert.equal(needsElevatedPermission(['account', 'invoice']), true);
    assert.equal(needsElevatedPermission(['purchaseOrder']), true);
  });
});

describe('restoreModules', () => {
  it('rejects a physical backup — restore is module-scoped, not whole-database', async () => {
    const physical = await runBackup({ kind: 'physical', uploadToOneDrive: false });
    await assert.rejects(() => restoreModules(physical.id, ['account'], false), /whole database/);
  });

  it('rejects when no requested module is valid for the kind', async () => {
    const backup = await runBackup({ kind: 'logical', uploadToOneDrive: false });
    await assert.rejects(() => restoreModules(backup.id, ['notARealModel'], false), /No valid module/);
  });

  it('previews without touching the database', async () => {
    const account = await prisma.account.create({ data: { name: 'Restore Preview Co' } });
    const backup = await runBackup({ kind: 'logical', uploadToOneDrive: false });
    await prisma.account.delete({ where: { id: account.id } });

    const preview = await restoreModules(backup.id, ['account'], false);
    assert.equal(preview.applied, false);
    const plan = preview.plans.find((p) => p.model === 'account');
    assert.equal(plan?.toCreate, 1, 'the deleted account would be re-created');

    assert.equal(await prisma.account.count(), 0, 'a preview must not write anything');
  });

  it('restores a deleted record, takes a safety backup first, and reports created vs updated', async () => {
    const account = await prisma.account.create({ data: { name: 'Restore Apply Co' } });
    const backup = await runBackup({ kind: 'logical', uploadToOneDrive: false });
    await prisma.account.delete({ where: { id: account.id } });

    const runsBefore = await prisma.backupRun.count({ where: { kind: 'logical' } });
    const result = await restoreModules(backup.id, ['account'], true);

    assert.equal(result.applied, true);
    assert.equal(result.created, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.failed?.length, 0);
    assert.ok(result.safetyBackupId, 'a safety backup was taken before applying');

    const runsAfter = await prisma.backupRun.count({ where: { kind: 'logical' } });
    assert.equal(runsAfter, runsBefore + 1, 'exactly one extra backup run — the safety copy');

    const restored = await prisma.account.findUnique({ where: { id: account.id } });
    assert.equal(restored?.name, 'Restore Apply Co');
  });

  it('applies multiple modules in dependency order regardless of the order requested', async () => {
    const account = await prisma.account.create({ data: { name: 'Dep Order Co' } });
    const contact = await prisma.contact.create({ data: { firstName: 'A', lastName: 'B', accountId: account.id } });
    const backup = await runBackup({ kind: 'logical', uploadToOneDrive: false });
    await prisma.contact.delete({ where: { id: contact.id } });
    await prisma.account.delete({ where: { id: account.id } });

    // Requested contact-before-account on purpose — restoreModules must still apply
    // account first, or the contact upsert would fail its accountId foreign key.
    const result = await restoreModules(backup.id, ['contact', 'account'], true);

    assert.equal(result.failed?.length, 0, JSON.stringify(result.failed));
    assert.equal(await prisma.account.count(), 1);
    assert.equal(await prisma.contact.count(), 1);
  });

  it('updates an existing record in place rather than duplicating it', async () => {
    const account = await prisma.account.create({ data: { name: 'Original Name' } });
    const backup = await runBackup({ kind: 'logical', uploadToOneDrive: false });
    await prisma.account.update({ where: { id: account.id }, data: { name: 'Changed Live' } });

    const result = await restoreModules(backup.id, ['account'], true);
    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);

    const row = await prisma.account.findUnique({ where: { id: account.id } });
    assert.equal(row?.name, 'Original Name');
    assert.equal(await prisma.account.count(), 1, 'no duplicate created');
  });
});

describe('checkBackupParity', () => {
  it('matches when the file has not been tampered with', async () => {
    await prisma.role.create({ data: { name: 'Parity Role', permissions: {} } });
    const backup = await runBackup({ kind: 'config', uploadToOneDrive: false });

    const result = await checkBackupParity(backup.id);
    assert.equal(result.ok, true, result.note);
    assert.equal(result.mismatches.length, 0);
  });

  it('flags a mismatch between the recorded count and the file', async () => {
    const backup = await runBackup({ kind: 'config', uploadToOneDrive: false });
    // Simulate corruption/tampering: the row count on record no longer matches
    // what is actually in the file on disk.
    await prisma.backupRun.update({ where: { id: backup.id }, data: { rowCounts: { role: 999 } } });

    const result = await checkBackupParity(backup.id);
    assert.equal(result.ok, false);
    assert.deepEqual(result.mismatches, [{ model: 'role', expected: 999, actual: 0 }]);
  });

  it('refuses a physical backup — that is Validate/Verify\'s job', async () => {
    const backup = await runBackup({ kind: 'physical', uploadToOneDrive: false });
    const result = await checkBackupParity(backup.id);
    assert.equal(result.ok, false);
    assert.match(result.note, /Validate\/Verify/);
  });
});

describe('weeklyAutoVerify', () => {
  async function adminWithRule() {
    const role = await prisma.role.create({ data: { name: 'Administrator', permissions: {} } });
    const admin = await prisma.user.create({
      data: { email: `admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x', roleId: role.id, teamId: null },
    });
    await prisma.notificationRule.create({
      data: { event: 'backup_verify_failed', label: 'Backup verify failed', audience: 'admins', inApp: true, email: false, enabled: true },
    });
    return admin;
  }

  it('stays quiet when the latest backups check out', async () => {
    const admin = await adminWithRule();
    await runBackup({ kind: 'physical', uploadToOneDrive: false });
    await runBackup({ kind: 'logical', uploadToOneDrive: false });

    await weeklyAutoVerify();

    const rows = await prisma.notification.findMany({ where: { userId: admin.id, type: 'backup_verify_failed' } });
    assert.equal(rows.length, 0);
  });

  it('alerts once when a kind fails parity', async () => {
    const admin = await adminWithRule();
    await runBackup({ kind: 'physical', uploadToOneDrive: false });
    const config = await runBackup({ kind: 'config', uploadToOneDrive: false });
    await prisma.backupRun.update({ where: { id: config.id }, data: { rowCounts: { setting: 999 } } });

    await weeklyAutoVerify();

    const rows = await prisma.notification.findMany({ where: { userId: admin.id, type: 'backup_verify_failed' } });
    assert.equal(rows.length, 1);
  });
});
