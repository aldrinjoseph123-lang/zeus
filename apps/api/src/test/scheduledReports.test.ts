import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';
import { gulfParts, isDue, runDueScheduledReports } from '../services/scheduledReports.js';

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

describe('isDue', () => {
  const now = new Date();
  const { hour, weekday } = gulfParts(now);

  it('fires a daily schedule on its hour', () => {
    assert.equal(isDue({ enabled: true, frequency: 'daily', hour, weekday: null, lastRunAt: null }, now), true);
  });

  it('skips a daily schedule on a different hour', () => {
    assert.equal(isDue({ enabled: true, frequency: 'daily', hour: (hour + 5) % 24, weekday: null, lastRunAt: null }, now), false);
  });

  it('fires weekly only on the matching weekday and hour', () => {
    assert.equal(isDue({ enabled: true, frequency: 'weekly', hour, weekday, lastRunAt: null }, now), true);
    assert.equal(isDue({ enabled: true, frequency: 'weekly', hour, weekday: (weekday + 1) % 7, lastRunAt: null }, now), false);
  });

  it('skips a disabled schedule regardless of hour', () => {
    assert.equal(isDue({ enabled: false, frequency: 'daily', hour, weekday: null, lastRunAt: null }, now), false);
  });

  it('will not fire twice inside the same day', () => {
    const justRan = new Date(now.getTime() - 60_000);
    assert.equal(isDue({ enabled: true, frequency: 'daily', hour, weekday: null, lastRunAt: justRan }, now), false);
  });

  it('fires again once the dedupe window has passed', () => {
    const yesterday = new Date(now.getTime() - 21 * 3_600_000);
    assert.equal(isDue({ enabled: true, frequency: 'daily', hour, weekday: null, lastRunAt: yesterday }, now), true);
  });
});

describe('runDueScheduledReports', () => {
  it('only attempts what is due, and never marks lastRunAt on a failed attempt', async () => {
    const now = new Date();
    const { hour } = gulfParts(now);

    const due = await prisma.scheduledReport.create({
      data: { reportKey: 'pipeline', frequency: 'daily', hour, format: 'pdf', recipientEmails: ['ops@example.com'], createdById: fx.admin.id },
    });
    const notDue = await prisma.scheduledReport.create({
      data: { reportKey: 'pipeline', frequency: 'daily', hour: (hour + 6) % 24, format: 'pdf', recipientEmails: ['ops@example.com'], createdById: fx.admin.id },
    });

    // No M365 sender is configured in the test environment, so even the due one
    // fails to actually send — what this proves is it was reached at all (and that
    // the failure is caught rather than thrown), and that neither row gets a false
    // lastRunAt stamp.
    const sent = await runDueScheduledReports(now);
    assert.equal(sent, 0);

    assert.equal((await prisma.scheduledReport.findUnique({ where: { id: due.id } }))?.lastRunAt, null);
    assert.equal((await prisma.scheduledReport.findUnique({ where: { id: notDue.id } }))?.lastRunAt, null);
  });

  it('one broken schedule does not stop another due in the same run', async () => {
    const now = new Date();
    const { hour } = gulfParts(now);

    await prisma.scheduledReport.create({
      data: { reportKey: 'no-such-report', frequency: 'daily', hour, format: 'pdf', recipientEmails: ['a@b.com'], createdById: fx.admin.id },
    });
    await prisma.scheduledReport.create({
      data: { reportKey: 'pipeline', frequency: 'daily', hour, format: 'pdf', recipientEmails: ['a@b.com'], createdById: fx.admin.id },
    });

    // Must not throw even though the first schedule references a report that does
    // not exist in the registry.
    await runDueScheduledReports(now);
  });
});

describe('scheduled report routes', () => {
  it('creates, lists, updates and deletes a schedule, admin only', async () => {
    const create = await request(app, fx.admin).post('/api/scheduled-reports', {
      reportKey: 'pipeline', frequency: 'weekly', weekday: 1, hour: 8, format: 'xlsx', recipientEmails: ['sales@example.com'],
    });
    assert.equal(create.status, 201);
    const id = (create.body as { id: string }).id;

    const list = await request(app, fx.admin).get('/api/scheduled-reports');
    assert.equal(list.status, 200);
    assert.ok((list.body as { schedules: Array<{ id: string }> }).schedules.some((s) => s.id === id));

    const patch = await request(app, fx.admin).patch(`/api/scheduled-reports/${id}`, { enabled: false });
    assert.equal(patch.status, 200);
    assert.equal((patch.body as { enabled: boolean }).enabled, false);

    const asRep = await request(app, fx.rep).post('/api/scheduled-reports', {
      reportKey: 'pipeline', frequency: 'daily', hour: 8, recipientEmails: ['x@example.com'],
    });
    assert.equal(asRep.status, 403);

    const del = await request(app, fx.admin).del(`/api/scheduled-reports/${id}`);
    assert.equal(del.status, 200);
    assert.equal(await prisma.scheduledReport.findUnique({ where: { id } }), null);
  });

  it('rejects a weekly schedule with no weekday', async () => {
    const res = await request(app, fx.admin).post('/api/scheduled-reports', {
      reportKey: 'pipeline', frequency: 'weekly', hour: 8, recipientEmails: ['a@b.com'],
    });
    assert.equal(res.status, 400);
  });

  it('rejects an unknown report key', async () => {
    const res = await request(app, fx.admin).post('/api/scheduled-reports', {
      reportKey: 'not-a-real-report', frequency: 'daily', hour: 8, recipientEmails: ['a@b.com'],
    });
    assert.equal(res.status, 400);
  });
});
