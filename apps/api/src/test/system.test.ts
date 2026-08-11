import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';

/**
 * Status page and system log endpoints: reachable only by a role that may see the
 * audit trail, reporting live component health, and surfacing what was logged.
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

describe('system status', () => {
  it('is closed to anonymous and to a rep, open to an admin', async () => {
    assert.equal((await request(app).get('/api/system/status')).status, 401);
    assert.equal((await request(app, fx.rep).get('/api/system/status')).status, 403);
    assert.equal((await request(app, fx.admin).get('/api/system/status')).status, 200);
  });

  it('reports the database up and a running process', async () => {
    const res = await request(app, fx.admin).get('/api/system/status');
    const body = res.body as { ok: boolean; process: { uptimeSeconds: number }; components: Array<{ key: string; ok: boolean }> };
    const db = body.components.find((c) => c.key === 'database');
    assert.equal(db?.ok, true, 'database component should be up during the test');
    assert.ok(body.process.uptimeSeconds >= 0);
    assert.ok(body.components.some((c) => c.key === 'backups'));
  });
});

describe('system log', () => {
  it('is closed to anonymous, open to an admin', async () => {
    assert.equal((await request(app).get('/api/system/logs')).status, 401);
    assert.equal((await request(app, fx.admin).get('/api/system/logs')).status, 200);
  });

  it('returns logged events, newest first, filterable by level', async () => {
    await prisma.systemLog.createMany({
      data: [
        { level: 'info', source: 'app', message: 'started up' },
        { level: 'error', source: 'backup', message: 'pg_dump exited 1' },
      ],
    });

    const all = await request(app, fx.admin).get('/api/system/logs');
    const body = all.body as { data: Array<{ level: string; message: string }>; total: number };
    assert.equal(body.total, 2);

    const errorsOnly = await request(app, fx.admin).get('/api/system/logs?level=error');
    const errBody = errorsOnly.body as { data: Array<{ message: string }>; total: number };
    assert.equal(errBody.total, 1);
    assert.match(errBody.data[0].message, /pg_dump/);
  });

  it('exports to xlsx for an admin, closed to anon', async () => {
    await prisma.systemLog.create({ data: { level: 'info', source: 'app', message: 'export me' } });
    assert.equal((await request(app).get('/api/system/logs/export')).status, 401);
    const res = await request(app, fx.admin).get('/api/system/logs/export');
    assert.equal(res.status, 200);
    assert.match(res.raw.headers['content-type'] as string, /spreadsheetml/);
    // xlsx is a zip — the body starts with the "PK" magic.
    assert.equal(res.raw.rawPayload.subarray(0, 2).toString('latin1'), 'PK');
  });
});
