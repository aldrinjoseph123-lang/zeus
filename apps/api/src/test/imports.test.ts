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

// Most fixtures here are not about missing details, so they import rows with gaps; the gap tests say otherwise.
const run = (user: { cookie: string }, jobId: string, payload: Record<string, unknown>) =>
  request(app, user as never).post(`/api/imports/${jobId}/run`, { importGaps: true, ...payload });

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

    const mapping = { sku: 'SKU', name: 'Name', type: 'Type', listPrice: 'List price', cost: 'Cost', vendorName: 'Vendor' };
    // A vendor Zeus has never seen is screened, and created only because someone said so.
    const screen = await request(app, fx.admin).post(`/api/imports/${uploaded.body.jobId}/accounts`, { mapping });
    const [vendor] = (screen.body as { references: Array<{ key: string; status: string; type: string }> }).references;
    assert.equal(vendor.status, 'new');
    assert.equal(vendor.type, 'VENDOR');

    const res = await run(fx.admin, uploaded.body.jobId, {
      mapping, dryRun: false, accounts: { [vendor.key]: { action: 'create', name: 'Acme Security', type: 'VENDOR' } },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const product = await prisma.product.findUnique({ where: { sku: 'ACME-EDR-1Y' }, include: { vendor: true } });
    assert.ok(product);
    assert.equal(product?.vendor?.type, 'VENDOR');
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

/**
 * A template filled in somewhere else and saved back.
 *
 * Zeus's import template puts a note on every header. openpyxl — and the tools built on it —
 * saves those notes with absolute paths, which exceljs could not follow, so the upload failed
 * before a single row was read: "Cannot read properties of undefined (reading 'comments')".
 * Found on 15 Sep 2026 with a real contacts file. This rebuilds that shape by hand.
 */
describe('a workbook saved by another tool', () => {
  async function openpyxlShaped(): Promise<Buffer> {
    const { default: ExcelJS } = await import('exceljs');
    const { default: JSZip } = await import('jszip');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('contacts');
    ws.addRow(['First name', 'Last name', 'Account name', 'Email']);
    ws.addRow(['Fatima', 'Al Hashimi', 'Northwind Trading LLC', 'fatima@northwindtrading.ae']);
    ws.getCell('A1').note = 'Required.';
    const zip = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));

    // Where openpyxl puts the parts, and how it points at them: absolute targets, named ids.
    zip.file('xl/comments/comment1.xml', await zip.file('xl/comments1.xml')!.async('string'));
    zip.file('xl/drawings/commentsDrawing1.vml', await zip.file('xl/drawings/vmlDrawing1.vml')!.async('string'));
    zip.remove('xl/comments1.xml');
    zip.remove('xl/drawings/vmlDrawing1.vml');
    zip.file('xl/worksheets/_rels/sheet1.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="/xl/comments/comment1.xml" Id="comments"/>'
      + '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing" Target="/xl/drawings/commentsDrawing1.vml" Id="anysvml"/>'
      + '</Relationships>');
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    zip.file('xl/worksheets/sheet1.xml', sheet.replace(/<legacyDrawing r:id="[^"]*"\/>/, '<legacyDrawing r:id="anysvml"/>'));
    const types = await zip.file('[Content_Types].xml')!.async('string');
    zip.file('[Content_Types].xml', types.replace('/xl/comments1.xml', '/xl/comments/comment1.xml'));
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  it('uploads, with every row read', async () => {
    const content = await openpyxlShaped();
    const { default: ExcelJS } = await import('exceljs');
    await assert.rejects(new ExcelJS.Workbook().xlsx.load(content as never), /comments/, 'the shape really is the one that broke');

    const { body, boundary } = multipartBody({ module: 'contacts' }, { name: 'contacts-filled.xlsx', content });
    const res = await app.inject({
      method: 'POST', url: '/api/imports/upload',
      headers: { cookie: fx.admin.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    assert.equal(res.statusCode, 201, res.body);
    const json = JSON.parse(res.body) as { headers: string[]; totalRows: number };
    assert.deepEqual(json.headers, ['First name', 'Last name', 'Account name', 'Email']);
    assert.equal(json.totalRows, 1);
  });
});


/**
 * Account screening. Every account a file names that Zeus does not hold by exactly that name
 * is put to a person before anything is written — and a contact never lands without one.
 * The rows are the shapes of a real contacts file from 15 Sep 2026.
 */
describe('account screening', () => {
  interface Reference {
    key: string; name: string | null; status: 'found' | 'new' | 'blank'; rows: number[];
    found: { id: string } | null; suggestions: Array<{ id: string; name: string; reason: string }>; suggestedName: string | null; type: string;
  }
  const CONTACTS = [
    'First name,Last name,Account name,Email,Mobile',
    'Fatima,Al Hashimi,Northwind Trading LLC,fatima@northwindtrading.ae,',
    'Anil,Gupta,StorTech Solutions LLC,anil@stortech.ae,+971 50 559 3479',
    'Sonia,Mulani,IBT Global,sonia.mulani@ibt.global,',
    'Priyadarsan,Roy,SPS Cloud Solutions,pd@spscloudsolutions.com,',
    'Shaji,,,shaji@buhani.co,+971 50 458 1084',
    'Anoop,Aravindaks,,,+971 56 741 8382',
  ].join('\n');
  const MAPPING = { firstName: 'First name', lastName: 'Last name', accountName: 'Account name', email: 'Email', mobile: 'Mobile' };

  async function screened() {
    await prisma.account.createMany({
      data: [
        { name: 'Northwind Trading LLC', type: 'CUSTOMER' },
        { name: 'StorTech Solutions', type: 'PARTNER' },
        { name: 'Integrated Business Tech', type: 'PARTNER', domain: 'ibt.global' },
      ],
    });
    const uploaded = await upload(fx.admin, 'contacts', CONTACTS);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const res = await request(app, fx.admin).post(`/api/imports/${uploaded.body.jobId}/accounts`, { mapping: MAPPING });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const refs = (res.body as { references: Reference[] }).references;
    const by = (name: string | null, row?: number) => refs.find((r) => r.name === name && (row === undefined || r.rows.includes(row)))!;
    return { jobId: uploaded.body.jobId as string, refs, by };
  }

  it('says which accounts it knows, which it suspects, and which it has never seen', async () => {
    const { by } = await screened();
    assert.equal(by('Northwind Trading LLC').status, 'found', 'an exact name is used without asking');
    assert.equal(by('StorTech Solutions LLC').status, 'new');
    assert.equal(by('StorTech Solutions LLC').suggestions[0]?.name, 'StorTech Solutions', 'the LLC is set aside when comparing');
    assert.match(by('IBT Global').suggestions[0]?.reason ?? '', /same email domain/);
    assert.equal(by('SPS Cloud Solutions').suggestions.length, 0);
    assert.equal(by(null, 6).status, 'blank');
    assert.equal(by(null, 6).suggestedName, 'Buhani', 'a blank row with an email offers its domain as a name');
    assert.equal(by(null, 7).suggestedName, null, 'and one with nothing to go on offers nothing');
  });

  it('refuses to import while any account is unsettled, and a preview writes no account', async () => {
    const { jobId, by } = await screened();
    const refused = await run(fx.admin, jobId, { mapping: MAPPING, dryRun: false });
    assert.equal(refused.status, 400);
    assert.match((refused.body as { error: string }).error, /Settle 5 accounts/);

    const before = await prisma.account.count();
    const preview = await run(fx.admin, jobId, { mapping: MAPPING, dryRun: true, accounts: { [by('SPS Cloud Solutions').key]: { action: 'create', name: 'SPS Cloud Solutions', type: 'PARTNER' } } });
    assert.equal(preview.status, 200);
    assert.equal(await prisma.account.count(), before, 'a preview creates no account');
    assert.equal(await prisma.contact.count(), 0);
  });

  it('imports exactly as settled: linked, created with a type, or left out — never a contact without an account', async () => {
    const { jobId, by } = await screened();
    const storTech = by('StorTech Solutions LLC');
    const ibt = by('IBT Global');
    const res = await run(fx.admin, jobId, {
      mapping: MAPPING, dryRun: false,
      accounts: {
        [storTech.key]: { action: 'link', accountId: storTech.suggestions[0].id },
        [ibt.key]: { action: 'link', accountId: ibt.suggestions[0].id },
        [by('SPS Cloud Solutions').key]: { action: 'create', name: 'SPS Cloud Solutions', type: 'PARTNER' },
        [by(null, 6).key]: { action: 'create', name: 'Buhani', type: 'PROSPECT' },
        [by(null, 7).key]: { action: 'skip' },
      },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const contacts = await prisma.contact.findMany({ include: { account: true }, orderBy: { firstName: 'asc' } });
    assert.deepEqual(contacts.map((c) => [c.firstName, c.account?.name]), [
      ['Anil', 'StorTech Solutions'],
      ['Fatima', 'Northwind Trading LLC'],
      ['Priyadarsan', 'SPS Cloud Solutions'],
      ['Shaji', 'Buhani'],
      ['Sonia', 'Integrated Business Tech'],
    ]);
    assert.ok(contacts.every((c) => c.accountId), 'no contact without an account');
    assert.equal(contacts.find((c) => c.firstName === 'Shaji')?.lastName, '', 'a last name is optional');
    assert.equal(await prisma.account.count({ where: { name: { contains: 'StorTech' } } }), 1, 'no second StorTech');

    const sps = await prisma.account.findFirstOrThrow({ where: { name: 'SPS Cloud Solutions' } });
    assert.equal(sps.type, 'PARTNER', 'created as what it is, not as a customer by default');
    assert.equal(sps.domain, 'spscloudsolutions.com', 'with the domain its contacts are on, for the next duplicate check');
  });

  it('deals screen the customer and the partner', async () => {
    const csv = ['Deal name,Customer,Partner,Net amount', 'EDR rollout,Al Noor Hospital,Gronteq,50000'].join('\n');
    const uploaded = await upload(fx.admin, 'deals', csv);
    const mapping = { name: 'Deal name', accountName: 'Customer', partnerName: 'Partner', amount: 'Net amount' };
    const refs = ((await request(app, fx.admin).post(`/api/imports/${uploaded.body.jobId}/accounts`, { mapping })).body as { references: Reference[] }).references;
    assert.deepEqual(refs.map((r) => [r.name, r.type]), [['Al Noor Hospital', 'CUSTOMER'], ['Gronteq', 'PARTNER']]);
  });
});

/**
 * Undo on import history. Chosen on 15 Sep 2026: remove what the import created, restore what it
 * updated, keep and name anything worked on since, inside the usual undo window. Imports from
 * before the ledger existed are not undoable.
 */
describe('undoing an import', () => {
  const CSV = [
    'First name,Last name,Account name,Email',
    'Fatima,Al Hashimi,Northwind Trading LLC,fatima@northwind.ae',
    'Priyadarsan,Roy,SPS Cloud Solutions,pd@spscloudsolutions.com',
    'Kamel,Salameh,IT Works,k.salameh@it.works',
  ].join('\n');
  const MAPPING = { firstName: 'First name', lastName: 'Last name', accountName: 'Account name', email: 'Email' };

  /** Northwind exists already and is linked; SPS and IT Works are created by the import. */
  async function imported() {
    const northwind = await prisma.account.create({ data: { name: 'Northwind Trading LLC', type: 'CUSTOMER' } });
    const uploaded = await upload(fx.admin, 'contacts', CSV);
    const refs = ((await request(app, fx.admin).post(`/api/imports/${uploaded.body.jobId}/accounts`, { mapping: MAPPING })).body as { references: Array<{ key: string; name: string; status: string }> }).references;
    const accounts = Object.fromEntries(refs.filter((r) => r.status !== 'found').map((r) => [r.key, { action: 'create', name: r.name, type: 'PARTNER' }]));
    const res = await run(fx.admin, uploaded.body.jobId, { mapping: MAPPING, dryRun: false, accounts });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { jobId: uploaded.body.jobId as string, northwind };
  }
  const undo = (jobId: string) => request(app, fx.admin).post(`/api/imports/${jobId}/undo`, {});
  const live = async (name: string) => prisma.account.findFirst({ where: { name, deletedAt: null } });

  it('removes what it created, leaves what it only linked to, and cannot be done twice', async () => {
    const { jobId, northwind } = await imported();
    const history = (await request(app, fx.admin).get('/api/imports')).body as Array<{ id: string; undoable: boolean; undo?: unknown }>;
    assert.equal(history.find((j) => j.id === jobId)?.undoable, true);
    assert.equal(history.find((j) => j.id === jobId)?.undo, undefined, 'the ledger stays on the server');

    const res = await undo(jobId);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { removed: 5, restored: 0, kept: [] }, 'three contacts and the two accounts made for them');
    assert.equal(await prisma.contact.count({ where: { deletedAt: null } }), 0);
    assert.equal(await live('SPS Cloud Solutions'), null);
    assert.ok(await live('Northwind Trading LLC'), 'an account the import only linked to was never its to remove');
    assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: northwind.id } })).deletedAt, null);

    assert.equal((await undo(jobId)).status, 400);
    const after = (await request(app, fx.admin).get('/api/imports')).body as Array<{ id: string; undoable: boolean; status: string }>;
    assert.deepEqual([after.find((j) => j.id === jobId)?.status, after.find((j) => j.id === jobId)?.undoable], ['undone', false]);
  });

  it('keeps and names a contact that has since been put on a quote — and the account that contact still needs', async () => {
    const { jobId } = await imported();
    const roy = await prisma.contact.findFirstOrThrow({ where: { lastName: 'Roy' } });
    await prisma.quote.create({ data: { number: 'ZEU-Q-UNDO1', accountId: roy.accountId!, contactId: roy.id } });

    const res = await undo(jobId);
    const body = res.body as { removed: number; kept: Array<{ label: string; reason: string }> };
    assert.deepEqual(body.kept.map((k) => k.label).sort(), ['Priyadarsan Roy', 'SPS Cloud Solutions']);
    assert.match(body.kept.find((k) => k.label === 'Priyadarsan Roy')!.reason, /1 quotes/);
    assert.equal(body.removed, 3, 'Fatima, Kamel and IT Works still go');
    assert.ok(await live('SPS Cloud Solutions'));
  });

  it('puts updated records back as they were, unless they have changed again since', async () => {
    const kept = await prisma.account.create({ data: { name: 'Sandpiper Systems FZE', type: 'PARTNER', domain: 'sandpipersys.com', industry: 'Retail' } });
    const moved = await prisma.account.create({ data: { name: 'Northwind Trading LLC', type: 'CUSTOMER', domain: 'northwindtrading.ae', industry: 'Retail' } });
    const uploaded = await upload(fx.admin, 'accounts', ACCOUNTS_CSV);
    await run(fx.admin, uploaded.body.jobId, { mapping: { name: 'Name', type: 'Type', domain: 'Domain', industry: 'Industry' }, dryRun: false, onDuplicate: 'update' });
    assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: kept.id } })).industry, 'Technology');

    // Someone edits one of them after the import (dated ahead, rather than waiting out the grace second).
    await prisma.account.update({ where: { id: moved.id }, data: { industry: 'Shipping', updatedAt: new Date(Date.now() + 10_000) } });

    const res = await undo(uploaded.body.jobId);
    const body = res.body as { restored: number; kept: Array<{ label: string }> };
    assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: kept.id } })).industry, 'Retail', 'restored');
    assert.equal((await prisma.account.findUniqueOrThrow({ where: { id: moved.id } })).industry, 'Shipping', 'a later edit is not overwritten');
    assert.equal(body.restored, 1);
    assert.deepEqual(body.kept.map((k) => k.label), ['Northwind Trading LLC']);
  });

  it('only within the undo window, and never for an import that kept no record', async () => {
    const { jobId } = await imported();
    await prisma.importJob.update({ where: { id: jobId }, data: { finishedAt: new Date(Date.now() - 73 * 3_600_000) } });
    const late = await undo(jobId);
    assert.equal(late.status, 400);
    assert.match((late.body as { error: string }).error, /72 hours/);

    const old = await prisma.importJob.create({ data: { module: 'leads', filename: 'before-undo.xlsx', status: 'done', dryRun: false, finishedAt: new Date() } });
    const refused = await undo(old.id);
    assert.equal(refused.status, 400);
    assert.match((refused.body as { error: string }).error, /before Zeus kept a record/);
  });

  it('undoes a contacts file imported into leads by mistake', async () => {
    const uploaded = await upload(fx.admin, 'leads', ['First name,Last name,Company,Email', 'Anil,Gupta,StorTech Solutions LLC,anil@stortech.ae', 'Sonia,Mulani,IBT Global,sonia@ibt.global'].join('\n'));
    await run(fx.admin, uploaded.body.jobId, { mapping: { firstName: 'First name', lastName: 'Last name', company: 'Company', email: 'Email' }, dryRun: false });
    assert.equal(await prisma.lead.count({ where: { deletedAt: null } }), 2);
    assert.equal(((await undo(uploaded.body.jobId)).body as { removed: number }).removed, 2);
    assert.equal(await prisma.lead.count({ where: { deletedAt: null } }), 0);
  });
});

