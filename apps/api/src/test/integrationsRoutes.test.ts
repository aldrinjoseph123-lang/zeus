import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

// Point backups at a throwaway dir before anything reads env, so this test never
// writes into (or prunes) the real backup directory.
process.env.BACKUP_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-bkp-'));

const { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } = await import('./harness.js');
const { MODULES } = await import('../auth/rbac.js');
const { runBackup } = await import('../services/backup.js');

let app: FastifyInstance;
let fx: Awaited<ReturnType<typeof seedFixtures>>;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

const NO_ACCESS = { read: 'none', create: false, update: 'none', delete: 'none', export: false, approve: false } as const;

/** A role with `backups:update` but deliberately not `backups:delete` — none of the
 * four system roles carry that specific split (Administrator has both, everyone else
 * has neither), so the elevated-restore gate has no fixture to exercise it without
 * building one. */
async function makeBackupOperator() {
  const role = await prisma.role.create({
    data: {
      name: 'Backup Operator',
      permissions: {
        ...Object.fromEntries(MODULES.map((m) => [m, NO_ACCESS])),
        backups: { read: 'all', create: true, update: 'all', delete: 'none', export: true, approve: false },
      } as never,
    },
  });
  const { signSessionToken, SESSION_COOKIE } = await import('../auth/session.js');
  const user = await prisma.user.create({
    data: { email: 'operator@test.local', name: 'Backup Operator', passwordHash: await bcrypt.hash('x', 4), roleId: role.id },
  });
  const token = await signSessionToken(user.id, 12);
  return { id: user.id, email: user.email, name: user.name, roleName: role.name, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('backups routes — permission gating', () => {
  it('rejects a rep and a manager at every tier; an admin gets through', async () => {
    for (const user of [fx.rep, fx.manager]) {
      assert.equal((await request(app, user).get('/api/backups')).status, 403);
      assert.equal((await request(app, user).post('/api/backups/run', { kind: 'config', uploadToOneDrive: false })).status, 403);
      assert.equal((await request(app, user).post('/api/backups/validate', {})).status, 403);
      assert.equal((await request(app, user).post('/api/backups/verify', {})).status, 403);
    }
    assert.equal((await request(app, fx.admin).get('/api/backups')).status, 200);
  });

  it('lets a rep-tier role with backups:read run Validate but not Verify', async () => {
    const operator = await makeBackupOperator();
    assert.equal((await request(app, operator).post('/api/backups/validate', {})).status, 200);
    assert.equal((await request(app, operator).post('/api/backups/verify', {})).status, 403, 'Verify needs backups:delete specifically');
  });
});

describe('POST /api/backups/run — validation and audit', () => {
  it('rejects an invalid kind rather than defaulting silently', async () => {
    const res = await request(app, fx.admin).post('/api/backups/run', { kind: 'not-a-real-kind', uploadToOneDrive: false });
    assert.equal(res.status, 400);
  });

  it('runs, and writes an audit row naming the backup it made', async () => {
    const res = await request(app, fx.admin).post('/api/backups/run', { kind: 'config', uploadToOneDrive: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.filename);

    const entry = await prisma.auditLog.findFirst({ where: { action: 'backup', entityId: res.body.id } });
    assert.ok(entry, 'the route itself audits the run, not just the service');
    assert.equal(entry?.summary, res.body.filename);
  });
});

describe('POST /api/backups/:id/restore — the financial-model elevation gate', () => {
  async function seedLogicalBackup() {
    const run = await runBackup({ kind: 'logical', uploadToOneDrive: false });
    return run.id;
  }

  it('a role with only backups:update can preview and restore an ordinary module', async () => {
    const operator = await makeBackupOperator();
    const backupId = await seedLogicalBackup();

    const preview = await request(app, operator).post(`/api/backups/${backupId}/restore`, { models: ['account'] });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.applied, false);
  });

  it('the same role is refused the moment invoice or purchaseOrder is in the model list', async () => {
    const operator = await makeBackupOperator();
    const backupId = await seedLogicalBackup();

    const res = await request(app, operator).post(`/api/backups/${backupId}/restore`, { models: ['account', 'invoice'] });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /privileged/i);
  });

  it('an admin (who also has backups:delete) is allowed through the same request', async () => {
    const backupId = await seedLogicalBackup();
    const res = await request(app, fx.admin).post(`/api/backups/${backupId}/restore`, { models: ['account', 'invoice'] });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  it('requires at least one module', async () => {
    const backupId = await seedLogicalBackup();
    const res = await request(app, fx.admin).post(`/api/backups/${backupId}/restore`, { models: [] });
    assert.equal(res.status, 400);
  });
});

describe('POST /api/backups/:id/parity — route wiring', () => {
  it('reaches the real parity check and audits it', async () => {
    const run = await runBackup({ kind: 'config', uploadToOneDrive: false });
    const res = await request(app, fx.admin).post(`/api/backups/${run.id}/parity`, {});
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, JSON.stringify(res.body));

    const entry = await prisma.auditLog.findFirst({ where: { action: 'integration', entityId: run.id, summary: { contains: 'parity' } } });
    assert.ok(entry);
  });
});

describe('integrations routes — permission gating and validation', () => {
  it('closes microsoft365 and whatsapp config to a rep', async () => {
    assert.equal((await request(app, fx.rep).get('/api/integrations/microsoft365')).status, 403);
    assert.equal((await request(app, fx.rep).put('/api/integrations/microsoft365', { tenantId: 't', clientId: 'c' })).status, 403);
    assert.equal((await request(app, fx.rep).get('/api/integrations/whatsapp')).status, 403);
  });

  it('rejects saving microsoft365 config with a required field missing', async () => {
    const res = await request(app, fx.admin).put('/api/integrations/microsoft365', { tenantId: '' });
    assert.equal(res.status, 400);
  });

  it('reports a health heartbeat for every integration without crashing', async () => {
    const res = await request(app, fx.admin).get('/api/integrations/health');
    assert.equal(res.status, 200);
    const providers = (res.body as Array<{ provider: string }>).map((p) => p.provider);
    assert.ok(providers.includes('microsoft365'));
    assert.ok(providers.includes('whatsapp'));
    assert.ok(providers.includes('webhooks'));
  });
});
