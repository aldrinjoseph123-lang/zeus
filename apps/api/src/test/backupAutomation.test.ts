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
const { runScheduledBackup, checkMissedBackups } = await import('../services/backup.js');

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => {
  await resetDatabase();
  invalidateSettings();
  await setSetting('backup.encrypted', false);
  invalidateSettings();
});

// Gulf time is UTC+4, no DST — build a UTC instant that lands on a given Gulf hour,
// the same trick notificationDigest.test.ts uses for isQuietHours.
const gulfHour = (h: number) => new Date(Date.UTC(2026, 5, 15, (h - 4 + 24) % 24, 0, 0));
const INSIDE_DEFAULT_WINDOW = gulfHour(2); // default window is 01:00-05:00 Gulf
const OUTSIDE_DEFAULT_WINDOW = gulfHour(12);

describe('overlap guard', () => {
  it('skips any kind while another backup is already running', async () => {
    await prisma.backupRun.create({ data: { status: 'running', kind: 'physical', tier: 'daily' } });
    const result = await runScheduledBackup('physical', INSIDE_DEFAULT_WINDOW);
    assert.ok('skipped' in result);
    assert.match((result as { skipped: string }).skipped, /already running/);
  });
});

describe('maintenance window', () => {
  it('skips a logical run scheduled outside the window', async () => {
    const result = await runScheduledBackup('logical', OUTSIDE_DEFAULT_WINDOW);
    assert.ok('skipped' in result);
    assert.match((result as { skipped: string }).skipped, /maintenance window/);
  });

  it('runs a config backup scheduled inside the window', async () => {
    const result = await runScheduledBackup('config', INSIDE_DEFAULT_WINDOW);
    assert.ok(!('skipped' in result), 'first run has no prior counts to compare against, so it must actually run');
  });

  it('does not gate physical — it keeps its own admin-set cron', async () => {
    const result = await runScheduledBackup('physical', OUTSIDE_DEFAULT_WINDOW);
    assert.ok(!('skipped' in result));
  });
});

describe('skip-if-unchanged', () => {
  it('skips a second config run when nothing changed since the first', async () => {
    const first = await runScheduledBackup('config', INSIDE_DEFAULT_WINDOW);
    assert.ok(!('skipped' in first));

    const second = await runScheduledBackup('config', INSIDE_DEFAULT_WINDOW);
    assert.ok('skipped' in second);
    assert.match((second as { skipped: string }).skipped, /no changes/i);
  });

  it('runs again once a row count changed', async () => {
    await runScheduledBackup('config', INSIDE_DEFAULT_WINDOW);
    await prisma.role.create({ data: { name: 'New Role', permissions: {} } });

    const result = await runScheduledBackup('config', INSIDE_DEFAULT_WINDOW);
    assert.ok(!('skipped' in result));
  });
});

describe('missed-run alert', () => {
  async function adminWithRule() {
    const role = await prisma.role.create({ data: { name: 'Administrator', permissions: {} } });
    const admin = await prisma.user.create({
      data: { email: `admin-${Date.now()}@test.local`, name: 'Admin', passwordHash: 'x', roleId: role.id, teamId: null },
    });
    await prisma.notificationRule.create({
      data: { event: 'backup_missed', label: 'Backup overdue', audience: 'admins', inApp: true, email: false, enabled: true },
    });
    return admin;
  }

  it('alerts admins when a kind has no run at all', async () => {
    await setSetting('backup.enabled', true);
    invalidateSettings();
    const admin = await adminWithRule();

    await checkMissedBackups();

    const rows = await prisma.notification.findMany({ where: { userId: admin.id, type: 'backup_missed' } });
    assert.equal(rows.length, 3, 'physical, logical, and config all have no run at all');
  });

  it('does not alert a kind with a recent success or a legitimate skip', async () => {
    await setSetting('backup.enabled', true);
    invalidateSettings();
    const admin = await adminWithRule();
    await prisma.backupRun.create({ data: { status: 'success', kind: 'physical', tier: 'daily', finishedAt: new Date() } });
    await prisma.backupRun.create({ data: { status: 'skipped', kind: 'logical', tier: 'daily', finishedAt: new Date() } });
    await prisma.backupRun.create({ data: { status: 'success', kind: 'config', tier: 'weekly', finishedAt: new Date() } });

    await checkMissedBackups();

    const rows = await prisma.notification.findMany({ where: { userId: admin.id, type: 'backup_missed' } });
    assert.equal(rows.length, 0);
  });

  it('stays quiet while backups are disabled', async () => {
    await setSetting('backup.enabled', false);
    invalidateSettings();
    const admin = await adminWithRule();

    await checkMissedBackups();

    const rows = await prisma.notification.findMany({ where: { userId: admin.id, type: 'backup_missed' } });
    assert.equal(rows.length, 0);
  });
});
