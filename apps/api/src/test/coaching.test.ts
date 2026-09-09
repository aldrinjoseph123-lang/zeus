import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';

/**
 * Coaching dashboard data: quota progress, pipeline by stage, escalation flags, and
 * access control (self / team / see-all only).
 */

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

function base(ref: string, amount: number) {
  return {
    reference: ref, name: `Deal ${ref}`, accountId: fx.customer.id, pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
    amount, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: amount, probability: 20, ownerId: fx.rep.id,
  };
}

describe('coaching dashboard', () => {
  it('reports quota progress and flags a high-value slipping deal', async () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
    await prisma.target.create({ data: { userId: fx.rep.id, year, quarter, amount: 500_000 } });

    // Won this quarter → quota attainment.
    await prisma.deal.create({ data: { ...base('C-WON', 200_000), status: 'WON' as never, closeDate: now, closedAt: now } });
    // High-value, close date passed → escalation.
    await prisma.deal.create({ data: { ...base('C-HV', 100_000), status: 'OPEN' as never, closeDate: new Date(now.getTime() - 2 * 86_400_000) } });
    // Healthy open deal, future close → not escalated.
    await prisma.deal.create({ data: { ...base('C-OK', 10_000), status: 'OPEN' as never, closeDate: new Date(now.getTime() + 30 * 86_400_000) } });

    const res = await request(app, fx.admin).get(`/api/coaching/${fx.rep.id}`);
    assert.equal(res.status, 200);
    const body = res.body as { quota: { target: number; won: number; attainmentPct: number }; pipeline: unknown[]; escalations: Array<{ reference: string; reasons: string[] }> };

    assert.equal(body.quota.target, 500_000);
    assert.equal(body.quota.won, 200_000);
    assert.equal(body.quota.attainmentPct, 40);
    assert.ok(body.pipeline.length >= 1, 'pipeline grouped by stage');

    const hv = body.escalations.find((e) => e.reference === 'C-HV');
    assert.ok(hv, 'high-value slipping deal is escalated');
    assert.ok(hv!.reasons.some((r) => /Close date passed/.test(r)));
    assert.ok(hv!.reasons.some((r) => /High value/.test(r)));
    assert.ok(!body.escalations.some((e) => e.reference === 'C-OK'), 'healthy deal not escalated');
  });

  /**
   * A rep whose role masks margin must not read it here either. The escalation reason
   * "Margin 12.3% below 20%" sits beside an amount they can see, so printing it hands
   * them the buy price by subtraction — the same leak the price book report had once,
   * wearing a sentence instead of a column.
   */
  it('never tells a rep the margin their role is not allowed to see', async () => {
    await setSetting('approvals.dealMinMarginPct', 30, 'approvals');
    invalidateSettings();

    const now = new Date();
    // 100k selling, 90k cost — a 10% margin, well under the 30% floor.
    await prisma.deal.create({
      data: { ...base('C-THIN', 100_000), cost: 90_000, status: 'OPEN' as never, closeDate: new Date(now.getTime() + 30 * 86_400_000) },
    });

    const reasonsFor = async (as: Fixtures['admin']) => {
      const res = await request(app, as).get(`/api/coaching/${fx.rep.id}`);
      assert.equal(res.status, 200);
      const body = res.body as { escalations: Array<{ reference: string; reasons: string[] }> };
      return body.escalations.find((e) => e.reference === 'C-THIN')?.reasons ?? [];
    };

    // The manager is the audience this line was written for.
    assert.ok((await reasonsFor(fx.admin)).some((r) => /Margin/.test(r)), 'an admin sees the margin warning');

    // The rep owns the deal and may read it — but their role masks cost and margin.
    const repSees = await reasonsFor(fx.rep);
    assert.ok(!repSees.some((r) => /Margin/.test(r)), `margin leaked to a rep: ${JSON.stringify(repSees)}`);
    assert.ok(!repSees.some((r) => /90|10\.0|%/.test(r)), 'and no figure it could be derived from');
  });

  it('lets a rep see their own, blocks a peer, allows an admin', async () => {
    assert.equal((await request(app, fx.rep).get(`/api/coaching/${fx.rep.id}`)).status, 200, 'self');
    assert.equal((await request(app, fx.otherRep).get(`/api/coaching/${fx.rep.id}`)).status, 403, 'peer blocked');
    assert.equal((await request(app, fx.admin).get(`/api/coaching/${fx.rep.id}`)).status, 200, 'admin sees all');
  });
});
