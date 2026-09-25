import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * A customer accepting a quotation from the link in the email. The link must show the
 * sell side and nothing else, record who clicked and when, refuse a second click, and
 * die with the quote's validity — and staff acceptance must go on working beside it.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

/** A quote a customer may be handed: created, then signed off, as sending requires. */
const newQuote = async () => {
  const quote = (await request(app, fx.admin).post('/api/quotes', {
    accountId: fx.customer.id, lines: [{ description: 'Firewall support, one year', quantity: 1, unitPrice: 1000 }],
  })).body as { id: string; number: string };
  await request(app, fx.admin).post(`/api/approvals/quotes/${quote.id}/submit`, {});
  await request(app, fx.admin).post(`/api/approvals/quotes/${quote.id}/approve`, {});
  return quote;
};
const linkFor = async (id: string) => (await request(app, fx.admin).post(`/api/quotes/${id}/accept-link`, {})) as { status: number; body: { url: string; expiresAt: string } };
const tokenOf = (url: string) => url.split('/q/')[1];
const anon = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) }).then((r) => ({ status: r.statusCode, body: r.json() as Record<string, unknown> }));

describe('accepting a quotation from its link', () => {
  it('issues one link per quote, shows the customer the sell side only, and records the click', async () => {
    const quote = await newQuote();
    const link = await linkFor(quote.id);
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.match(link.body.url, /\/q\/[0-9a-f]{64}$/);
    assert.equal((await linkFor(quote.id)).body.url, link.body.url, 'asking again hands out the same link, so the emailed one keeps working');
    const token = tokenOf(link.body.url);

    const shown = await anon('GET', `/api/public/quotes/${token}`);
    assert.equal(shown.status, 200, 'no session needed');
    assert.equal(shown.body.number, quote.number);
    assert.equal(shown.body.customer, 'Test Customer LLC');
    assert.deepEqual([shown.body.total, shown.body.linkExpired], [1050, false]);
    assert.equal((shown.body.lines as Array<{ lineTotal: number }>)[0].lineTotal, 1000);
    const text = JSON.stringify(shown.body);
    for (const secret of ['totalCost', 'marginAmount', 'unitCost', 'vendorUnitCost', 'markupPct', 'defaultMarkupPct', 'fxRate']) assert.ok(!text.includes(secret), `${secret} is not for the customer`);

    const pdf = await app.inject({ method: 'GET', url: `/api/public/quotes/${token}/pdf` });
    assert.equal(pdf.statusCode, 200);
    assert.match(pdf.headers['content-type'] as string, /application\/pdf/);

    const click = await anon('POST', `/api/public/quotes/${token}/accept`, { name: 'Fatima Al Hashimi', email: 'fatima@testcustomer.ae' });
    assert.equal(click.status, 200, JSON.stringify(click.body));
    const after = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    assert.equal(after.status, 'ACCEPTED');
    assert.deepEqual([after.acceptedByName, after.acceptedByEmail], ['Fatima Al Hashimi', 'fatima@testcustomer.ae']);
    assert.ok(after.acceptedAt && after.acceptedFromIp, 'when and from where');
    const trail = await prisma.auditLog.findFirst({ where: { entity: 'Quote', entityId: quote.id, summary: { contains: 'accepted online' } } });
    assert.ok(trail, 'the click is in the audit trail');
    assert.equal(await prisma.activity.count({ where: { accountId: fx.customer.id, subject: { contains: 'accepted online' } } }), 1, 'and on the timeline');

    const again = await anon('POST', `/api/public/quotes/${token}/accept`, { name: 'Someone Else', email: 'else@testcustomer.ae' });
    assert.equal(again.status, 409);
    assert.match(String(again.body.error), /already accepted by Fatima Al Hashimi/);
    assert.equal((await linkFor(quote.id)).status, 400, 'no new link for an accepted quote');
    assert.equal((await anon('GET', `/api/public/quotes/${token}`)).body.acceptedByName, 'Fatima Al Hashimi', 'the page can still say who did');
  });

  it('refuses a link that is not valid, has expired, or points at a quote no longer open', async () => {
    assert.equal((await anon('GET', '/api/public/quotes/not-a-token')).status, 404);
    assert.equal((await anon('GET', `/api/public/quotes/${'0'.repeat(64)}`)).status, 404);

    const stale = await newQuote();
    const token = tokenOf((await linkFor(stale.id)).body.url);
    await prisma.quote.update({ where: { id: stale.id }, data: { acceptTokenExpiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await anon('GET', `/api/public/quotes/${token}`)).body.linkExpired, true);
    assert.equal((await anon('POST', `/api/public/quotes/${token}/accept`, { name: 'Late Customer', email: 'late@testcustomer.ae' })).status, 410);

    const rejected = await newQuote();
    const rtoken = tokenOf((await linkFor(rejected.id)).body.url);
    await request(app, fx.admin).post(`/api/quotes/${rejected.id}/status`, { status: 'REJECTED' });
    const res = await anon('POST', `/api/public/quotes/${rtoken}/accept`, { name: 'Changed Mind', email: 'mind@testcustomer.ae' });
    assert.equal(res.status, 409);
    assert.match(String(res.body.error), /rejected/);

    assert.equal((await anon('POST', `/api/public/quotes/${rtoken}/accept`, { name: 'X', email: 'nope' })).status, 400, 'a name and a real address are required');
    assert.equal((await app.inject({ method: 'GET', url: '/api/quotes' })).statusCode, 401, 'the public prefix opens nothing else');
  });

  it('leaves staff acceptance as it was', async () => {
    const quote = await newQuote();
    const res = await request(app, fx.admin).post(`/api/quotes/${quote.id}/status`, { status: 'ACCEPTED' });
    assert.equal(res.status, 200);
    const after = await prisma.quote.findUniqueOrThrow({ where: { id: quote.id } });
    assert.equal(after.status, 'ACCEPTED');
    assert.ok(after.acceptedAt);
    assert.equal(after.acceptedByName, null, 'a phone call has no clicker');
  });
});
