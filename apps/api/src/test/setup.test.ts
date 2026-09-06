import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * First-run setup. A fresh install has every company default except the TRN, and
 * without a TRN no tax invoice can be issued — the status endpoint is what sends an
 * admin to fix that before the first invoice fails.
 */
let app: FastifyInstance;
let fx: Fixtures;

type Status = { complete: boolean; required: Array<{ key: string; label: string }>; missing: Array<{ key: string; label: string }> };

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

describe('first-run setup status', () => {
  it('reports the TRN missing on a fresh install, and lists every required field', async () => {
    // The fixtures seed a TRN so the invoice tests can issue; a real install has none.
    await request(app, fx.admin).put('/api/settings', { 'company.trn': '' });
    const res = await request(app, fx.admin).get('/api/setup/status');
    assert.equal(res.status, 200);
    const body = res.body as Status;
    assert.equal(body.complete, false);
    assert.ok(body.missing.some((m) => m.key === 'company.trn'), 'TRN should be missing');
    assert.ok(body.required.length >= body.missing.length);
    assert.ok(body.required.some((r) => r.key === 'company.legalName'));
  });

  it('a TRN that is not 15 digits still counts as missing', async () => {
    await request(app, fx.admin).put('/api/settings', { 'company.trn': '12345', 'company.email': 'ops@example.com', 'company.phone': '+97140000000' });
    const body = (await request(app, fx.admin).get('/api/setup/status')).body as Status;
    assert.equal(body.complete, false);
    assert.deepEqual(body.missing.map((m) => m.key), ['company.trn']);
  });

  it('becomes complete once the real values are saved', async () => {
    await request(app, fx.admin).put('/api/settings', { 'company.trn': '100000000000003', 'company.email': 'ops@example.com', 'company.phone': '+97140000000' });
    const body = (await request(app, fx.admin).get('/api/setup/status')).body as Status;
    assert.equal(body.complete, true, JSON.stringify(body.missing));
    assert.deepEqual(body.missing, []);
  });

  it('is closed to a role that cannot read settings', async () => {
    assert.equal((await request(app, fx.rep).get('/api/setup/status')).status, 403);
    assert.equal((await request(app).get('/api/setup/status')).status, 401);
  });
});
