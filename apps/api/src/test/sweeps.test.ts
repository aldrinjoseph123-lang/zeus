import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * Rules asserted against every route the app registered, not against the handful a
 * test author remembered.
 *
 * These read the real route table (app.routeTable, filled by an onRoute hook), so a
 * route added next year is covered the day it is written — nobody has to remember to
 * come back here. That is the whole point: Zeus's worst bugs were rules that held on
 * most routes, and a per-route test cannot find the route nobody thought about.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

/** Fastify writes params as :name — any value will do, since none of these should get that far. */
const fill = (url: string) => url.replace(/:[A-Za-z0-9_]+/g, 'ckzz00000000000000000000');

/** The API surface, minus the HEAD/OPTIONS Fastify adds for us and the static file routes. */
function apiRoutes() {
  return app.routeTable
    .filter((r) => r.url.startsWith('/api/'))
    .filter((r) => !['HEAD', 'OPTIONS'].includes(r.method));
}

const send = (caller: ReturnType<typeof request>, method: string, url: string) => {
  if (method === 'GET') return caller.get(url);
  if (method === 'DELETE') return caller.del(url);
  if (method === 'PATCH') return caller.patch(url, {});
  if (method === 'PUT') return caller.put(url, {});
  return caller.post(url, {});
};

describe('sweep: every route in the table', () => {
  it('refuses an unauthenticated caller, except the few that are public by design', async () => {
    // The gate's own list, not a copy of it — a copy would drift the moment someone
    // added a public route and forgot this file.
    const publicPaths = app.publicPaths;
    const routes = apiRoutes().filter((r) => !publicPaths.has(r.url))
      // The portal has its own cookie and its own gate; its sign-in routes are public
      // for the same reason the staff one is.
      .filter((r) => !r.url.startsWith('/api/portal/auth/'));

    assert.ok(routes.length > 50, `expected a real route table, got ${routes.length}`);

    const open: string[] = [];
    for (const r of routes) {
      const res = await send(request(app), r.method, fill(r.url));
      if (res.status !== 401) open.push(`${r.method} ${r.url} → ${res.status}`);
    }
    assert.deepEqual(open, [], 'these answered an anonymous caller with something other than 401');
  });

  /**
   * A malformed body is the caller's mistake and must read as one. This is the
   * generalisation of a real fix: a ZodError escaping a handler became a 500, which
   * says "Zeus broke" when the truth was "you sent nonsense" — and 500s are what an
   * admin is paged about.
   */
  it('never answers 500 to a malformed body', async () => {
    const routes = apiRoutes().filter((r) => ['PATCH', 'PUT'].includes(r.method));
    assert.ok(routes.length > 15, `expected the PATCH/PUT surface, got ${routes.length}`);

    const crashed: string[] = [];
    for (const r of routes) {
      // Deliberate nonsense: wrong types, unknown keys, a null where an object goes.
      const junk = { name: 12345, status: { nope: true }, amount: 'not-a-number', __unknown: null };
      const res = await request(app, fx.admin).patch(fill(r.url), junk);
      if (res.status >= 500) crashed.push(`${r.method} ${r.url} → ${res.status}`);
    }
    assert.deepEqual(crashed, [], 'a bad body must be a 4xx — a 500 pages an admin for the caller\'s typo');
  });
});
