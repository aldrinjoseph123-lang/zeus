import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * Teams webhook URLs. Microsoft moved Workflow webhooks to *.powerplatform.com in
 * 2025 and the first production admin hit "does not look like a Teams webhook URL"
 * on a perfectly good one. The check is on the hostname: a query string that
 * happens to contain "office.com" is not a Microsoft host.
 */
let app: FastifyInstance;
let fx: Fixtures;

const POWER_AUTOMATE = 'https://default1234abcd.ae.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/12b182ab2dbe4d04bdf264f0efa24f7d/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=abc';

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

describe('Teams webhook URL validation', () => {
  it('accepts a current Power Automate workflow URL and the older hosts', async () => {
    for (const [name, url] of [
      ['Power Automate', POWER_AUTOMATE],
      ['Logic Apps', 'https://prod-12.westeurope.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?sig=x'],
      ['legacy connector', 'https://contoso.webhook.office.com/webhookb2/abc'],
    ]) {
      const res = await request(app, fx.admin).post('/api/teams-webhooks', { name, url });
      assert.equal(res.status, 201, `${name}: ${JSON.stringify(res.body)}`);
    }
  });

  it('rejects a foreign host even when the URL mentions office.com elsewhere', async () => {
    for (const url of [
      'https://evil.example/hook?redirect=office.com',
      'https://office.com.evil.example/hook',
      'https://example.com/webhooks/teams',
    ]) {
      const res = await request(app, fx.admin).post('/api/teams-webhooks', { name: 'x', url });
      assert.equal(res.status, 400, `${url} should be refused`);
      assert.match(String((res.body as { error: string }).error), /Teams webhook URL/);
    }
  });

  it('is closed to a role that cannot manage settings', async () => {
    assert.equal((await request(app, fx.rep).post('/api/teams-webhooks', { name: 'x', url: POWER_AUTOMATE })).status, 403);
  });
});
