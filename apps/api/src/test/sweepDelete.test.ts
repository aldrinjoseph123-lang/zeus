import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * Paperwork must always point at something live.
 *
 * This rule has broken twice, in two shapes. Deleting an account was allowed while its
 * quotes and invoices still named it (128bcbb). Deactivating a product checked whether
 * it appeared on a quote and nothing else, so one sitting on an invoice, a purchase
 * order or a subscription went quietly inactive (b09b0f9). Both were the same rule
 * enforced against the children somebody happened to think of.
 *
 * So every DELETE route is listed here. A route either has a recipe below — build the
 * parent, attach one live child, and prove the delete is refused — or it is declared as
 * having no children to orphan, with the reason. A new DELETE route belongs to neither
 * list and fails until somebody decides which it is; that is the part a hand-written
 * test per entity cannot do.
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

const id = (res: { body: unknown }) => (res.body as { id: string }).id;
const admin = () => request(app, fx.admin);

/**
 * Each recipe returns the id of a parent that already has one live child hanging off it.
 * The child is deliberately a different kind per entity — the bug was always the child
 * nobody enumerated.
 */
const RECIPES: Record<string, () => Promise<string>> = {
  '/api/accounts/:id': async () => {
    const account = await admin().post('/api/accounts', { name: 'Sweep Parent Co', type: 'CUSTOMER', ignoreDuplicates: true });
    await admin().post('/api/contacts', { firstName: 'Child', lastName: 'Contact', accountId: id(account), ignoreDuplicates: true });
    return id(account);
  },
  '/api/deals/:id': async () => {
    const deal = await admin().post('/api/deals', { name: 'Sweep parent deal', accountId: fx.customer.id, amount: 5000, ignoreDuplicates: true });
    await admin().post('/api/quotes', { dealId: id(deal), accountId: fx.customer.id, lines: [{ description: 'Line', quantity: 1, unitPrice: 5000 }] });
    return id(deal);
  },
  '/api/products/:id': async () => {
    const product = await admin().post('/api/products', { sku: 'SWEEP-DEL', name: 'Sweep product', listPrice: 100, cost: 60 });
    // On a subscription, not a quote — the exact child the original fix forgot.
    await prisma.subscription.create({
      data: {
        reference: 'SWEEP-DEL-SUB', description: 'holds the product', accountId: fx.customer.id, productId: id(product),
        termValue: 100, termCost: 60, startDate: new Date(), endDate: new Date(Date.now() + 300 * 86_400_000), status: 'ACTIVE',
      },
    });
    return id(product);
  },
  '/api/contacts/:id': async () => {
    const contact = await admin().post('/api/contacts', { firstName: 'Sweep', lastName: 'Primary', accountId: fx.customer.id, ignoreDuplicates: true });
    await admin().post('/api/deals', { name: 'Deal on the contact', accountId: fx.customer.id, primaryContactId: id(contact), amount: 1000, ignoreDuplicates: true });
    return id(contact);
  },
};

/** DELETE routes with nothing that can be orphaned, each for a stated reason. */
const NO_CHILDREN: Record<string, string> = {
  '/api/activities/:id': 'a leaf — nothing points at an activity',
  '/api/partners/:id/enablement/:vendorId': 'a leaf: removing an enablement records that a partner can no longer sell a vendor. Deals already quoted keep their history, and the deal page simply starts saying the partner is not enabled — which is the truth it is there to tell',
  '/api/attachments/:id': 'a leaf; the file is removed with the row',
  '/api/custom-fields/:id': 'values live on the records as JSON, and are left alone deliberately',
  '/api/deliveries/:id': 'a leaf under an entitlement',
  '/api/entitlements/:id': 'cascades to its own deliveries by design',
  '/api/invoices/:id': 'refuses on its own status rules, not on children — issued invoices cannot be deleted at all',
  '/api/leads/:id': 'a lead converts into other records rather than parenting them',
  '/api/payments/:id': 'deleting one is the documented correction path; it reverses the balance',
  '/api/price-book/:id': 'a price entry is a leaf; quotes copy the resolved figure rather than pointing at it',
  '/api/purchase-orders/:id': 'refuses on its own status and payment rules',
  '/api/quotes/:id': 'refuses on its own status rules — an accepted quote is locked',
  '/api/registrations/:regId': 'a leaf under a deal',
  '/api/roles/:id': 'refuses while a user holds the role — asserted in security.test.ts',
  '/api/scheduled-reports/:id': 'a leaf',
  '/api/sessions/:id': 'revoking a session is the point of it',
  '/api/subscriptions/:id': 'a leaf; its entitlements cascade by design',
  '/api/teams-webhooks/:id': 'notification rules fall back to the default channel',
  '/api/users/:id': 'deactivated rather than deleted, and refuses on the last administrator',
  '/api/webhooks/:id': 'a leaf',
};

describe('sweep: a delete never orphans its children', () => {
  it('covers every DELETE route — by recipe or by a stated reason', () => {
    const routes = app.routeTable
      .filter((r) => r.method === 'DELETE' && r.url.startsWith('/api/'))
      .map((r) => r.url);
    const undecided = routes.filter((url) => !(url in RECIPES) && !(url in NO_CHILDREN));
    assert.deepEqual(undecided, [], 'new DELETE route: add a recipe proving it refuses, or say why nothing can be orphaned');

    // A reason for a route that no longer exists is a comment pretending to be a rule.
    const present = new Set(routes);
    const stale = [...Object.keys(RECIPES), ...Object.keys(NO_CHILDREN)].filter((url) => !present.has(url));
    assert.deepEqual(stale, [], 'stale entry — the route is gone');
  });

  for (const url of Object.keys(RECIPES)) {
    it(`refuses to delete ${url} while a live child points at it`, async () => {
      const parentId = await RECIPES[url]();
      const res = await request(app, fx.admin).del(url.replace(/:[A-Za-z]+/, parentId));
      // Refusing outright and deactivating instead both honour the rule; silently
      // deleting the parent and leaving the child pointing at it does not.
      const refused = res.status >= 400 && res.status < 500;
      const deactivated = res.status === 200 && (res.body as { deactivated?: boolean })?.deactivated === true;
      assert.ok(refused || deactivated,
        `expected a refusal or a deactivation, got ${res.status} ${JSON.stringify(res.body)}`);
    });
  }
});
