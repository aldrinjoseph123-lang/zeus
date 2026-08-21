import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

// Uploaded spreadsheets are written to UPLOAD_DIR and re-read on every run, so point
// it at a throwaway directory before anything reads env.
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-imports-'));

const { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } = await import('./harness.js');

let app: FastifyInstance;
let fx: Awaited<ReturnType<typeof seedFixtures>>;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

/** Same hand-built multipart shape attachments.test.ts uses — field parts first, then
 * the file, because `request.file()` only sees fields that arrive before it. */
function multipartBody(fields: Record<string, string>, file: { name: string; content: Buffer; mimeType?: string }) {
  const boundary = `ZeusImportBoundary${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.mimeType ?? 'text/csv'}\r\n\r\n`,
  ));
  parts.push(file.content);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

async function upload(user: { cookie: string }, module: string, csv: string, filename = 'import.csv') {
  const { body, boundary } = multipartBody({ module }, { name: filename, content: Buffer.from(csv, 'utf8') });
  const res = await app.inject({
    method: 'POST', url: '/api/imports/upload',
    headers: { cookie: user.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
  let json: unknown;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { json = res.body; }
  return { status: res.statusCode, body: json as Record<string, never> };
}

const run = (user: { cookie: string }, jobId: string, payload: Record<string, unknown>) =>
  request(app, user as never).post(`/api/imports/${jobId}/run`, payload);

const ACCOUNTS_CSV = [
  'Name,Type,Domain,Industry',
  'Northwind Trading LLC,CUSTOMER,northwindtrading.ae,Logistics',
  'Sandpiper Systems FZE,PARTNER,sandpipersys.com,Technology',
].join('\n');

describe('step 1 — upload and column guessing', () => {
  it('parses headers, counts rows, and auto-maps recognised columns', async () => {
    const res = await upload(fx.admin, 'accounts', ACCOUNTS_CSV);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.jobId);
    assert.equal(res.body.totalRows, 2);
    assert.deepEqual(res.body.headers, ['Name', 'Type', 'Domain', 'Industry']);

    // "Name" is an alias of the Account name field, "Domain"/"Type"/"Industry" match
    // their labels outright — none of this needs the user to map by hand.
    const mapping = res.body.suggestedMapping as unknown as Record<string, string>;
    assert.equal(mapping.name, 'Name');
    assert.equal(mapping.type, 'Type');
    assert.equal(mapping.domain, 'Domain');
  });

  it('refuses a module it cannot import', async () => {
    const res = await upload(fx.admin, 'unicorns', ACCOUNTS_CSV);
    assert.equal(res.status, 400);
    assert.match(res.body.error as unknown as string, /not supported/i);
  });

  it('refuses a file with no data rows', async () => {
    const res = await upload(fx.admin, 'accounts', 'Name,Type,Domain,Industry');
    assert.equal(res.status, 400);
    assert.match(res.body.error as unknown as string, /no data rows/i);
  });
});

describe('step 2 — dry run writes nothing', () => {
  it('reports what would happen and leaves the database untouched', async () => {
    const uploaded = await upload(fx.admin, 'accounts', ACCOUNTS_CSV);
    const before = await prisma.account.count();

    const res = await run(fx.admin, uploaded.body.jobId, {
      mapping: { name: 'Name', type: 'Type', domain: 'Domain', industry: 'Industry' },
      dryRun: true,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.totalRows, 2);
    assert.equal(res.body.wouldCreate, 2);
    assert.equal(res.body.preview.length, 2);

    assert.equal(await prisma.account.count(), before, 'a dry run must not write a single row');
  });

  it('does not count a dry run against the job totals', async () => {
    const uploaded = await upload(fx.admin, 'accounts', ACCOUNTS_CSV);
    await run(fx.admin, uploaded.body.jobId, { mapping: { name: 'Name' }, dryRun: true });

    const job = await prisma.importJob.findUnique({ where: { id: uploaded.body.jobId } });
    assert.equal(job?.imported, 0);
    assert.equal(job?.status, 'mapping', 'still awaiting a real run');
  });
});

describe('step 3 — commit', () => {
  it('creates the rows and records the job as done', async () => {
    const uploaded = await upload(fx.admin, 'accounts', ACCOUNTS_CSV);
    const res = await run(fx.admin, uploaded.body.jobId, {
      mapping: { name: 'Name', type: 'Type', domain: 'Domain', industry: 'Industry' },
      dryRun: false,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.wouldCreate, 2);

    const created = await prisma.account.findFirst({ where: { name: 'Northwind Trading LLC' } });
    assert.ok(created, 'the row is really there');
    assert.equal(created?.type, 'CUSTOMER');
    assert.equal(created?.domain, 'northwindtrading.ae');
    assert.equal(created?.industry, 'Logistics');

    const job = await prisma.importJob.findUnique({ where: { id: uploaded.body.jobId } });
    assert.equal(job?.status, 'done');
    assert.equal(job?.imported, 2);
    assert.ok(job?.finishedAt);

    const entry = await prisma.auditLog.findFirst({ where: { action: 'import', entityId: uploaded.body.jobId } });
    assert.ok(entry, 'a real import is audited; a dry run is not');
  });

  it('imports a product catalogue, resolving the vendor by name', async () => {
    const csv = [
      'SKU,Name,Type,List price,Cost,Vendor',
      'ACME-EDR-1Y,Acme EDR 1 year,PRODUCT,210,138,Acme Security',
    ].join('\n');
    const uploaded = await upload(fx.admin, 'products', csv);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

    const res = await run(fx.admin, uploaded.body.jobId, {
      mapping: { sku: 'SKU', name: 'Name', type: 'Type', listPrice: 'List price', cost: 'Cost', vendorName: 'Vendor' },
      dryRun: false,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const product = await prisma.product.findUnique({ where: { sku: 'ACME-EDR-1Y' } });
    assert.ok(product);
    assert.equal(Number(product?.listPrice), 210);
    assert.equal(Number(product?.cost), 138);
  });
});

describe('partial success — one bad row does not sink the batch', () => {
  it('imports the good rows and reports the bad ones by line number', async () => {
    const csv = [
      'Name,Type',
      'Good Company One,CUSTOMER',
      ',CUSTOMER',
      'Good Company Two,CUSTOMER',
    ].join('\n');
    const uploaded = await upload(fx.admin, 'accounts', csv);

    const res = await run(fx.admin, uploaded.body.jobId, { mapping: { name: 'Name', type: 'Type' }, dryRun: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.wouldCreate, 2, 'both good rows land');
    assert.equal(res.body.skipped, 1);

    const errors = res.body.errors as unknown as Array<{ row: number; message: string }>;
    assert.equal(errors.length, 1);
    // Row 3: +1 for the header, +1 because spreadsheets are 1-based.
    assert.equal(errors[0].row, 3, 'the error names the spreadsheet line, not the array index');
    assert.match(errors[0].message, /Missing required/i);

    assert.ok(await prisma.account.findFirst({ where: { name: 'Good Company One' } }));
    assert.ok(await prisma.account.findFirst({ where: { name: 'Good Company Two' } }));
  });
});

describe('duplicate strategy', () => {
  const dupeCsv = ['Name,Type,Domain,Industry', 'Test Customer LLC,CUSTOMER,testcustomer.ae,Rewritten Industry'].join('\n');

  it('skip leaves the existing record exactly as it was', async () => {
    const uploaded = await upload(fx.admin, 'accounts', dupeCsv);
    const res = await run(fx.admin, uploaded.body.jobId, {
      mapping: { name: 'Name', type: 'Type', domain: 'Domain', industry: 'Industry' },
      dryRun: false, onDuplicate: 'skip',
    });
    assert.equal(res.body.skipped, 1);
    assert.equal(res.body.wouldCreate, 0);

    const existing = await prisma.account.findUnique({ where: { id: fx.customer.id } });
    assert.notEqual(existing?.industry, 'Rewritten Industry', 'untouched');
  });

  it('update merges the file into the record already on file', async () => {
    const uploaded = await upload(fx.admin, 'accounts', dupeCsv);
    const res = await run(fx.admin, uploaded.body.jobId, {
      mapping: { name: 'Name', type: 'Type', domain: 'Domain', industry: 'Industry' },
      dryRun: false, onDuplicate: 'update',
    });
    assert.equal(res.body.wouldUpdate, 1);

    const existing = await prisma.account.findUnique({ where: { id: fx.customer.id } });
    assert.equal(existing?.industry, 'Rewritten Industry');
    assert.equal(await prisma.account.count({ where: { domain: 'testcustomer.ae' } }), 1, 'no second copy');
  });

  it('create adds it anyway, duplicate and all', async () => {
    const uploaded = await upload(fx.admin, 'accounts', dupeCsv);
    const res = await run(fx.admin, uploaded.body.jobId, {
      mapping: { name: 'Name', type: 'Type', domain: 'Domain', industry: 'Industry' },
      dryRun: false, onDuplicate: 'create',
    });
    assert.equal(res.body.wouldCreate, 1);
    assert.equal(await prisma.account.count({ where: { domain: 'testcustomer.ae' } }), 2);
  });
});

describe('permission gating', () => {
  it('is closed to a rep and to anonymous', async () => {
    const asRep = await upload(fx.rep, 'accounts', ACCOUNTS_CSV);
    assert.equal(asRep.status, 403);
    assert.equal((await request(app).get('/api/imports')).status, 401);
  });

  it('404s a run against an unknown job', async () => {
    const res = await run(fx.admin, 'not-a-real-job', { mapping: { name: 'Name' }, dryRun: true });
    assert.equal(res.status, 404);
  });

  it('lists past jobs for an admin', async () => {
    const uploaded = await upload(fx.admin, 'accounts', ACCOUNTS_CSV);
    const res = await request(app, fx.admin).get('/api/imports');
    assert.equal(res.status, 200);
    assert.ok((res.body as Array<{ id: string }>).some((j) => j.id === uploaded.body.jobId));
  });
});
