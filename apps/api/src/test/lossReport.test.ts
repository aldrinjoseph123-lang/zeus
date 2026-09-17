import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

/**
 * Loss-reasons report: lost deals grouped by their (structured) reason, ranked by
 * lost value — the systemic-blocker view a manager reviews over time.
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

async function lostDeal(ref: string, reason: string, amount: number) {
  return prisma.deal.create({
    data: {
      reference: ref, name: `Deal ${ref}`, accountId: fx.customer.id, pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
      amount, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: amount, probability: 0, closeDate: new Date(),
      ownerId: fx.rep.id, status: 'LOST', lostReason: reason, closedAt: new Date(),
    },
  });
}

describe('loss-reasons report', () => {
  it('groups by reason, ranks by lost value, and buckets blanks as Uncategorised', async () => {
    await lostDeal('L-1', 'Price', 100_000);
    await lostDeal('L-2', 'Price', 50_000);
    await lostDeal('L-3', 'No budget', 20_000);
    await lostDeal('L-4', '', 5_000); // no reason → Uncategorised

    const res = await request(app, fx.admin).get('/api/reports/loss-reasons?format=json');
    assert.equal(res.status, 200);
    const body = res.body as { rows: Array<{ reason: string; deals: number; value: number; share: number }>; summary: Array<[string, string]> };

    assert.equal(body.rows[0].reason, 'Price', 'highest lost value first');
    assert.equal(body.rows[0].deals, 2);
    assert.equal(body.rows[0].value, 150_000);
    assert.ok(body.rows.some((r) => r.reason === 'Uncategorised'), 'blank reason bucketed');
    assert.equal(body.rows.reduce((s, r) => s + r.deals, 0), 4);

    const lostDeals = body.summary.find((s) => s[0] === 'Lost deals');
    assert.equal(lostDeals?.[1], '4');
  });
});

/**
 * A report a role is offered has to open for it.
 *
 * The catalogue listed every report there is. A role with the reports permission but no access
 * to leads, quotes, invoices or the catalogue was shown twenty reports, opened one, and was told
 * "Your role cannot see leads." The refusal was right; offering it was not.
 */
describe('the report catalogue offers what the role can open', () => {
  it('drops the ones the role has no module for, and every one it keeps opens', async () => {
    const role = await prisma.role.create({
      data: {
        name: 'Pipeline Watcher',
        permissions: {
          deals: { read: 'all', create: false, update: 'none', delete: 'none', export: false },
          accounts: { read: 'all', create: false, update: 'none', delete: 'none', export: false },
          reports: { read: 'all', create: false, update: 'none', delete: 'none', export: true },
        } as never,
      },
    });
    const user = await prisma.user.create({ data: { email: 'watcher@test.local', name: 'watcher', passwordHash: 'x', roleId: role.id } });
    const { SESSION_COOKIE, signSessionToken } = await import('../auth/session.js');
    const watcher = { id: user.id, email: user.email, name: user.name, roleName: role.name, cookie: `${SESSION_COOKIE}=${await signSessionToken(user.id, 12)}` };

    const offered = (await request(app, watcher).get('/api/reports')).body as Array<{ key: string }>;
    const all = (await request(app, fx.admin).get('/api/reports')).body as Array<{ key: string }>;
    assert.ok(offered.length < all.length, 'a role with two modules is not offered every report there is');
    assert.ok(!offered.some((r) => ['leads', 'quotes', 'receivables', 'price-book', 'activities'].includes(r.key)), 'nor the ones it has no module for');

    for (const { key } of offered) {
      const res = await request(app, watcher).get(`/api/reports/${key}`);
      assert.equal(res.status, 200, `the ${key} report is offered to this role and must open`);
    }
  });
});

/**
 * The menu and the server have to agree.
 *
 * Twice now a screen has been offered to a role that could not open it: the quotes report
 * scoped on a field quotes do not have, and the report catalogue listing all twenty reports
 * to a role with two modules. Both were found by opening what was offered, so that is what
 * this does — for every shipped role, and for a role built from two modules.
 */
describe('every screen a role is offered opens for it', () => {
  /** Screen → the module the menu gates it on, as components/Layout.tsx does. */
  const SCREENS: Array<[string, string]> = [
    ['/api/dashboard/overview', 'dashboard'], ['/api/deals', 'deals'], ['/api/leads', 'leads'],
    ['/api/accounts', 'accounts'], ['/api/partners', 'partners'], ['/api/contacts', 'contacts'],
    ['/api/activities', 'activities'], ['/api/quotes', 'quotes'], ['/api/invoices', 'invoices'],
    ['/api/purchase-orders', 'invoices'], ['/api/products', 'products'],
    ['/api/subscriptions', 'deals'], ['/api/subscriptions/summary', 'deals'],
    ['/api/reports', 'reports'], ['/api/targets', 'reports'], ['/api/imports', 'imports'],
    ['/api/settings', 'settings'], ['/api/users', 'users'], ['/api/roles', 'roles'],
    ['/api/audit', 'audit'], ['/api/system/logs', 'audit'], ['/api/system/status', 'audit'],
    ['/api/email-log', 'audit'], ['/api/backups', 'backups'], ['/api/sessions', 'users'],
    ['/api/notification-rules', 'settings'], ['/api/scheduled-reports', 'settings'],
    ['/api/integrations/health', 'integrations'], ['/api/portal-admin/users', 'portal'],
    // The queue is part of the dashboard, and the panel only asks for it when the reader can
    // approve something — so the module that gates it is the dashboard, not deals.
    ['/api/approvals/pending', 'dashboard'],
  ];

  async function sweep(user: { id: string; cookie: string }, label: string) {
    const me = (await request(app, user as never).get('/api/auth/me')).body as { user: { id: string; role: { permissions: Record<string, { read?: string }> } } };
    const perms = me.user.role.permissions ?? {};
    const wrong: string[] = [];
    for (const [url, module] of [...SCREENS, [`/api/coaching/${me.user.id}`, 'deals'] as [string, string]]) {
      const read = perms[module]?.read ?? 'none';
      const res = await request(app, user as never).get(url);
      if (read !== 'none' && res.status !== 200) wrong.push(`${label}: ${url} is offered (${module}: ${read}) but answered ${res.status}`);
      if (read === 'none' && res.status === 200) wrong.push(`${label}: ${url} is not offered (${module}) but opened anyway`);
    }
    return wrong;
  }

  it('for every shipped role', async () => {
    const wrong = [
      ...(await sweep(fx.admin, 'Administrator')),
      ...(await sweep(fx.manager, 'Sales Manager')),
      ...(await sweep(fx.rep, 'Sales Executive')),
    ];
    assert.deepEqual(wrong, []);
  });

  it('and for a role put together from two modules', async () => {
    const role = await prisma.role.create({
      data: {
        name: 'Two Modules',
        permissions: {
          deals: { read: 'all', create: false, update: 'none', delete: 'none', export: false },
          accounts: { read: 'all', create: false, update: 'none', delete: 'none', export: false },
          reports: { read: 'all', create: false, update: 'none', delete: 'none', export: true },
        } as never,
      },
    });
    const user = await prisma.user.create({ data: { email: 'twomodules@test.local', name: 'two', passwordHash: 'x', roleId: role.id } });
    const { SESSION_COOKIE, signSessionToken } = await import('../auth/session.js');
    const wrong = await sweep({ id: user.id, cookie: `${SESSION_COOKIE}=${await signSessionToken(user.id, 12)}` }, 'Two Modules');
    assert.deepEqual(wrong, []);
  });
});
