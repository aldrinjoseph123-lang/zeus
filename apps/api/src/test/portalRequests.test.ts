import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';
import { saveTurnstile, verifyTurnstile } from '../portal/requests.js';

/**
 * Request access: the portal's one public write. The answer never varies; the row is
 * quarantine, never a contact; the admin matches it to a contact sales created, or
 * rejects it and it is gone. Turnstile, when configured, silently drops the unverified.
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

const id = (res: { body: unknown }) => (res.body as { id: string }).id;

describe('request access: the public form', () => {
  it('answers identically for any address and never creates a contact or account', async () => {
    const before = { contacts: await prisma.contact.count(), accounts: await prisma.account.count() };
    const a = await request(app).post('/api/access-requests', { email: 'unknown@nowhere.example', company: 'Nowhere Ltd', note: 'Please let me in' });
    const b = await request(app).post('/api/access-requests', { email: fx.rep.email, company: 'Protect24x7' });
    const c = await request(app).post('/api/access-requests', { email: 'not-an-email', company: '' });
    assert.equal(a.status, 200); assert.deepEqual(a.body, b.body); assert.deepEqual(a.body, c.body);

    assert.equal(await prisma.contact.count(), before.contacts, 'no contact created');
    assert.equal(await prisma.account.count(), before.accounts, 'no account created');
    const rows = await prisma.accessRequest.findMany();
    assert.equal(rows.length, 2, 'the two well-formed requests were quarantined; the malformed one was not');
    assert.equal(rows.find((r) => r.email === 'unknown@nowhere.example')?.note, 'Please let me in');
  });

  it('the same address asking twice in a day is stored once', async () => {
    await request(app).post('/api/access-requests', { email: 'Twice@example.com', company: 'Twice' });
    await request(app).post('/api/access-requests', { email: 'twice@example.com', company: 'Twice again' });
    assert.equal(await prisma.accessRequest.count(), 1);
  });

  it('notifies administrators that someone asked', async () => {
    await request(app).post('/api/access-requests', { email: 'asker@example.com', company: 'Asker LLC' });
    const n = await prisma.notification.findFirst({ where: { type: 'portal_access_requested' } });
    assert.ok(n, 'admins get a notification');
    assert.match(n.title, /Asker LLC/);
    assert.equal(n.link?.endsWith('/settings/portal'), true);
  });

  it('with Turnstile configured, a request without a verified token is dropped — same answer', async () => {
    await saveTurnstile('site-key', 'secret-key');
    assert.deepEqual((await request(app).get('/api/access-requests/config')).body, { turnstileSiteKey: 'site-key' });
    const res = await request(app).post('/api/access-requests', { email: 'bot@example.com', company: 'Bots' });
    assert.equal(res.status, 200);
    assert.equal(await prisma.accessRequest.count(), 0, 'nothing stored without a token');

    // The verifier itself, with Cloudflare stubbed out. Three outcomes, not two: being
    // told no and being unable to ask are different facts, and only one of them is the
    // visitor's doing.
    const okFetch = (async () => new Response(JSON.stringify({ success: true }))) as unknown as typeof fetch;
    const badFetch = (async () => new Response(JSON.stringify({ success: false }))) as unknown as typeof fetch;
    assert.equal(await verifyTurnstile('tok', '1.2.3.4', okFetch), 'ok');
    assert.equal(await verifyTurnstile('tok', '1.2.3.4', badFetch), 'rejected');
    assert.equal(await verifyTurnstile('', '1.2.3.4', okFetch), 'rejected', 'no token is a refusal, not an outage');
    assert.equal(await verifyTurnstile('tok', null, (async () => { throw new Error('network'); }) as unknown as typeof fetch), 'unavailable');
    assert.equal(await verifyTurnstile('tok', null, (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch), 'unavailable');
  });
});

describe('request access: the admin queue', () => {
  it('match grants exactly as the Grant button does and closes the request; reject deletes', async () => {
    await request(app).post('/api/access-requests', { email: 'pat@partner.example', company: 'Channel Partner LLC' });
    await request(app).post('/api/access-requests', { email: 'nobody@spam.example', company: 'Spam Co' });
    const queue = (await request(app, fx.admin).get('/api/portal-admin/requests')).body as Array<{ id: string; email: string }>;
    assert.equal(queue.length, 2);
    const patReq = queue.find((r) => r.email === 'pat@partner.example')!;
    const spamReq = queue.find((r) => r.email === 'nobody@spam.example')!;

    // Sales created the partner and the contact; the admin matches the request to that contact.
    const account = await request(app, fx.admin).post('/api/accounts', { name: 'Channel Partner LLC', type: 'PARTNER', ignoreDuplicates: true });
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'Pat', lastName: 'Partner', email: 'pat@partner.example', accountId: id(account), ignoreDuplicates: true });
    const matched = await request(app, fx.admin).post(`/api/portal-admin/requests/${patReq.id}/match`, { contactId: id(contact) });
    assert.equal(matched.status, 201, JSON.stringify(matched.body));
    assert.equal((matched.body as { email: string }).email, 'pat@partner.example');
    assert.ok(await prisma.portalUser.findUnique({ where: { email: 'pat@partner.example' } }), 'portal user created');
    assert.equal((await prisma.accessRequest.findUniqueOrThrow({ where: { id: patReq.id } })).status, 'MATCHED');

    assert.equal((await request(app, fx.admin).post(`/api/portal-admin/requests/${spamReq.id}/reject`, {})).status, 200);
    assert.equal(await prisma.accessRequest.findUnique({ where: { id: spamReq.id } }), null, 'rejected rows are gone');
    assert.equal(((await request(app, fx.admin).get('/api/portal-admin/requests')).body as unknown[]).length, 0);
  });

  it('matching enforces the same rules as granting, and is closed to other roles', async () => {
    await request(app).post('/api/access-requests', { email: 'x@example.com', company: 'X' });
    const [req] = (await request(app, fx.admin).get('/api/portal-admin/requests')).body as Array<{ id: string }>;
    const prospect = await request(app, fx.admin).post('/api/accounts', { name: 'Prospect Co', type: 'PROSPECT', ignoreDuplicates: true });
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'X', lastName: 'Y', email: 'x@example.com', accountId: id(prospect), ignoreDuplicates: true });
    assert.equal((await request(app, fx.admin).post(`/api/portal-admin/requests/${req.id}/match`, { contactId: id(contact) })).status, 400, 'a prospect cannot be granted');
    assert.equal((await request(app, fx.rep).get('/api/portal-admin/requests')).status, 403);
    assert.equal((await request(app, fx.rep).post(`/api/portal-admin/requests/${req.id}/reject`, {})).status, 403);
    assert.equal((await request(app, fx.rep).put('/api/portal-admin/turnstile', { siteKey: 'k' })).status, 403);
  });
});
