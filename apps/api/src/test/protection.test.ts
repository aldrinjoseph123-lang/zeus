import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * Partner protection.
 *
 * A partner that registers an end customer owns it for the protection period. Zeus could
 * describe that and not enforce it, so the conflict was settled by whoever remembered the
 * conversation. The rule chosen is the strictest pair on offer — any vendor, and refuse
 * rather than warn — so these tests care as much about what it must *not* block as what
 * it must: a rule that stops legitimate work is one people route around.
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

async function partner(name: string) {
  return prisma.account.create({ data: { name, type: 'PARTNER', ownerId: fx.admin.id } });
}

/**
 * A deal at the shared end customer — which is what makes two partners collide. Owned by
 * the rep, because a Sales Executive may only update their own deals and these tests are
 * about the protection rule, not about who owns what.
 */
async function dealAt(customerId: string, name: string) {
  return prisma.deal.create({
    data: {
      reference: `ZEU-D-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name, accountId: customerId, pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
      amount: 50_000, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: 50_000,
      probability: 50, ownerId: fx.rep.id, closeDate: new Date(Date.now() + 30 * 86_400_000),
    },
  });
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);

/** Give a partner live protection on a customer: approved, and still in date. */
async function protect(dealId: string, partnerId: string, expiresAt = inDays(60)) {
  return prisma.dealRegistration.create({
    data: { dealId, side: 'PARTNER', partnerId, status: 'APPROVED', submittedAt: new Date(), expiresAt },
  });
}

describe('a live registration holds the customer', () => {
  it('refuses a second partner, and says who holds it and until when', async () => {
    const [alpha, beta] = [await partner('Alpha Distribution'), await partner('Beta Systems')];
    const first = await dealAt(fx.customer.id, 'Alpha\'s opportunity');
    await protect(first.id, alpha.id);

    const second = await dealAt(fx.customer.id, 'Beta\'s opportunity');
    const res = await request(app, fx.rep).post(`/api/deals/${second.id}/registrations`, {
      side: 'PARTNER', partnerId: beta.id, status: 'APPROVED',
    });

    assert.equal(res.status, 409);
    const body = res.body as { error?: string; message?: string };
    const message = body.message ?? body.error ?? '';
    assert.match(message, /Alpha Distribution/, 'the message has to name who holds it');
    assert.match(message, /until/, 'and when it runs out — a date ends the argument');
  });

  it('does not block the partner that already holds it', async () => {
    const alpha = await partner('Alpha Distribution');
    const first = await dealAt(fx.customer.id, 'First');
    await protect(first.id, alpha.id);

    const second = await dealAt(fx.customer.id, 'Second opportunity, same partner');
    const res = await request(app, fx.rep).post(`/api/deals/${second.id}/registrations`, {
      side: 'PARTNER', partnerId: alpha.id, status: 'APPROVED',
    });
    assert.equal(res.status, 201, 'a second opportunity at a customer you own is not a conflict');
  });

  it('does not block a different end customer', async () => {
    const [alpha, beta] = [await partner('Alpha Distribution'), await partner('Beta Systems')];
    const held = await dealAt(fx.customer.id, 'Held');
    await protect(held.id, alpha.id);

    const other = await prisma.account.create({ data: { name: 'Another Customer', type: 'CUSTOMER' } });
    const elsewhere = await dealAt(other.id, 'Somewhere else entirely');
    const res = await request(app, fx.rep).post(`/api/deals/${elsewhere.id}/registrations`, {
      side: 'PARTNER', partnerId: beta.id, status: 'APPROVED',
    });
    assert.equal(res.status, 201);
  });

  it('does not block a vendor-side registration', async () => {
    const alpha = await partner('Alpha Distribution');
    const held = await dealAt(fx.customer.id, 'Held');
    await protect(held.id, alpha.id);

    const ours = await dealAt(fx.customer.id, 'Our own registration with the vendor');
    const res = await request(app, fx.rep).post(`/api/deals/${ours.id}/registrations`, {
      side: 'VENDOR', vendorId: fx.vendor.id, status: 'APPROVED',
    });
    assert.equal(res.status, 201, 'locking our buy price with a vendor is not a partner conflict');
  });
});

describe('only live protection holds', () => {
  it('an expired registration releases the customer', async () => {
    const [alpha, beta] = [await partner('Alpha Distribution'), await partner('Beta Systems')];
    const lapsed = await dealAt(fx.customer.id, 'Lapsed');
    await protect(lapsed.id, alpha.id, new Date(Date.now() - 86_400_000));

    const fresh = await dealAt(fx.customer.id, 'Beta gets a go');
    const res = await request(app, fx.rep).post(`/api/deals/${fresh.id}/registrations`, {
      side: 'PARTNER', partnerId: beta.id, status: 'APPROVED',
    });
    assert.equal(res.status, 201, 'without this, every customer ever registered stays locked forever');
  });

  it('a draft or rejected registration holds nothing', async () => {
    const [alpha, beta] = [await partner('Alpha Distribution'), await partner('Beta Systems')];
    const draft = await dealAt(fx.customer.id, 'Never approved');
    await prisma.dealRegistration.create({
      data: { dealId: draft.id, side: 'PARTNER', partnerId: alpha.id, status: 'DRAFT', expiresAt: inDays(60) },
    });

    const real = await dealAt(fx.customer.id, 'Beta, properly');
    const res = await request(app, fx.rep).post(`/api/deals/${real.id}/registrations`, {
      side: 'PARTNER', partnerId: beta.id, status: 'APPROVED',
    });
    assert.equal(res.status, 201, 'protection is claimed by approval, not by paperwork existing');
  });
});

describe('the override', () => {
  it('a rep cannot force past it', async () => {
    const [alpha, beta] = [await partner('Alpha Distribution'), await partner('Beta Systems')];
    const held = await dealAt(fx.customer.id, 'Held');
    await protect(held.id, alpha.id);

    const attempt = await dealAt(fx.customer.id, 'Beta');
    const res = await request(app, fx.rep).post(`/api/deals/${attempt.id}/registrations`, {
      side: 'PARTNER', partnerId: beta.id, status: 'APPROVED', overrideProtection: true,
    });
    assert.equal(res.status, 403, 'asking to override is not the same as being allowed to');
  });

  it('an administrator can, and it is written down', async () => {
    const [alpha, beta] = [await partner('Alpha Distribution'), await partner('Beta Systems')];
    const held = await dealAt(fx.customer.id, 'Held');
    await protect(held.id, alpha.id);

    const forced = await dealAt(fx.customer.id, 'Overruled');
    const res = await request(app, fx.admin).post(`/api/deals/${forced.id}/registrations`, {
      side: 'PARTNER', partnerId: beta.id, status: 'APPROVED', overrideProtection: true,
    });
    assert.equal(res.status, 201);

    const logged = await prisma.auditLog.findFirst({ where: { summary: { contains: 'Overrode' } } });
    assert.ok(logged, 'an override nobody can find afterwards is not a decision, it is a hole');
  });
});

describe('approving is also claiming', () => {
  it('a draft written first cannot be promoted past protection granted since', async () => {
    const [alpha, beta] = [await partner('Alpha Distribution'), await partner('Beta Systems')];

    // Beta gets its paperwork in first, but only as a draft — which holds nothing.
    const betaDeal = await dealAt(fx.customer.id, 'Beta, drafted early');
    const draft = await request(app, fx.rep).post(`/api/deals/${betaDeal.id}/registrations`, {
      side: 'PARTNER', partnerId: beta.id, status: 'DRAFT',
    });
    assert.equal(draft.status, 201);

    // Alpha then takes real protection on the same customer.
    const alphaDeal = await dealAt(fx.customer.id, 'Alpha, properly registered');
    await protect(alphaDeal.id, alpha.id);

    const promote = await request(app, fx.rep)
      .patch(`/api/registrations/${(draft.body as { id: string }).id}`, { status: 'APPROVED' });
    assert.equal(promote.status, 409, 'the draft must not become protection behind Alpha\'s back');
  });
});

describe('the deal itself informs rather than refuses', () => {
  it('naming a protected customer\'s rival partner on a deal saves, with a warning', async () => {
    const [alpha, beta] = [await partner('Alpha Distribution'), await partner('Beta Systems')];
    const held = await dealAt(fx.customer.id, 'Held');
    await protect(held.id, alpha.id);

    const working = await dealAt(fx.customer.id, 'Something Beta is working');
    const res = await request(app, fx.admin).patch(`/api/deals/${working.id}`, { partnerAccountId: beta.id });

    assert.equal(res.status, 200, 'a rep must still be able to record an opportunity they are working');
    const body = res.body as { protectionWarning?: { message: string; partnerName: string } };
    assert.ok(body.protectionWarning, 'but they should be told before the other partner tells them');
    assert.match(body.protectionWarning!.message, /Alpha Distribution/);
  });

  it('says nothing when there is nothing to say', async () => {
    const beta = await partner('Beta Systems');
    const clean = await dealAt(fx.customer.id, 'Nobody else here');
    const res = await request(app, fx.admin).patch(`/api/deals/${clean.id}`, { partnerAccountId: beta.id });
    assert.equal(res.status, 200);
    assert.equal((res.body as { protectionWarning?: unknown }).protectionWarning, undefined);
  });
});

describe('how long their request sat', () => {
  it('records when the partner asked, separately from when we registered it', async () => {
    const alpha = await partner('Alpha Distribution');
    const deal = await dealAt(fx.customer.id, 'Asked Monday, done Wednesday');
    const asked = new Date(Date.now() - 2 * 86_400_000);

    const res = await request(app, fx.rep).post(`/api/deals/${deal.id}/registrations`, {
      side: 'PARTNER', partnerId: alpha.id, status: 'APPROVED', requestedAt: asked.toISOString(),
    });
    assert.equal(res.status, 201);

    const saved = await prisma.dealRegistration.findUniqueOrThrow({ where: { id: (res.body as { id: string }).id } });
    assert.ok(saved.requestedAt, 'protection goes to whoever registers first — a request left sitting loses it');
    assert.ok(saved.submittedAt!.getTime() > saved.requestedAt!.getTime());
  });
});
