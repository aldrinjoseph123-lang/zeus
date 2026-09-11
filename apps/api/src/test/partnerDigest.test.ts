import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * The weekly digest, and the nudge.
 *
 * Two things decide whether this is useful or filtered. It has to be **silent when nothing
 * is overdue** — a weekly message that always arrives is one people stop opening. And the
 * nudge has to fire **once per crossing**, not every night until somebody acts, which is
 * the difference between an alert and a nag.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function partner(name: string, over: Record<string, unknown> = {}) {
  return prisma.account.create({
    data: { name, type: 'PARTNER', ownerId: fx.rep.id, channelManagerId: fx.rep.id, ...over },
  });
}

const notificationsFor = (userId: string) =>
  prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });

describe('the weekly digest', () => {
  it('says nothing at all when nobody is overdue', async () => {
    await partner('In hand', { lastContactAt: daysAgo(2) });
    const { sendWeeklyPartnerDigest } = await import('../services/partnerDigest.js');

    const result = await sendWeeklyPartnerDigest();
    assert.deepEqual(result, { managers: 0, partners: 0 });
    assert.equal((await notificationsFor(fx.rep.id)).length, 0, 'a digest that always arrives is one people filter');
  });

  it('sends one message per channel manager, naming only their own partners', async () => {
    await partner('Rep\'s partner', { channelManagerId: fx.rep.id, lastContactAt: daysAgo(90) });
    await partner('Manager\'s partner', { channelManagerId: fx.manager.id, lastContactAt: daysAgo(90) });
    const { sendWeeklyPartnerDigest } = await import('../services/partnerDigest.js');

    const result = await sendWeeklyPartnerDigest();
    assert.equal(result.managers, 2);

    const repNotes = await notificationsFor(fx.rep.id);
    assert.equal(repNotes.length, 1);
    assert.match(repNotes[0].body ?? '', /Rep's partner/);
    assert.doesNotMatch(repNotes[0].body ?? '', /Manager's partner/, 'nobody wants a list of somebody else\'s work');
  });

  it('counts never-contacted as overdue, not as fine', async () => {
    await partner('Never touched');
    const { overduePartners } = await import('../services/partnerDigest.js');
    const overdue = await overduePartners();
    assert.equal(overdue.length, 1);
    assert.ok(overdue[0].overdueDays > 0, 'the partner nobody has got to is exactly the one to name');
  });

  it('leaves dormant partners alone, and ones nobody manages', async () => {
    await partner('Gone quiet', { isDormant: true, lastContactAt: daysAgo(400) });
    await partner('Nobody\'s', { channelManagerId: null, lastContactAt: daysAgo(400) });
    const { overduePartners } = await import('../services/partnerDigest.js');

    const overdue = await overduePartners();
    assert.equal(overdue.length, 0, 'dormant is not being chased, and unmanaged has nobody to tell');
  });

  it('respects a partner\'s own rhythm rather than the house one', async () => {
    // Ten days: overdue on a weekly rhythm, comfortable on the 30-day default.
    await partner('Weekly', { engagementCadenceDays: 7, lastContactAt: daysAgo(10) });
    await partner('Monthly', { lastContactAt: daysAgo(10) });
    const { overduePartners } = await import('../services/partnerDigest.js');

    const names = (await overduePartners()).map((p) => p.name);
    assert.deepEqual(names, ['Weekly']);
  });
});

describe('the badly-overdue nudge', () => {
  it('fires for a partner past twice its rhythm, and only once', async () => {
    await partner('Let go', { lastContactAt: daysAgo(70) }); // house rhythm 30, so 40 over
    const { nudgeBadlyOverdue } = await import('../services/partnerDigest.js');

    assert.equal(await nudgeBadlyOverdue(), 1);
    assert.equal((await notificationsFor(fx.rep.id)).length, 1);

    // The state has not changed, so a second run must stay quiet.
    assert.equal(await nudgeBadlyOverdue(), 0, 'an alert that repeats nightly is a nag, not an alert');
    assert.equal((await notificationsFor(fx.rep.id)).length, 1);
  });

  it('leaves a merely overdue partner to the weekly list', async () => {
    await partner('Slipping', { lastContactAt: daysAgo(40) }); // 10 over a 30-day rhythm
    const { nudgeBadlyOverdue } = await import('../services/partnerDigest.js');
    assert.equal(await nudgeBadlyOverdue(), 0);
  });

  it('can fire again after contact, if the partner is neglected a second time', async () => {
    const p = await partner('Twice let go', { lastContactAt: daysAgo(70) });
    const { nudgeBadlyOverdue } = await import('../services/partnerDigest.js');
    assert.equal(await nudgeBadlyOverdue(), 1);

    // Somebody calls them — which is what the nudge was for.
    const logged = await request(app, fx.rep).post(`/api/partners/${p.id}/log`, { type: 'CALL', subject: 'Finally rang them' });
    assert.equal(logged.status, 201);
    assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: p.id } })).nudgedAt, null,
      'contact has to reset it, or the alert fires once in the lifetime of the partner');

    // And then they are neglected again.
    await prisma.account.update({ where: { id: p.id }, data: { lastContactAt: daysAgo(70) } });
    assert.equal(await nudgeBadlyOverdue(), 1);
  });
});

describe('the dashboard counts coverage', () => {
  it('reports partners, overdue and unmanaged', async () => {
    await partner('Fine', { lastContactAt: daysAgo(2) });
    await partner('Overdue', { lastContactAt: daysAgo(90) });
    await partner('Unmanaged', { channelManagerId: null, lastContactAt: daysAgo(2) });
    await partner('Dormant', { isDormant: true, lastContactAt: daysAgo(400) });

    const res = await request(app, fx.admin).get('/api/dashboard/attention');
    assert.equal(res.status, 200);
    const { partners } = res.body as { partners: { total: number; overdue: number; unmanaged: number } };
    assert.equal(partners.total, 3, 'dormant partners are not being chased, so they are not the measure');
    assert.equal(partners.overdue, 1);
    assert.equal(partners.unmanaged, 1);
  });

  /**
   * Deliberately not here: "a role without partners:read gets null". The harness builds
   * its four users from the shipped role presets at the start of every test, so changing
   * a role mid-suite means re-seeding over users that already exist. The gate itself is
   * the same `can()` helper proven in partners.test.ts, which checks a rep sees only the
   * partners they manage and an administrator sees all of them.
   */
});
