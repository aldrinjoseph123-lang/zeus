import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';

/**
 * Who can reach a quote or an invoice.
 *
 * Until 15 Sep 2026 nobody was stopped: the quotes and invoices routes never asked, so a
 * Sales Executive scoped to their team listed and opened every quote and invoice in the
 * company. Neither model has an owner column, so the rule had to be chosen, and the user
 * chose: a document belongs to the owner of the deal it sits on *and* to the person who
 * made it. A rep opens every quote on their own deal, including one a manager prepared,
 * and keeps the ones they prepared on somebody else's.
 *
 * In the fixtures `rep` and `manager` share a team; `otherRep` is on no team at all.
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
async function deal(owner: TestUser | null) {
  seq += 1;
  return prisma.deal.create({
    data: {
      reference: `ZEU-D-SCOPE${seq}`, name: `Deal ${seq}`, accountId: fx.customer.id,
      pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
      amount: 1000, cost: 0, vatRate: 5, vatAmount: 50, totalAmount: 1050, probability: 50,
      ownerId: owner?.id ?? null, closeDate: new Date(Date.now() + 30 * 86_400_000),
    },
  });
}

async function quote(label: string, opts: { dealOwner?: TestUser | null; preparedBy: TestUser | null }) {
  const onDeal = opts.dealOwner === undefined ? null : await deal(opts.dealOwner);
  seq += 1;
  return prisma.quote.create({
    data: { number: `ZEU-Q-${label}-${seq}`, accountId: fx.customer.id, dealId: onDeal?.id ?? null, preparedById: opts.preparedBy?.id ?? null, notes: label },
  });
}

async function invoice(label: string, opts: { dealOwner?: TestUser | null; createdBy: TestUser | null }) {
  const onDeal = opts.dealOwner === undefined ? null : await deal(opts.dealOwner);
  seq += 1;
  return prisma.invoice.create({
    data: {
      number: `ZEU-INV-${label}-${seq}`, type: 'TAX_INVOICE', status: 'SENT', accountId: fx.customer.id,
      dealId: onDeal?.id ?? null, createdById: opts.createdBy?.id ?? null, notes: label,
      total: 1050, dueDate: new Date(Date.now() - 86_400_000),
    },
  });
}

/** The world every test reads: one document of each kind of ownership. */
async function documents() {
  return {
    quotes: {
      onMyDeal: await quote('on-my-deal', { dealOwner: fx.rep, preparedBy: fx.admin }),
      preparedByMe: await quote('prepared-by-me', { dealOwner: fx.otherRep, preparedBy: fx.rep }),
      teammates: await quote('teammates', { preparedBy: fx.manager }),
      unassigned: await quote('unassigned', { preparedBy: null }),
      someoneElses: await quote('someone-elses', { dealOwner: fx.otherRep, preparedBy: fx.otherRep }),
    },
    invoices: {
      onMyDeal: await invoice('on-my-deal', { dealOwner: fx.rep, createdBy: fx.admin }),
      raisedByMe: await invoice('raised-by-me', { createdBy: fx.rep }),
      someoneElses: await invoice('someone-elses', { dealOwner: fx.otherRep, createdBy: fx.otherRep }),
    },
  };
}

const ids = (body: unknown) => new Set(((body as { data: Array<{ id: string }> }).data).map((r) => r.id));

