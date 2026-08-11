import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

/**
 * Backups sit behind their own permission module. Least privilege by default: only a
 * role explicitly granted 'backups' sees them. Validate (integrity, no DB) needs read;
 * the restore-into-a-throwaway-DB verify needs the privileged delete tier.
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

describe('backups permission gating', () => {
  it('denies a rep and a manager (no backups grant by default)', async () => {
    for (const who of [fx.rep, fx.manager]) {
      assert.equal((await request(app, who).get('/api/backups')).status, 403, 'list denied');
      assert.equal((await request(app, who).post('/api/backups/validate', {})).status, 403, 'validate denied');
      assert.equal((await request(app, who).post('/api/backups/verify', {})).status, 403, 'verify denied');
    }
  });

  it('lets an admin read and validate (integrity, no restore rights needed)', async () => {
    assert.equal((await request(app, fx.admin).get('/api/backups')).status, 200);
    const res = await request(app, fx.admin).post('/api/backups/validate', {});
    assert.equal(res.status, 200);
    // Result shape is present whether or not a backup file exists in the test workspace.
    assert.ok('ok' in (res.body as object) && 'note' in (res.body as object));
  });

  it('gates the restore-verify behind the privileged tier', async () => {
    // Sales Manager has no backups grant → the privileged verify is refused.
    assert.equal((await request(app, fx.manager).post('/api/backups/verify', {})).status, 403);
  });
});
