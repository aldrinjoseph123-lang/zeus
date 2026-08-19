import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, resetDatabase, seedFixtures, type Fixtures } from './harness.js';
import { setSetting, invalidateSettings } from '../lib/settings.js';
import { isQuietHours, notify, sendPendingDigests } from '../services/notify.js';
import { gulfParts } from '../services/scheduledReports.js';

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

async function emailRule(overrides: Partial<{ enabled: boolean; email: boolean }> = {}) {
  return prisma.notificationRule.create({
    data: { event: 'test_event', label: 'Test event', audience: 'owner', inApp: true, email: true, enabled: true, ...overrides },
  });
}

describe('quiet hours', () => {
  it('is off unless the setting is on', async () => {
    assert.equal(await isQuietHours('info'), false);
  });

  it('reports on/off correctly across the boundary, wrapping midnight', async () => {
    await setSetting('notify.quietHoursEnabled', true);
    await setSetting('notify.quietHoursStart', 21);
    await setSetting('notify.quietHoursEnd', 7);
    invalidateSettings();

    // isQuietHours converts `now` to Gulf time (UTC+4, no DST) internally, so build a
    // UTC instant chosen so that Asia/Dubai lands on the hour under test.
    const gulfHour = (h: number) => new Date(Date.UTC(2026, 5, 15, (h - 4 + 24) % 24, 0, 0));

    assert.equal(await isQuietHours(undefined, gulfHour(22)), true, '22:00 is inside 21:00–07:00');
    assert.equal(await isQuietHours(undefined, gulfHour(3)), true, '03:00 is inside 21:00–07:00');
    assert.equal(await isQuietHours(undefined, gulfHour(12)), false, 'noon is outside it');
    assert.equal(await isQuietHours(undefined, gulfHour(7)), false, '07:00 is the end, exclusive');
  });

  it('never holds a critical alert', async () => {
    await setSetting('notify.quietHoursEnabled', true);
    await setSetting('notify.quietHoursStart', 0);
    await setSetting('notify.quietHoursEnd', 23);
    invalidateSettings();
    assert.equal(await isQuietHours('critical'), false);
  });
});

describe('notify() and the digest queue', () => {
  it('sends immediately and stamps emailedAt when quiet hours is off', async () => {
    await emailRule();
    await notify({ event: 'test_event', title: 'Hello', ownerId: fx.rep.id, severity: 'info' });

    const rows = await prisma.notification.findMany({ where: { userId: fx.rep.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wantsEmail, true);
    assert.ok(rows[0].emailedAt, 'sent immediately, not deferred');
  });

  it('defers to the digest queue during quiet hours', async () => {
    const { hour } = gulfParts(new Date());
    await setSetting('notify.quietHoursEnabled', true);
    await setSetting('notify.quietHoursStart', hour);
    await setSetting('notify.quietHoursEnd', (hour + 1) % 24);
    invalidateSettings();
    await emailRule();

    await notify({ event: 'test_event', title: 'Hello at night', ownerId: fx.rep.id, severity: 'info' });

    const rows = await prisma.notification.findMany({ where: { userId: fx.rep.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].wantsEmail, true);
    assert.equal(rows[0].emailedAt, null, 'held for the digest, not sent immediately');
  });

  it('leaves an event with email off entirely out of the digest queue', async () => {
    await emailRule({ email: false });
    await notify({ event: 'test_event', title: 'In-app only', ownerId: fx.rep.id, severity: 'info' });

    const rows = await prisma.notification.findMany({ where: { userId: fx.rep.id } });
    assert.equal(rows[0].wantsEmail, false);
  });

  it('sendPendingDigests never marks a row as emailed unless delivery actually succeeded', async () => {
    // No M365 sender is configured in the test environment, so delivery always
    // fails here — the invariant under test is that a failed attempt leaves the
    // row queryable as still-pending rather than silently swallowing it.
    const { hour } = gulfParts(new Date());
    await setSetting('notify.quietHoursEnabled', true);
    await setSetting('notify.quietHoursStart', hour);
    await setSetting('notify.quietHoursEnd', (hour + 1) % 24);
    invalidateSettings();
    await emailRule();
    await notify({ event: 'test_event', title: 'Held', ownerId: fx.rep.id, severity: 'info' });

    const sent = await sendPendingDigests();
    assert.equal(sent, 0, 'no mailbox configured — nothing actually went out');

    const row = await prisma.notification.findFirst({ where: { userId: fx.rep.id } });
    assert.equal(row?.emailedAt, null, 'stays pending, not falsely marked as sent');
  });

  it('does nothing when the queue is empty', async () => {
    assert.equal(await sendPendingDigests(), 0);
  });
});
