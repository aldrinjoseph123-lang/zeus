import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';

/**
 * The email log. Written by sendMail itself, so the guarantee under test is that a
 * send — successful or not — cannot happen without a row. Status says only what Graph
 * reports: it accepted the message, or it refused it.
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

/**
 * Configure a sending mailbox and answer for Microsoft, so nothing leaves the machine.
 * Stubbing fetch rather than a module export keeps graph.ts's own surface unchanged:
 * the token call and the sendMail call are the only two requests it makes.
 */
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

async function withGraph(response: { ok: boolean; status?: number; body?: string }) {
  const { saveM365, resetTokenCache } = await import('../services/graph.js');
  await saveM365({ tenantId: 't', clientId: 'c', senderUpn: 'zeus@example.com' } as never, 'secret');
  resetTokenCache(); // the stub hands out a different token each time it is installed
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('login.microsoftonline.com')) {
      return new Response(JSON.stringify({ access_token: 'test-token', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(response.body ?? '', { status: response.status ?? (response.ok ? 202 : 500) });
  }) as typeof fetch;
}

const send = async (over: Record<string, unknown> = {}) => {
  const { sendMail } = await import('../services/graph.js');
  return sendMail({ to: ['buyer@example.com'], subject: 'Quotation ZEU-Q-1', html: '<p>Hello <b>there</b>, your quote is attached.</p>', log: { kind: 'quote', entity: 'Quote', entityId: 'q1', userId: fx.admin.id }, ...over } as never);
};

describe('email log: every send is recorded', () => {
  it('records an accepted send with a readable preview and no stored body', async () => {
    await withGraph({ ok: true });
    await send();

    const row = await prisma.emailLog.findFirstOrThrow();
    assert.equal(row.status, 'SENT');
    assert.deepEqual(row.to, ['buyer@example.com']);
    assert.equal(row.subject, 'Quotation ZEU-Q-1');
    assert.equal(row.preview, 'Hello there, your quote is attached.', 'tags stripped, whitespace collapsed');
    assert.equal(row.kind, 'quote');
    assert.equal(row.entityId, 'q1');
    assert.equal(row.userId, fx.admin.id);
    assert.equal(row.error, null);
    assert.equal(row.payload, null, 'a success keeps no copy of the message');
  });

  it('records a refusal with the reason, keeps the message, and still throws', async () => {
    await withGraph({ ok: false, status: 403, body: 'ErrorAccessDenied' });
    await assert.rejects(() => send({ attachments: [{ filename: 'quote.pdf', contentBytes: 'AAA', contentType: 'application/pdf' }] }), /403/);

    const row = await prisma.emailLog.findFirstOrThrow();
    assert.equal(row.status, 'FAILED');
    assert.match(String(row.error), /403.*ErrorAccessDenied/s);
    assert.deepEqual(row.attachments, ['quote.pdf']);
    const payload = row.payload as { html: string; attachments: unknown[] };
    assert.match(payload.html, /your quote is attached/, 'a failure keeps the message so it can be replayed');
    assert.equal(payload.attachments.length, 1);
  });

  it('records the send that never left because no mailbox is configured', async () => {
    await assert.rejects(() => send(), /sender mailbox/i);
    const row = await prisma.emailLog.findFirstOrThrow();
    assert.equal(row.status, 'FAILED');
    assert.match(String(row.error), /sender mailbox/i);
  });
});

describe('email log: the screen behind it', () => {
  it('lists newest first, filters, searches, and counts', async () => {
    await withGraph({ ok: true });
    await send({ subject: 'Quotation ZEU-Q-1', to: ['buyer@example.com'] });
    await send({ subject: 'Invoice ZEU-INV-9', to: ['ap@other.example'], log: { kind: 'invoice', entity: 'Invoice', entityId: 'i1' } });
    await withGraph({ ok: false, status: 500, body: 'boom' });
    await assert.rejects(() => send({ subject: 'Portal link', to: ['pat@partner.example'], log: { kind: 'portal_link' } }));

    const all = (await request(app, fx.admin).get('/api/email-log')).body as { data: Array<{ subject: string; status: string; user: { name: string } | null }>; total: number };
    assert.equal(all.total, 3);
    assert.equal(all.data[0].subject, 'Portal link', 'newest first');

    const failed = (await request(app, fx.admin).get('/api/email-log?status=FAILED')).body as { total: number };
    assert.equal(failed.total, 1);
    const invoices = (await request(app, fx.admin).get('/api/email-log?kind=invoice')).body as { total: number };
    assert.equal(invoices.total, 1);
    const search = (await request(app, fx.admin).get('/api/email-log?search=ap@other.example')).body as { total: number };
    assert.equal(search.total, 1, 'search finds a recipient');

    const summary = (await request(app, fx.admin).get('/api/email-log/summary')).body as { last30: { sent: number; failed: number }; total: number };
    assert.deepEqual(summary.last30, { sent: 2, failed: 1 });
    assert.equal(summary.total, 3);
  });

  it('replays a failure exactly, then stops keeping the copy', async () => {
    await withGraph({ ok: false, status: 500, body: 'boom' });
    await assert.rejects(() => send());
    const failed = await prisma.emailLog.findFirstOrThrow();
    assert.equal(((await request(app, fx.admin).get(`/api/email-log/${failed.id}`)).body as { canResend: boolean }).canResend, true);

    await withGraph({ ok: true });
    assert.equal((await request(app, fx.admin).post(`/api/email-log/${failed.id}/resend`, {})).status, 200);

    const rows = await prisma.emailLog.findMany({ orderBy: { createdAt: 'asc' } });
    assert.equal(rows.length, 2, 'the failure stays; the resend is its own row');
    assert.equal(rows[0].status, 'FAILED');
    assert.equal(rows[0].payload, null, 'the copy is dropped once it goes');
    assert.equal(rows[1].status, 'SENT');
    assert.equal(rows[1].resentFromId, failed.id);
    assert.equal(rows[1].subject, failed.subject);

    assert.equal((await request(app, fx.admin).post(`/api/email-log/${failed.id}/resend`, {})).status, 400, 'nothing left to replay');
  });

  it('is closed to a rep, and a successful send cannot be resent', async () => {
    await withGraph({ ok: true });
    await send();
    const row = await prisma.emailLog.findFirstOrThrow();
    assert.equal((await request(app, fx.rep).get('/api/email-log')).status, 403);
    assert.equal((await request(app, fx.rep).post(`/api/email-log/${row.id}/resend`, {})).status, 403);
    assert.equal((await request(app, fx.admin).post(`/api/email-log/${row.id}/resend`, {})).status, 400, 'only failures replay');
  });
});
