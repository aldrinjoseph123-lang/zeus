import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';
import { setSetting, invalidateSettings } from '../lib/settings.js';

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

describe('account lockout', () => {
  it('blocks a login after too many recent failures, even with the right password', async () => {
    await setSetting('auth.lockoutThreshold', 3);
    invalidateSettings();

    for (let i = 0; i < 3; i++) {
      const attempt = await request(app).post('/api/auth/login', { email: fx.admin.email, password: 'wrong' });
      assert.equal(attempt.status, 401);
    }

    const locked = await request(app).post('/api/auth/login', { email: fx.admin.email, password: 'Passw0rd!Test' });
    assert.equal(locked.status, 429);
    assert.match(locked.body.error as string, /too many failed attempts/i);
  });

  it('leaves a clean account alone', async () => {
    const ok = await request(app).post('/api/auth/login', { email: fx.admin.email, password: 'Passw0rd!Test' });
    assert.equal(ok.status, 200);
  });
});

describe('2FA required for elevated roles', () => {
  it('does nothing while the setting is off', async () => {
    const res = await request(app, fx.admin).post('/api/accounts', { name: 'Off by default' });
    assert.equal(res.status, 201);
  });

  it('blocks writes for an admin without 2FA once switched on, but leaves reads and setup open', async () => {
    await setSetting('auth.require2faForManagers', true);
    invalidateSettings();

    const blocked = await request(app, fx.admin).post('/api/accounts', { name: 'Should be blocked' });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error as string, /two-factor/i);

    const read = await request(app, fx.admin).get('/api/accounts');
    assert.equal(read.status, 200);

    const enrol = await request(app, fx.admin).post('/api/auth/2fa/enrol', {});
    assert.notEqual(enrol.status, 403);
  });

  it('lets an admin with 2FA enrolled through', async () => {
    await setSetting('auth.require2faForManagers', true);
    invalidateSettings();
    await prisma.user.update({ where: { id: fx.admin.id }, data: { totpEnabledAt: new Date(), totpSecret: 'x' } });

    const res = await request(app, fx.admin).post('/api/accounts', { name: 'Fine now' });
    assert.equal(res.status, 201);
  });

  it('never touches a rep — the rule is scoped to Administrator and Sales Manager', async () => {
    await setSetting('auth.require2faForManagers', true);
    invalidateSettings();

    const res = await request(app, fx.rep).post('/api/accounts', { name: 'Reps are unaffected' });
    assert.equal(res.status, 201);
  });
});
