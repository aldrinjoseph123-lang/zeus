import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';
import { setSetting, invalidateSettings } from '../lib/settings.js';

/**
 * View auditing is off by default (one row per record open is high volume). When the
 * admin switches it on, opening a record records who viewed what and when.
 */

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); invalidateSettings(); });

async function waitFor<T>(fn: () => Promise<T | null>, ms = 3000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((s) => setTimeout(s, 50));
  }
  return null;
}

describe('view auditing', () => {
  it('logs no read when the setting is off (default)', async () => {
    const res = await request(app, fx.admin).get(`/api/accounts/${fx.customer.id}`);
    assert.equal(res.status, 200);
    await new Promise((s) => setTimeout(s, 200));
    assert.equal(await prisma.auditLog.count({ where: { action: 'read' } }), 0);
  });

  it('records who viewed what, and when, once enabled', async () => {
    await setSetting('audit.logReads', true);
    invalidateSettings();

    const res = await request(app, fx.admin).get(`/api/accounts/${fx.customer.id}`);
    assert.equal(res.status, 200);

    const row = await waitFor(() => prisma.auditLog.findFirst({ where: { action: 'read', entity: 'Account' } }));
    assert.ok(row, 'a read entry should be written when logging is on');
    assert.equal(row!.entityId, fx.customer.id, 'which record');
    assert.equal(row!.userId, fx.admin.id, 'who viewed it');
    assert.ok(row!.at, 'when');
  });
});
