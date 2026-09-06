import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * First-run setup checklist. A fresh install has every company default except the
 * TRN, and nothing else configured; the checklist is what sends an admin through
 * it, lets them skip what can wait, and keeps the rest under the bell until done.
 */
let app: FastifyInstance;
let fx: Fixtures;

type Item = { key: string; label: string; href: string; required: boolean; done: boolean; skipped: boolean };
type Status = { complete: boolean; finished: boolean; items: Item[]; required: Array<{ key: string }>; missing: Array<{ key: string }> };

const status = async () => (await request(app, fx.admin).get('/api/setup/status')).body as Status;
const item = (s: Status, key: string) => s.items.find((i) => i.key === key)!;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetDatabase();
  fx = await seedFixtures(app);
  // The fixtures seed a TRN so the invoice tests can issue; a real install has none.
  await request(app, fx.admin).put('/api/settings', { 'company.trn': '' });
});

describe('first-run setup checklist', () => {
  it('a fresh install: company required and missing the TRN, nothing else configured, not finished', async () => {
    const s = await status();
    assert.equal(s.complete, false);
    assert.equal(s.finished, false);
    assert.ok(s.missing.some((m) => m.key === 'company.trn'), 'TRN should be missing');

    const company = item(s, 'company');
    assert.equal(company.required, true);
    assert.equal(company.done, false);
    assert.equal(company.href, '/settings/company');

    for (const key of ['microsoft365', 'whatsapp', 'teams', 'backups', 'twoFactor']) {
      assert.equal(item(s, key).done, false, `${key} should not be done on a fresh install`);
      assert.equal(item(s, key).required, false, `${key} is optional`);
    }
    // The fixtures create several users, so "invite the team" already counts as done.
    assert.equal(item(s, 'team').done, true);
  });

  it('a TRN that is not 15 digits still counts as missing', async () => {
    await request(app, fx.admin).put('/api/settings', { 'company.trn': '12345', 'company.email': 'ops@example.com', 'company.phone': '+97140000000' });
    const s = await status();
    assert.equal(s.complete, false);
    assert.deepEqual(s.missing.map((m) => m.key), ['company.trn']);
  });

  it('becomes complete once the company values are saved — optional items do not block it', async () => {
    await request(app, fx.admin).put('/api/settings', { 'company.trn': '100000000000003', 'company.email': 'ops@example.com', 'company.phone': '+97140000000' });
    const s = await status();
    assert.equal(s.complete, true, JSON.stringify(s.missing));
    assert.equal(item(s, 'company').done, true);
    assert.equal(item(s, 'microsoft365').done, false);
  });

  it('integrations count once their secret is stored; Teams once a webhook exists', async () => {
    await prisma.integration.create({ data: { provider: 'whatsapp', secrets: 'encrypted-blob', status: 'configured' } });
    await prisma.teamsWebhook.create({ data: { name: 'Sales', url: 'https://example.webhook.office.com/x' } });
    const s = await status();
    assert.equal(item(s, 'whatsapp').done, true);
    assert.equal(item(s, 'teams').done, true);
    assert.equal(item(s, 'microsoft365').done, false);
  });

  it('skip hides an item from the wizard but leaves it undone; unskip restores it', async () => {
    let res = await request(app, fx.admin).post('/api/setup/skip', { key: 'whatsapp' });
    assert.equal(res.status, 200);
    let s = res.body as Status;
    assert.equal(item(s, 'whatsapp').skipped, true);
    assert.equal(item(s, 'whatsapp').done, false);

    res = await request(app, fx.admin).post('/api/setup/skip', { key: 'whatsapp', skipped: false });
    s = res.body as Status;
    assert.equal(item(s, 'whatsapp').skipped, false);

    assert.equal((await request(app, fx.admin).post('/api/setup/skip', { key: 'nonsense' })).status, 400);
  });

  it('finish records the decision and is audited', async () => {
    const res = await request(app, fx.admin).post('/api/setup/finish', {});
    assert.equal(res.status, 200);
    assert.equal((res.body as Status).finished, true);
    const log = await prisma.auditLog.findFirst({ where: { entity: 'Setting', entityId: 'setup.finishedAt' } });
    assert.ok(log, 'finish should leave an audit entry');
  });

  it('is closed to a role that cannot manage settings', async () => {
    assert.equal((await request(app, fx.rep).get('/api/setup/status')).status, 403);
    assert.equal((await request(app, fx.rep).post('/api/setup/skip', { key: 'whatsapp' })).status, 403);
    assert.equal((await request(app, fx.rep).post('/api/setup/finish', {})).status, 403);
    assert.equal((await request(app).get('/api/setup/status')).status, 401);
  });
});
