import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase } from './harness.js';
import { env } from '../env.js';

/**
 * One container, two front doors. The internal app answers on APP_URL's host, the
 * portal on PORTAL_URL's — including the bare root, which the static plugin used to
 * answer itself with the wrong index. On the portal host the internal bundle is
 * withheld outright.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const built = existsSync(path.resolve(here, '../../../web/dist/index.html')) && existsSync(path.resolve(here, '../../../portal/dist/index.html'));

let app: FastifyInstance;
before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });

describe('static serving by host', { skip: !built && 'web/portal dist not built' }, () => {
  const portalHost = new URL(env.PORTAL_URL).host;
  const get = (url: string, host?: string) => app.inject({ method: 'GET', url, headers: host ? { host } : {} });

  it('the internal host gets the internal index at / and on deep links', async () => {
    for (const url of ['/', '/accounts/some-id', '/settings/portal']) {
      const r = await get(url);
      assert.equal(r.statusCode, 200, url);
      assert.match(r.body, /<title>Zeus/, url);
    }
  });

  it('the portal host gets the portal index at / and on deep links', async () => {
    for (const url of ['/', '/sign-in', '/request-access']) {
      const r = await get(url, portalHost);
      assert.equal(r.statusCode, 200, url);
      assert.match(r.body, /<title>Protect24x7 Portal/, url);
      assert.doesNotMatch(r.body, /<title>Zeus/, `${url} must not be the internal app`);
    }
  });

  it('the portal host withholds the internal bundle', async () => {
    assert.equal((await get('/index.html', portalHost)).statusCode, 404);
    assert.equal((await get('/assets/anything.js', portalHost)).statusCode, 404);
    // Unknown API paths hit the auth gate before the not-found handler: 401, never an index.
    assert.equal((await get('/api/nope', portalHost)).statusCode, 401);
  });
});