describe('quotes', () => {
  it('a rep lists the quotes on their deals, their own, their team\'s and unassigned ones — not another rep\'s', async () => {
    const { quotes: q } = await documents();
    const res = await request(app, fx.rep).get('/api/quotes');
    assert.equal(res.status, 200);
    const seen = ids(res.body);
    for (const reachable of [q.onMyDeal, q.preparedByMe, q.teammates, q.unassigned]) {
      assert.ok(seen.has(reachable.id), `${reachable.notes} should be listed`);
    }
    assert.ok(!seen.has(q.someoneElses.id), 'another rep\'s quote on another rep\'s deal must not be listed');
  });

  it('and cannot open, print, change or send it', async () => {
    const { quotes: q } = await documents();
    const id = q.someoneElses.id;
    assert.equal((await request(app, fx.rep).get(`/api/quotes/${id}`)).status, 403);
    assert.equal((await request(app, fx.rep).get(`/api/quotes/${id}/pdf`)).status, 403);
    assert.equal((await request(app, fx.rep).patch(`/api/quotes/${id}`, { notes: 'mine now' })).status, 403);
    assert.equal((await request(app, fx.rep).post(`/api/quotes/${id}/status`, { status: 'SENT' })).status, 403);
    assert.equal((await request(app, fx.rep).post(`/api/quotes/${id}/send`, { to: ['x@example.com'] })).status, 403);
    assert.equal((await request(app, fx.rep).post(`/api/quotes/${id}/revise`, {})).status, 403);
    assert.equal((await request(app, fx.rep).post(`/api/approvals/quotes/${id}/submit`, {})).status, 403, 'nor ask a manager to sign off on it');
    assert.equal((await prisma.quote.findUniqueOrThrow({ where: { id } })).notes, 'someone-elses', 'nothing was written');
  });

  it('reading a quote is team-wide but changing one is the rep\'s own, as the role says', async () => {
    const { quotes: q } = await documents();
    assert.equal((await request(app, fx.rep).get(`/api/quotes/${q.teammates.id}`)).status, 200);
    assert.equal((await request(app, fx.rep).patch(`/api/quotes/${q.teammates.id}`, { notes: 'edited' })).status, 403, 'a teammate\'s quote is readable, not editable');
    assert.equal((await request(app, fx.rep).patch(`/api/quotes/${q.onMyDeal.id}`, { notes: 'edited' })).status, 200, 'a quote on my own deal is mine to edit');
  });

  it('a rep on no team reaches only their own', async () => {
    const { quotes: q } = await documents();
    const seen = ids((await request(app, fx.otherRep).get('/api/quotes')).body);
    assert.ok(seen.has(q.someoneElses.id));
    assert.ok(!seen.has(q.teammates.id), 'team scope with no team is just themselves');
    assert.equal((await request(app, fx.otherRep).get(`/api/quotes/${q.onMyDeal.id}`)).status, 403);
  });

  it('an administrator still reaches every quote, so the refusals above prove something', async () => {
    const { quotes: q } = await documents();
    const seen = ids((await request(app, fx.admin).get('/api/quotes')).body);
    assert.equal(seen.size, 5);
    assert.equal((await request(app, fx.admin).get(`/api/quotes/${q.someoneElses.id}`)).status, 200);
  });

  it('the quotes report shows the rep the same quotes the screen does', async () => {
    await documents();
    const listed = [...ids((await request(app, fx.rep).get('/api/quotes')).body)].length;
    const report = (await request(app, fx.rep).get('/api/reports/quotes')).body as { rows: unknown[] };
    assert.equal(report.rows.length, listed);
  });
});

describe('invoices', () => {
  it('a rep lists invoices on their deals and ones they raised — not another rep\'s', async () => {
    const { invoices: i } = await documents();
    const seen = ids((await request(app, fx.rep).get('/api/invoices')).body);
    assert.ok(seen.has(i.onMyDeal.id));
    assert.ok(seen.has(i.raisedByMe.id));
    assert.ok(!seen.has(i.someoneElses.id));
  });

  it('and cannot open or print another rep\'s', async () => {
    const { invoices: i } = await documents();
    assert.equal((await request(app, fx.rep).get(`/api/invoices/${i.someoneElses.id}`)).status, 403);
    assert.equal((await request(app, fx.rep).get(`/api/invoices/${i.someoneElses.id}/pdf`)).status, 403);
  });

  it('the overdue panels show only what the list shows', async () => {
    const { invoices: i } = await documents();
    // Three invoices of 1,050 each; the rep can reach two of them.
    const ageing = (await request(app, fx.rep).get('/api/invoices/ageing')).body as { totalOutstanding: number };
    assert.equal(ageing.totalOutstanding, 2100, 'the ageing total counted money on another rep\'s invoice');
    assert.equal(((await request(app, fx.admin).get('/api/invoices/ageing')).body as { totalOutstanding: number }).totalOutstanding, 3150);
    const attention = JSON.stringify((await request(app, fx.rep).get('/api/dashboard/attention')).body);
    assert.ok(!attention.includes(i.someoneElses.number), 'the dashboard named another rep\'s overdue invoice');
    assert.ok(attention.includes(i.onMyDeal.number), 'while still naming the rep\'s own, so the check is looking');
  });

  it('an administrator still reaches every invoice', async () => {
    const { invoices: i } = await documents();
    assert.equal(ids((await request(app, fx.admin).get('/api/invoices')).body).size, 3);
    assert.equal((await request(app, fx.admin).get(`/api/invoices/${i.someoneElses.id}`)).status, 200);
  });
});

describe('an account shows only the documents its reader can open', () => {
  it('lists the rep\'s quotes and invoices on the customer, not another rep\'s', async () => {
    const { quotes: q, invoices: i } = await documents();
    const res = await request(app, fx.rep).get(`/api/accounts/${fx.customer.id}`);
    assert.equal(res.status, 200);
    const body = JSON.stringify(res.body);
    assert.ok(body.includes(q.onMyDeal.number) && body.includes(i.onMyDeal.number));
    assert.ok(!body.includes(q.someoneElses.number), 'the account page listed a quote its own screen refuses');
    assert.ok(!body.includes(i.someoneElses.number), 'the account page listed an invoice its own screen refuses');
  });
});
