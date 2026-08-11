import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrateTestDatabase, prisma, resetDatabase } from './harness.js';
import { checkHealthAndAlert } from '../services/healthMonitor.js';
import { uptimeSummary } from '../services/systemStatus.js';

/**
 * The monitor should alert on the *edge* — a component flipping up→down, and back —
 * not on every poll while it stays down. The Backups component is the easiest to
 * drive: a fresh successful BackupRun makes it healthy, removing it makes it stale.
 */

before(() => { migrateTestDatabase(); });
after(async () => { await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); });

async function waitFor<T>(fn: () => Promise<T | null>, ms = 3000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((s) => setTimeout(s, 50));
  }
  return null;
}

describe('health monitor', () => {
  it('logs an alert on an up→down→up flip, once per edge', async () => {
    // Baseline: a fresh backup makes every component healthy; the first pass alerts nothing.
    await prisma.backupRun.create({ data: { status: 'success', startedAt: new Date(), filename: 'z.sql.gz' } });
    await checkHealthAndAlert();
    assert.equal(await prisma.systemLog.count(), 0, 'baseline must not alert');

    // Knock Backups down.
    await prisma.backupRun.deleteMany({});
    await checkHealthAndAlert();
    const down = await waitFor(() => prisma.systemLog.findFirst({ where: { level: 'error', source: 'app', message: { contains: 'Backups' } } }));
    assert.ok(down, 'a down transition should log an error');

    // Staying down must not re-alert.
    const beforeSecond = await prisma.systemLog.count({ where: { level: 'error' } });
    await checkHealthAndAlert();
    await new Promise((s) => setTimeout(s, 150));
    assert.equal(await prisma.systemLog.count({ where: { level: 'error' } }), beforeSecond, 'no repeat alert while it stays down');

    // Recover.
    await prisma.backupRun.create({ data: { status: 'success', startedAt: new Date(), filename: 'z2.sql.gz' } });
    await checkHealthAndAlert();
    const up = await waitFor(() => prisma.systemLog.findFirst({ where: { level: 'info', source: 'app', message: { contains: 'recovered' } } }));
    assert.ok(up, 'a recovery should log an info entry');
  });

  it('computes day and week uptime percentages from samples', async () => {
    const now = Date.now();
    await prisma.componentCheck.createMany({
      data: [
        { component: 'database', ok: true, at: new Date(now - 1_000) },
        { component: 'database', ok: true, at: new Date(now - 2_000) },
        { component: 'database', ok: false, at: new Date(now - 3_000) }, // within 24h: 2 of 3 ok
        { component: 'database', ok: true, at: new Date(now - 3 * 86_400_000) }, // older than a day, within the week
      ],
    });
    const s = await uptimeSummary();
    assert.equal(s.database.day, 66.7, 'last 24h: 2/3 healthy');
    assert.equal(s.database.week, 75, 'last 7d: 3/4 healthy');
  });
});
