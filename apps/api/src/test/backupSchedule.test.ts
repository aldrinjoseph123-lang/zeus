import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';
import { applyBackupSchedule, backupScheduleCount } from '../jobs/scheduler.js';

/**
 * Switching backups on must schedule them there and then.
 *
 * This is a regression test for a silent production failure: the schedule was read once
 * at boot, so an install that started with backups off never ran one, however many times
 * the toggle was flipped afterwards. The toggle stuck, "Back up now" worked, and the only
 * hint anything was wrong was the overdue alert days later.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await setSetting('backup.enabled', false, 'backup'); await applyBackupSchedule(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

/** physical + logical + config + the weekly verification. */
const FULL_SCHEDULE = 4;

describe('backup schedule', () => {
  it('schedules nothing while backups are off', async () => {
    await setSetting('backup.enabled', false, 'backup');
    invalidateSettings();
    await applyBackupSchedule();
    assert.equal(backupScheduleCount(), 0);
  });

  it('schedules all three kinds and the weekly check once switched on', async () => {
    await setSetting('backup.enabled', true, 'backup');
    invalidateSettings();
    await applyBackupSchedule();
    assert.equal(backupScheduleCount(), FULL_SCHEDULE);
  });

  it('tears the old jobs down rather than stacking them up', async () => {
    await setSetting('backup.enabled', true, 'backup');
    invalidateSettings();
    await applyBackupSchedule();
    await applyBackupSchedule();
    await applyBackupSchedule();
    assert.equal(backupScheduleCount(), FULL_SCHEDULE, 'three calls, one schedule');
  });

  it('refuses a nonsense cron without taking the other kinds down with it', async () => {
    await setSetting('backup.enabled', true, 'backup');
    await setSetting('backup.cron', 'not a cron expression', 'backup');
    invalidateSettings();
    await applyBackupSchedule();
    assert.equal(backupScheduleCount(), FULL_SCHEDULE - 1, 'physical is dropped; logical, config and the verification stand');
    await setSetting('backup.cron', '0 2 * * *', 'backup');
    invalidateSettings();
  });

  it('saving the setting through the API is what schedules it — no restart needed', async () => {
    await setSetting('backup.enabled', false, 'backup');
    invalidateSettings();
    await applyBackupSchedule();
    assert.equal(backupScheduleCount(), 0, 'starting from off, as a fresh install does');

    const res = await request(app, fx.admin).put('/api/settings', { 'backup.enabled': true });
    assert.equal(res.status, 200);
    assert.equal(backupScheduleCount(), FULL_SCHEDULE, 'the toggle alone did it');

    await request(app, fx.admin).put('/api/settings', { 'backup.enabled': false });
    assert.equal(backupScheduleCount(), 0, 'and switching it off stops them');
  });

  it('a change to an unrelated setting leaves the schedule alone', async () => {
    await request(app, fx.admin).put('/api/settings', { 'backup.enabled': true });
    assert.equal(backupScheduleCount(), FULL_SCHEDULE);
    await request(app, fx.admin).put('/api/settings', { 'company.name': 'Protect24x7' });
    assert.equal(backupScheduleCount(), FULL_SCHEDULE, 'still there, not rebuilt for nothing');
  });
});

describe('the heartbeat covers every integration', () => {
  it('names each one, and calls an unconfigured integration healthy rather than down', async () => {
    const { componentStatuses } = await import('../services/systemStatus.js');
    const keys = (await componentStatuses()).map((c) => c.key);
    for (const expected of ['database', 'microsoft365', 'email', 'whatsapp', 'teams', 'turnstile', 'webhooks', 'backups', 'jobs']) {
      assert.ok(keys.includes(expected), `${expected} is missing from the heartbeat`);
    }

    // Nothing is configured in the suite, so nothing may claim to be broken — an
    // integration nobody has set up is not an outage.
    const unconfigured = (await componentStatuses()).filter((c) => ['microsoft365', 'email', 'whatsapp', 'teams', 'turnstile', 'webhooks'].includes(c.key));
    assert.ok(unconfigured.every((c) => c.ok), unconfigured.filter((c) => !c.ok).map((c) => `${c.key}: ${c.detail}`).join('; '));
  });

  it('says so when backups are on but nothing is registered — the silent failure, made loud', async () => {
    const { componentStatuses } = await import('../services/systemStatus.js');
    await setSetting('backup.enabled', true, 'backup');
    invalidateSettings();
    await applyBackupSchedule();
    assert.equal((await componentStatuses()).find((c) => c.key === 'jobs')?.ok, true, 'registered, so healthy');

    // Exactly what production did: the setting says yes, the scheduler holds nothing.
    const { stopBackupSchedule } = await import('../jobs/scheduler.js');
    stopBackupSchedule();
    const jobs = (await componentStatuses()).find((c) => c.key === 'jobs');
    assert.equal(jobs?.ok, false);
    assert.match(String(jobs?.detail), /no backup job is registered/);
  });
});
