import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * The partner register.
 *
 * The rule worth pinning hardest is which clock moves. `lastActivityAt` rolls forward on
 * anything under an account — a quote, a payment, a task booked for next month — which is
 * right for a stale customer and wrong for "when did we last speak to this partner". The
 * design originally said to reuse it; that would have made every partner look freshly
 * contacted the moment someone booked the follow-up the visit itself created.
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

async function makePartner(over: Record<string, unknown> = {}) {
  return prisma.account.create({
    data: { name: 'Partner Co', type: 'PARTNER', ownerId: fx.rep.id, channelManagerId: fx.rep.id, ...over },
  });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

describe('partner register', () => {
  it('lists partners, never-contacted first, then longest overdue', async () => {
    await makePartner({ name: 'Never touched' });
    await makePartner({ name: 'Badly overdue', lastContactAt: daysAgo(90) });
    await makePartner({ name: 'Slightly overdue', lastContactAt: daysAgo(40) });
    await makePartner({ name: 'In hand', lastContactAt: daysAgo(2) });

    const res = await request(app, fx.admin).get('/api/partners');
    assert.equal(res.status, 200);
    const body = res.body as { rows: Array<{ name: string; overdueDays: number | null }>; overdue: number };
    assert.deepEqual(body.rows.map((r) => r.name), ['Never touched', 'Badly overdue', 'Slightly overdue', 'In hand']);
    assert.equal(body.overdue, 3, 'never contacted counts as overdue — it is exactly who has been missed');
  });

  it('a customer is not a partner, however overdue it looks', async () => {
    const res = await request(app, fx.admin).get('/api/partners');
    const names = (res.body as { rows: Array<{ name: string }> }).rows.map((r) => r.name);
    assert.ok(!names.includes(fx.customer.name));
  });

  it('a partner with its own rhythm is judged against that, not the house one', async () => {
    // 10 days since contact: overdue on a weekly rhythm, fine on the 30-day house default.
    await makePartner({ name: 'Weekly', lastContactAt: daysAgo(10), engagementCadenceDays: 7 });
    await makePartner({ name: 'House', lastContactAt: daysAgo(10) });

    const rows = (await request(app, fx.admin).get('/api/partners')).body as {
      rows: Array<{ name: string; cadenceDays: number; cadenceIsOwn: boolean; overdueDays: number | null }>;
    };
    const weekly = rows.rows.find((r) => r.name === 'Weekly')!;
    const house = rows.rows.find((r) => r.name === 'House')!;
    assert.equal(weekly.cadenceDays, 7);
    assert.equal(weekly.cadenceIsOwn, true);
    assert.ok((weekly.overdueDays ?? 0) > 0, 'ten days is overdue on a weekly rhythm');
    assert.equal(house.cadenceDays, 30);
    assert.equal(house.overdueDays, 0, 'ten days is well inside a monthly rhythm');
  });

  it('a dormant partner keeps its history and leaves the list', async () => {
    await makePartner({ name: 'Gone quiet', isDormant: true, lastContactAt: daysAgo(400) });
    const shown = (await request(app, fx.admin).get('/api/partners')).body as { rows: unknown[] };
    assert.equal(shown.rows.length, 0);

    const all = (await request(app, fx.admin).get('/api/partners?includeDormant=true')).body as { rows: unknown[] };
    assert.equal(all.rows.length, 1, 'dormant is out of the way, not deleted');
  });

  it('counts partners nobody manages', async () => {
    await makePartner({ name: 'Unmanaged', channelManagerId: null });
    await makePartner({ name: 'Managed' });
    const body = (await request(app, fx.admin).get('/api/partners')).body as { unmanaged: number };
    assert.equal(body.unmanaged, 1);
  });
});

describe('the contact clock', () => {
  it('a logged visit sets it, and the follow-up task it books does not move it again', async () => {
    const partner = await makePartner({ name: 'Visited' });

    const res = await request(app, fx.rep).post(`/api/partners/${partner.id}/log`, {
      type: 'VISIT',
      subject: 'Quarterly catch-up',
      followUpAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    assert.equal(res.status, 201);

    const after = await prisma.account.findUniqueOrThrow({ where: { id: partner.id } });
    assert.ok(after.lastContactAt, 'the visit is contact');
    const atVisit = after.lastContactAt!.getTime();

    /**
     * The whole reason this clock is separate. Booking next month's follow-up is a TASK,
     * and `lastActivityAt` moves for it — so a register built on that field would call a
     * partner freshly contacted because someone scheduled a reminder to contact them.
     */
    assert.ok(after.lastActivityAt!.getTime() >= atVisit);
    const task = await prisma.activity.findFirst({ where: { accountId: partner.id, type: 'TASK' } });
    assert.ok(task, 'the follow-up was booked');
    assert.equal(after.lastContactAt!.getTime(), atVisit, 'the task did not count as contact');
  });

  it('the follow-up belongs to the channel manager, not whoever typed it', async () => {
    const partner = await makePartner({ name: 'Covered', channelManagerId: fx.manager.id });
    await request(app, fx.admin).post(`/api/partners/${partner.id}/log`, {
      type: 'VISIT', subject: 'Covered while they were away',
      followUpAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    const task = await prisma.activity.findFirstOrThrow({ where: { accountId: partner.id, type: 'TASK' } });
    assert.equal(task.ownerId, fx.manager.id);
  });

  it('a note is written down but is not contact', async () => {
    const partner = await makePartner({ name: 'Noted' });
    await request(app, fx.rep).post(`/api/partners/${partner.id}/log`, { type: 'NOTE', subject: 'Heard they hired' });
    const after = await prisma.account.findUniqueOrThrow({ where: { id: partner.id } });
    assert.equal(after.lastContactAt, null, 'hearing something second-hand is not speaking to them');
  });

  it('a partner request stays open, because it is waiting on us', async () => {
    const partner = await makePartner({ name: 'Asking' });
    const res = await request(app, fx.rep).post(`/api/partners/${partner.id}/log`, {
      type: 'REQUEST', subject: 'Price for 200 endpoints',
    });
    assert.equal(res.status, 201);
    const logged = await prisma.activity.findFirstOrThrow({ where: { accountId: partner.id, type: 'REQUEST' } });
    assert.equal(logged.status, 'Open');
    assert.equal(logged.completedAt, null);
  });

  it('never walks backwards when an old visit is written up late', async () => {
    const partner = await makePartner({ name: 'Backdated', lastContactAt: daysAgo(1) });
    await request(app, fx.rep).post(`/api/partners/${partner.id}/log`, {
      type: 'CALL', subject: 'Forgot to log this one', occurredAt: daysAgo(30).toISOString(),
    });
    const after = await prisma.account.findUniqueOrThrow({ where: { id: partner.id } });
    const days = Math.round((Date.now() - after.lastContactAt!.getTime()) / 86_400_000);
    assert.equal(days, 1, 'the older call must not make them look more neglected than they are');
  });

  it('ticking a scheduled visit off marks it as contact', async () => {
    const partner = await makePartner({ name: 'Planned' });
    const created = await request(app, fx.rep).post('/api/activities', {
      type: 'VISIT', subject: 'Site visit', accountId: partner.id,
      dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    assert.equal(created.status, 201);
    assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: partner.id } })).lastContactAt, null);

    await request(app, fx.rep).patch(`/api/activities/${(created.body as { id: string }).id}`, { status: 'Completed' });
    assert.ok((await prisma.account.findUniqueOrThrow({ where: { id: partner.id } })).lastContactAt);
  });
});

describe('partner permissions', () => {
  it('a rep sees the partners they manage, not the whole roster', async () => {
    await makePartner({ name: 'Mine', channelManagerId: fx.rep.id });
    await makePartner({ name: 'Somebody else\'s', channelManagerId: fx.otherRep.id });

    const names = ((await request(app, fx.rep).get('/api/partners')).body as { rows: Array<{ name: string }> })
      .rows.map((r) => r.name);
    assert.ok(names.includes('Mine'));
    assert.ok(!names.includes('Somebody else\'s'), 'partners scope on the channel manager, not the account owner');
  });

  it('an administrator sees every partner, so the check above proves something', async () => {
    await makePartner({ name: 'Somebody else\'s', channelManagerId: fx.otherRep.id });
    const names = ((await request(app, fx.admin).get('/api/partners')).body as { rows: Array<{ name: string }> })
      .rows.map((r) => r.name);
    assert.ok(names.includes('Somebody else\'s'));
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(app).get('/api/partners');
    assert.equal(res.status, 401);
  });
});