describe('rows missing an expected detail', () => {
  type Result = { wouldCreate: number; skipped: number; errors: unknown[]; gaps: Array<{ row: number; message: string }>; preview: Array<{ row: number; action: string; note?: string }> };

  it('are skipped and listed unless ticked, then import with the blanks left in', async () => {
    const csv = ['First name,Last name,Company,Email,Phone', 'Anil,,StorTech,anil@stortech.ae,', 'Sonia,Mulani,,,', 'Shaji,,,,'].join('\n');
    const uploaded = await upload(fx.admin, 'leads', csv);
    const mapping = { firstName: 'First name', lastName: 'Last name', company: 'Company', email: 'Email', phone: 'Phone' };

    const held = (await run(fx.admin, uploaded.body.jobId, { mapping, dryRun: true, importGaps: false })).body as unknown as Result;
    assert.equal(held.wouldCreate, 1, 'a missing last name is not a gap');
    assert.equal(held.skipped, 2);
    assert.deepEqual(held.errors, [], 'gaps are not errors');
    assert.deepEqual(held.gaps, [
      { row: 3, message: 'Missing Company · Email or phone' },
      { row: 4, message: 'Missing Company · Email or phone' },
    ]);
    assert.equal(held.preview.find((p) => p.row === 3)?.action, 'skip');

    const res = await run(fx.admin, uploaded.body.jobId, { mapping, dryRun: false, importGaps: true });
    const body = res.body as unknown as Result;
    assert.equal(body.wouldCreate, 3);
    assert.equal(body.gaps.length, 2, 'still listed, so the result says what came in thin');
    const shaji = await prisma.lead.findFirstOrThrow({ where: { firstName: 'Shaji' } });
    assert.equal(shaji.lastName, '');
    assert.equal(shaji.company, '');
  });

  it('still never import a row without its name', async () => {
    const uploaded = await upload(fx.admin, 'leads', ['First name,Company,Email', ',StorTech,anil@stortech.ae'].join('\n'));
    const body = (await run(fx.admin, uploaded.body.jobId, { mapping: { firstName: 'First name', company: 'Company', email: 'Email' }, dryRun: false, importGaps: true })).body as unknown as Result;
    assert.equal(body.wouldCreate, 0);
    assert.equal(body.errors.length, 1);
  });

  it('count a value outside a closed list as missing: an account typed "Reseller" has no type', async () => {
    const csv = ['Name,Type,Domain,Email', 'Northwind Trading LLC,Reseller,northwindtrading.ae,sales@northwindtrading.ae', 'Sandpiper Systems FZE,partner,sandpipersys.com,info@sandpipersys.com'].join('\n');
    const uploaded = await upload(fx.admin, 'accounts', csv);
    const body = (await run(fx.admin, uploaded.body.jobId, { mapping: { name: 'Name', type: 'Type', domain: 'Domain', email: 'Email' }, dryRun: true, importGaps: false })).body as unknown as Result;
    assert.deepEqual(body.gaps, [{ row: 2, message: 'Missing Type' }], 'lower-case "partner" is a type');
    assert.equal(body.wouldCreate, 1);
  });

  it('a lead with no company converts only into an account someone chooses', async () => {
    const lead = await prisma.lead.create({ data: { firstName: 'Shaji', lastName: '', company: '', ownerId: fx.admin.id } });
    const refused = await request(app, fx.admin).post(`/api/leads/${lead.id}/convert`, { createDeal: false });
    assert.equal(refused.status, 400);
    assert.match((refused.body as { error: string }).error, /no company/);
    const converted = await request(app, fx.admin).post(`/api/leads/${lead.id}/convert`, { createDeal: false, accountId: fx.customer.id });
    assert.equal(converted.status, 200, JSON.stringify(converted.body));
  });
});
