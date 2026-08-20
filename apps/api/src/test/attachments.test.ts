import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

// Point uploads at a throwaway dir before anything reads env, so this test never
// writes into (or leaves files in) the real uploads directory.
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-uploads-'));

const { migrateTestDatabase, prisma, resetDatabase, seedFixtures } = await import('./harness.js');

let app: FastifyInstance;
let fx: Awaited<ReturnType<typeof seedFixtures>>;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

/** Hand-built multipart body — `parent`/`parentId` fields before the file part,
 * matching what the route (and any real browser FormData) sends: @fastify/multipart's
 * `request.file()` only sees field parts that arrive before the file in the stream. */
function multipartBody(fields: Record<string, string>, file: { name: string; content: Buffer; mimeType?: string }) {
  const boundary = `ZeusTestBoundary${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mimeType ?? 'application/octet-stream'}\r\n\r\n`,
  ));
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

async function upload(user: { cookie: string }, fields: Record<string, string>, file: { name: string; content: Buffer; mimeType?: string }) {
  const { body, boundary } = multipartBody(fields, file);
  const res = await app.inject({
    method: 'POST', url: '/api/attachments',
    headers: { cookie: user.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  let json: unknown = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = res.body; }
  return { status: res.statusCode, body: json as Record<string, unknown> };
}

const uploadDir = () => process.env.UPLOAD_DIR!;

describe('attachment upload', () => {
  it('stores a file on disk and links it to the parent account', async () => {
    const content = Buffer.from('hello from a real attachment test');
    const res = await upload(fx.rep, { parent: 'account', parentId: fx.customer.id }, { name: 'notes.txt', content, mimeType: 'text/plain' });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.filename, 'notes.txt');
    assert.equal(res.body.sizeBytes, content.byteLength);
    assert.equal(res.body.accountId, fx.customer.id);

    const onDisk = readFileSync(path.join(uploadDir(), res.body.storedName as string));
    assert.deepEqual(onDisk, content, 'the exact bytes uploaded are what land on disk');
  });

  it('strips a path from the filename — never stores anywhere but UPLOAD_DIR', async () => {
    const res = await upload(fx.rep, { parent: 'account', parentId: fx.customer.id }, { name: '../../etc/passwd', content: Buffer.from('x') });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.filename, 'passwd', 'basename only, the traversal is stripped');

    const filesOnDisk = readdirSync(uploadDir());
    assert.ok(filesOnDisk.every((f) => !f.includes('..') && !f.includes('/')), 'nothing escaped the upload directory');
  });

  it('refuses a blocked executable extension and leaves nothing behind', async () => {
    const before = readdirSync(uploadDir()).length;
    const res = await upload(fx.rep, { parent: 'account', parentId: fx.customer.id }, { name: 'installer.exe', content: Buffer.from('MZ') });
    assert.equal(res.status, 400);
    assert.match(res.body.error as string, /\.exe/);
    assert.equal(await prisma.attachment.count(), 0);
    assert.equal(readdirSync(uploadDir()).length, before, 'no orphan file written');
  });

  it('refuses an empty file', async () => {
    const res = await upload(fx.rep, { parent: 'account', parentId: fx.customer.id }, { name: 'empty.txt', content: Buffer.alloc(0) });
    assert.equal(res.status, 400);
    assert.match(res.body.error as string, /empty/i);
    assert.equal(await prisma.attachment.count(), 0);
  });

  it('refuses a file over the 20 MB limit', async () => {
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1024);
    const res = await upload(fx.rep, { parent: 'account', parentId: fx.customer.id }, { name: 'huge.bin', content: oversized });
    assert.equal(res.status, 400);
    assert.match(res.body.error as string, /20 MB/);
    assert.equal(await prisma.attachment.count(), 0);
  });

  it('requires parent and parentId', async () => {
    const noParent = await upload(fx.rep, { parentId: fx.customer.id }, { name: 'a.txt', content: Buffer.from('x') });
    assert.equal(noParent.status, 400);

    const noParentId = await upload(fx.rep, { parent: 'account' }, { name: 'a.txt', content: Buffer.from('x') });
    assert.equal(noParentId.status, 400);
  });

  it('404s when the parent record does not exist', async () => {
    const res = await upload(fx.rep, { parent: 'account', parentId: 'not-a-real-id' }, { name: 'a.txt', content: Buffer.from('x') });
    assert.equal(res.status, 404);
  });

  it('is owner-scoped — a rep cannot attach to a deal they do not own', async () => {
    const deal = await prisma.deal.create({
      data: {
        reference: `T-${Math.random().toString(36).slice(2, 8)}`, name: 'Not the rep\'s deal', accountId: fx.customer.id,
        pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id, amount: 1000, cost: 500,
        vatRate: 5, vatAmount: 50, totalAmount: 1050, probability: 10,
        closeDate: new Date(Date.now() + 30 * 86_400_000), ownerId: fx.otherRep.id,
      },
    });
    const res = await upload(fx.rep, { parent: 'deal', parentId: deal.id }, { name: 'a.txt', content: Buffer.from('x') });
    assert.equal(res.status, 403);
  });
});

describe('attachment list, download, delete', () => {
  async function uploaded() {
    const res = await upload(fx.rep, { parent: 'account', parentId: fx.customer.id }, { name: 'report.pdf', content: Buffer.from('%PDF-1.4 fake'), mimeType: 'application/pdf' });
    return res.body as { id: string; storedName: string; filename: string };
  }

  it('lists attachments for the parent, newest first', async () => {
    await uploaded();
    const res = await app.inject({ method: 'GET', url: `/api/attachments?parent=account&parentId=${fx.customer.id}`, headers: { cookie: fx.rep.cookie } });
    assert.equal(res.statusCode, 200);
    const list = JSON.parse(res.body) as Array<{ filename: string }>;
    assert.equal(list.length, 1);
    assert.equal(list[0].filename, 'report.pdf');
  });

  it('downloads with nosniff and a forced content-disposition', async () => {
    const attachment = await uploaded();
    const res = await app.inject({ method: 'GET', url: `/api/attachments/${attachment.id}/download`, headers: { cookie: fx.rep.cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.match(String(res.headers['content-disposition']), /attachment; filename="report\.pdf"/);
    assert.equal(res.body, '%PDF-1.4 fake');
  });

  it('404s a download whose file is missing from disk', async () => {
    const attachment = await uploaded();
    rmSync(path.join(uploadDir(), attachment.storedName), { force: true });
    const res = await app.inject({ method: 'GET', url: `/api/attachments/${attachment.id}/download`, headers: { cookie: fx.rep.cookie } });
    assert.equal(res.statusCode, 404);
  });

  it('deletes both the database row and the file on disk', async () => {
    const attachment = await uploaded();
    const filePath = path.join(uploadDir(), attachment.storedName);
    assert.ok(existsSync(filePath));

    const res = await app.inject({ method: 'DELETE', url: `/api/attachments/${attachment.id}`, headers: { cookie: fx.rep.cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(await prisma.attachment.findUnique({ where: { id: attachment.id } }), null);
    assert.equal(existsSync(filePath), false);
  });
});
