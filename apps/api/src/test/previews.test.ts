import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';

/**
 * Hover previews. The card is a second way to read a record, so it must refuse exactly what
 * opening the record refuses and hide exactly what the record hides. In the fixtures `rep`
 * and `manager` share a team; `otherRep` is on no team.
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

let seq = 0;
const deal = (owner: TestUser, amount = 1000, status: 'OPEN' | 'WON' = 'OPEN') => {
  seq += 1;
  return prisma.deal.create({
    data: {
      reference: `ZEU-D-PREV${seq}`, name: `Preview deal ${seq}`, accountId: fx.customer.id, status,
      pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[1].id, amount, probability: 50,
      ownerId: owner.id, closeDate: new Date(Date.now() + 30 * 86_400_000),
    },
  });
};
const preview = (user: TestUser | null, type: string, id: string) =>
  user ? request(app, user).get(`/api/previews/${type}/${id}`) : app.inject({ method: 'GET', url: `/api/previews/${type}/${id}` }).then((r) => ({ status: r.statusCode, body: r.json() }));

describe('record previews', () => {
  it('shows each kind of record in a few fields', async () => {
    const d = await deal(fx.rep, 42_000);
    const contact = await prisma.contact.create({ data: { firstName: 'Fatima', lastName: 'Al Hashimi', jobTitle: 'CISO', email: 'fatima@testcustomer.ae', accountId: fx.customer.id, ownerId: fx.rep.id } });
    const lead = await prisma.lead.create({ data: { firstName: 'Anil', lastName: 'Gupta', company: 'StorTech', status: 'WORKING', rating: 'Hot', ownerId: fx.rep.id } });

    const account = (await preview(fx.admin, 'account', fx.customer.id)).body as Record<string, unknown>;
    assert.equal(account.name, 'Test Customer LLC');
    assert.deepEqual([account.openDeals, account.openValue], [1, 42_000]);

    const dealCard = (await preview(fx.admin, 'deal', d.id)).body as { name: string; amount: number; stage: { name: string }; account: { name: string }; owner: { name: string } };
    assert.deepEqual([dealCard.amount, dealCard.stage.name, dealCard.account.name, dealCard.owner.name], [42_000, 'Proposal', 'Test Customer LLC', 'rep']);

    const contactCard = (await preview(fx.admin, 'contact', contact.id)).body as { jobTitle: string; account: { name: string } };
    assert.deepEqual([contactCard.jobTitle, contactCard.account.name], ['CISO', 'Test Customer LLC']);

    const leadCard = (await preview(fx.admin, 'lead', lead.id)).body as { company: string; rating: string };
    assert.deepEqual([leadCard.company, leadCard.rating], ['StorTech', 'Hot']);
  });

  it('refuses what opening the record refuses', async () => {
    const theirs = await deal(fx.otherRep);
    const teammates = await deal(fx.manager);
    assert.equal((await preview(fx.rep, 'deal', teammates.id)).status, 200, 'team scope reaches a teammate');
    assert.equal((await preview(fx.rep, 'deal', theirs.id)).status, 403);
    assert.equal((await request(app, fx.rep).get(`/api/deals/${theirs.id}`)).status, 403, 'and the record itself agrees');
    assert.equal((await preview(null, 'deal', teammates.id)).status, 401);
    assert.equal((await preview(fx.admin, 'invoice', teammates.id)).status, 404);
    await prisma.deal.update({ where: { id: teammates.id }, data: { deletedAt: new Date() } });
    assert.equal((await preview(fx.admin, 'deal', teammates.id)).status, 404);
  });

  it('counts only the open deals the reader could open on an account', async () => {
    await deal(fx.rep, 10_000);
    await deal(fx.otherRep, 900_000);
    await deal(fx.rep, 5_000, 'WON');
    const card = (await preview(fx.rep, 'account', fx.customer.id)).body as { openDeals: number; openValue: number };
    assert.deepEqual([card.openDeals, card.openValue], [1, 10_000]);
  });

  it('hides a field the reader\'s role hides', async () => {
    const role = await prisma.role.create({
      data: {
        name: 'No Values',
        permissions: {
          deals: { read: 'all', create: false, update: 'none', delete: 'none', export: false, fields: { amount: 'hidden' } },
          contacts: { read: 'all', create: false, update: 'none', delete: 'none', export: false, fields: { email: 'hidden' } },
        } as never,
      },
    });
    const user = await prisma.user.create({ data: { email: 'novalues@test.local', name: 'novalues', passwordHash: 'x', roleId: role.id } });
    const { SESSION_COOKIE, signSessionToken } = await import('../auth/session.js');
    const reader = { id: user.id, email: user.email, name: user.name, roleName: 'No Values', cookie: `${SESSION_COOKIE}=${await signSessionToken(user.id, 12)}` };

    const d = await deal(fx.rep, 77_000);
    const contact = await prisma.contact.create({ data: { firstName: 'Sara', lastName: 'Khan', email: 'sara@testcustomer.ae', accountId: fx.customer.id } });
    const dealCard = (await preview(reader, 'deal', d.id)).body as Record<string, unknown>;
    assert.equal(dealCard.name, d.name);
    assert.ok(!('amount' in dealCard) || dealCard.amount === null, 'a hidden deal value stays hidden on hover');
    const contactCard = (await preview(reader, 'contact', contact.id)).body as Record<string, unknown>;
    assert.ok(!('email' in contactCard) || contactCard.email === null, 'a hidden email stays hidden on hover');
    assert.equal((await preview(reader, 'lead', d.id)).status, 403, 'a module the role cannot read at all');
  });
});

describe('previews in the audit trail', () => {
  const previews = async (entityId: string) => {
    // The entry is written after the response; give it a moment.
    for (let i = 0; i < 20; i++) {
      const n = await prisma.auditLog.count({ where: { action: 'preview', entityId } });
      if (n) return n;
      await new Promise((r) => setTimeout(r, 50));
    }
    return 0;
  };

  it('with read logging on, a preview is logged once an hour per person and record', async () => {
    await setSetting('audit.logReads', true);
    invalidateSettings();
    const d = await deal(fx.rep);
    await preview(fx.rep, 'deal', d.id);
    assert.equal(await previews(d.id), 1);
    await preview(fx.rep, 'deal', d.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await prisma.auditLog.count({ where: { action: 'preview', entityId: d.id } }), 1, 'the second look inside the hour is not another row');
    await preview(fx.manager, 'deal', d.id);
    await new Promise((r) => setTimeout(r, 300));
    const rows = await prisma.auditLog.findMany({ where: { action: 'preview', entityId: d.id }, select: { userId: true, entity: true, summary: true } });
    assert.deepEqual(rows.map((r) => r.userId).sort(), [fx.manager.id, fx.rep.id].sort(), 'another person is another row');
    assert.deepEqual([rows[0].entity, rows[0].summary], ['Deal', d.reference]);
  });

  it('with read logging off, nothing is written', async () => {
    await setSetting('audit.logReads', false);
    invalidateSettings();
    const d = await deal(fx.rep);
    await preview(fx.rep, 'deal', d.id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await prisma.auditLog.count({ where: { action: 'preview', entityId: d.id } }), 0);
  });
});
