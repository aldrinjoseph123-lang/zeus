import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * A record outside your scope stays outside it, however the number is arrived at.
 *
 * The dashboard once scoped its lists correctly and its raw aggregates not at all, so a
 * rep read the company's pipeline in a headline figure while the table beneath it showed
 * only their own (cdf0ac3). Scoping is applied per query, which means every new query is
 * a fresh chance to forget — and the forgotten one is never the query you are looking at.
 *
 * So: seed exactly one deal, owned by somebody on no team at all, and read the whole
 * parameterless GET surface as a team-scoped rep. Because it is the only deal in the
 * database, any sum that includes it equals its amount exactly, and any list that
 * includes it carries its reference. Either is a leak, wherever it turns up.
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

/** Distinctive enough to spot anywhere in a response, and unlikely to arise by arithmetic. */
const REFERENCE = 'OUTSIDE-SCOPE-1';
const AMOUNT = 987_654;

async function seedOutOfScopeDeal() {
  // fx.otherRep is deliberately on no team, so "team" scope must not reach them.
  await prisma.deal.create({
    data: {
      reference: REFERENCE, name: 'Another team\'s deal', accountId: fx.customer.id,
      pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
      amount: AMOUNT, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: AMOUNT,
      probability: 50, ownerId: fx.otherRep.id, closeDate: new Date(Date.now() + 30 * 86_400_000),
    },
  });
}

function reads() {
  return app.routeTable
    .filter((r) => r.method === 'GET' && r.url.startsWith('/api/') && !r.url.includes(':') && !r.url.includes('*'))
    .filter((r) => !r.url.startsWith('/api/portal/'));
}

/** Anything naming the deal, or any figure that could only have come from summing it. */
function traces(body: unknown): string[] {
  const text = JSON.stringify(body ?? null);
  const hits: string[] = [];
  if (text.includes(REFERENCE)) hits.push('names the deal');
  // The only deal in the database, so its amount can appear in a total only by inclusion.
  if (new RegExp(`(^|[^\\d.])${AMOUNT}([^\\d]|$)`).test(text)) hits.push('counts its value');
  return hits;
}

describe('sweep: scope holds across every read', () => {
  it('keeps another team\'s deal out of every list and every total a rep can reach', async () => {
    await seedOutOfScopeDeal();
    const routes = reads();
    assert.ok(routes.length > 15, `expected a real read surface, got ${routes.length}`);

    const leaked: string[] = [];
    for (const r of routes) {
      const res = await request(app, fx.rep).get(r.url);
      if (res.status !== 200) continue;
      for (const hit of traces(res.body)) leaked.push(`${r.url} → ${hit}`);
    }
    assert.deepEqual(leaked, [], 'these reads showed a team-scoped rep a deal from outside their scope');
  });

  it('and an administrator still sees it, so the sweep is not just reading empty pages', async () => {
    await seedOutOfScopeDeal();
    const res = await request(app, fx.admin).get('/api/deals');
    assert.equal(res.status, 200);
    assert.ok(traces(res.body).length > 0, 'an admin sees every team — otherwise the check above proves nothing');
  });
});
