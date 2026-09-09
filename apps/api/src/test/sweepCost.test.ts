import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * What a role may not see, it may not see anywhere.
 *
 * Sales Executive ships with cost and margin hidden on deals, quotes and products. That
 * has been broken twice in different places: the price book report handed reps the buy
 * prices the screen refused them, and the coaching escalation printed the margin in a
 * sentence beside an amount they could already see. Both were found by a person, months
 * apart, and both were the same rule applied unevenly.
 *
 * So this asks the whole GET surface rather than the routes anybody suspected: seed a
 * record that carries a cost, call every parameterless read as the rep, and refuse any
 * response that names those fields — or spells one out in prose.
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

/** Exactly the fields the shipped Sales Executive role masks. */
const FORBIDDEN_KEYS = new Set(['cost', 'margin', 'marginPct', 'totalCost', 'unitCost', 'marginAmount']);
/** The coaching leak was a string, not a key — a scan for field names alone would have missed it. */
const FORBIDDEN_TEXT = /\bmargin\b|\bbuy price\b|\bcost\b/i;

const isAmount = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v));

/** Copy, not data: a column heading or a report's blurb may say "Margin" harmlessly. */
const COPY_KEYS = new Set(['label', 'description', 'name', 'title', 'subtitle', 'key']);

function leaks(value: unknown, path = '', key = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaks(v, `${path}[${i}]`, key));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      // Money is a number — or a numeric string, because Prisma serialises Decimal that
      // way, which is most of the money in this codebase. The permission map also has
      // keys called `cost`, whose value is the word "hidden": that is the rule being
      // described, not broken, so it has to read as policy rather than as an amount.
      if (FORBIDDEN_KEYS.has(k) && isAmount(v)) return [`${path}.${k} = ${JSON.stringify(v)}`];
      return leaks(v, `${path}.${k}`, k);
    });
  }
  if (typeof value === 'string' && !COPY_KEYS.has(key) && FORBIDDEN_TEXT.test(value)) {
    return [`${path} = ${JSON.stringify(value)}`];
  }
  return [];
}

describe('sweep: money a role may not see', () => {
  it('is absent from every read a cost-masked rep can make', async () => {
    // Something worth leaking: a deal the rep owns, priced well under its cost.
    const stage = fx.pipeline.stages[0];
    await prisma.deal.create({
      data: {
        reference: 'SWEEP-1', name: 'Sweep deal', accountId: fx.customer.id, pipelineId: fx.pipeline.id,
        stageId: stage.id, amount: 100_000, cost: 90_000, vatRate: 5, vatAmount: 0, totalAmount: 100_000,
        probability: 20, ownerId: fx.rep.id, closeDate: new Date(Date.now() + 30 * 86_400_000),
      },
    });
    await prisma.product.create({
      data: { sku: 'SWEEP-SKU', name: 'Sweep product', listPrice: 1000, cost: 700, isActive: true },
    });
    // Subscriptions ride on the deals permission and carry the buy price twice over —
    // per row as unitCost/termCost, and again in the aggregates. Seed one so the sweep
    // is looking at real amounts rather than at zeroes.
    await prisma.subscription.create({
      data: {
        reference: 'SWEEP-SUB', description: 'Sweep subscription', accountId: fx.customer.id, ownerId: fx.rep.id,
        termValue: 100_000, termCost: 73_500, unitPrice: 100_000, unitCost: 73_500,
        startDate: new Date(), endDate: new Date(Date.now() + 300 * 86_400_000), status: 'ACTIVE',
      },
    });

    // Parameterless reads: the lists and summaries a rep actually opens. A route needing
    // an id would 404 on a made-up one and prove nothing.
    const routes = app.routeTable
      .filter((r) => r.method === 'GET' && r.url.startsWith('/api/') && !r.url.includes(':') && !r.url.includes('*'))
      .filter((r) => !r.url.startsWith('/api/portal/'));
    assert.ok(routes.length > 15, `expected a real read surface, got ${routes.length}`);

    const found: string[] = [];
    for (const r of routes) {
      const res = await request(app, fx.rep).get(r.url);
      // A refusal is a stronger answer than masking — the price book chooses it deliberately.
      if (res.status !== 200) continue;
      for (const hit of leaks(res.body)) found.push(`${r.url} → ${hit}`);
    }
    assert.deepEqual(found, [], 'these reads handed a cost-masked rep the numbers their role hides');
  });

  it('and the same reads still carry it for a manager, so the sweep is not just finding empty pages', async () => {
    await prisma.product.create({
      data: { sku: 'SWEEP-SKU-2', name: 'Sweep product', listPrice: 1000, cost: 700, isActive: true },
    });
    const res = await request(app, fx.admin).get('/api/products');
    assert.equal(res.status, 200);
    assert.ok(leaks(res.body).length > 0, 'an admin should still see cost — otherwise the check above proves nothing');
  });
});
