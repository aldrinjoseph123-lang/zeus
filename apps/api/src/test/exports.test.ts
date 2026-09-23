import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';
import { loadWorkbook } from '../services/xlsx.js';
import { label } from '../routes/exports.js';

/**
 * Exporting a list. The file must be the screen: the same rows the list would show for the
 * same query, in the same order, with the same fields hidden — and nothing for a role whose
 * export box is unticked.
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

let seq = 0;
const deal = (owner: TestUser, name: string, amount: number, status: 'OPEN' | 'WON' = 'OPEN', cost?: number) => {
  seq += 1;
  return prisma.deal.create({
    data: {
      reference: `ZEU-D-EXP${seq}`, name, accountId: fx.customer.id, status, pipelineId: fx.pipeline.id,
      stageId: fx.pipeline.stages[1].id, amount, probability: 50, ownerId: owner.id,
      closeDate: new Date(Date.now() + 30 * 86_400_000), ...(cost === undefined ? {} : { cost }),
    },
  });
};

const fetch = (user: TestUser | null, url: string) =>
  app.inject({ method: 'GET', url, headers: user ? { cookie: user.cookie } : {} });

/** The sheet as strings: the header row and the data rows under it. */
async function sheet(buffer: Buffer): Promise<{ header: string[]; rows: string[][]; text: string }> {
  const wb = await loadWorkbook(buffer);
  const ws = wb.worksheets[0];
  const all: string[][] = [];
  ws.eachRow((row) => { all.push((row.values as unknown[]).slice(1).map((v) => (v instanceof Date ? v.toISOString() : String(v ?? '')))); });
  const at = all.findIndex((r) => r.includes('Name'));
  return { header: all[at], rows: all.slice(at + 1), text: all.flat().join('\n') };
}

async function reader(name: string, permissions: Record<string, unknown>): Promise<TestUser> {
  const role = await prisma.role.create({ data: { name, permissions: permissions as never } });
  const user = await prisma.user.create({ data: { email: `${name.toLowerCase().replace(/\s/g, '')}@test.local`, name, passwordHash: 'x', roleId: role.id } });
  const { SESSION_COOKIE, signSessionToken } = await import('../auth/session.js');
  return { id: user.id, email: user.email, name, roleName: name, cookie: `${SESSION_COOKIE}=${await signSessionToken(user.id, 12)}` };
}

describe('exporting a list', () => {
  it('is the list as filtered and sorted, in a file named for the list and the day', async () => {
    await deal(fx.rep, 'Firewall refresh', 300);
    await deal(fx.rep, 'EDR rollout', 100);
    await deal(fx.rep, 'Won already', 200, 'WON');

    const res = await fetch(fx.admin, '/api/export/deals?status=OPEN&sortBy=amount&sortDir=asc');
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /spreadsheetml/);
    assert.match(res.headers['content-disposition'] as string, /^attachment; filename="zeus-deals-\d{4}-\d{2}-\d{2}\.xlsx"$/);

    const { header, rows } = await sheet(res.rawPayload);
    for (const col of ['Reference', 'Name', 'Amount', 'Stage', 'Account', 'Owner']) assert.ok(header.includes(col), `${col} column (got ${header.join(', ')})`);
    assert.ok(!header.some((h) => /\bID\b|Id$/.test(h)), `no id columns: ${header.join(', ')}`);
    assert.deepEqual(rows.map((r) => r[header.indexOf('Name')]), ['EDR rollout', 'Firewall refresh'], 'the filter and the sort of the list apply');
    assert.deepEqual(rows.map((r) => r[header.indexOf('Amount')]), ['100', '300']);
    assert.equal(rows[0][header.indexOf('Owner')], 'rep', 'a related record is named, not dumped');

    const narrowed = await sheet((await fetch(fx.admin, '/api/export/deals?search=EDR')).rawPayload);
    assert.equal(narrowed.rows.length, 1, 'the search box narrows the export as it narrows the list');
  });

  it('shows a reader only their own rows and none of the fields their role hides', async () => {
    const own = await reader('Own Exporter', {
      deals: { read: 'own', create: false, update: 'none', delete: 'none', export: true, fields: { amount: 'hidden', cost: 'hidden' } },
    });
    const mine = await prisma.deal.create({
      data: {
        reference: 'ZEU-D-MINE', name: 'Mine to export', accountId: fx.customer.id, status: 'OPEN', pipelineId: fx.pipeline.id,
        stageId: fx.pipeline.stages[1].id, amount: 4321, probability: 50, ownerId: own.id, closeDate: new Date(), cost: 4590.63,
      },
    });
    await deal(fx.rep, 'Somebody else’s', 999_999);

    const file = await sheet((await fetch(own, '/api/export/deals')).rawPayload);
    assert.deepEqual(file.rows.map((r) => r[file.header.indexOf('Name')]), [mine.name], 'owner scope applies');
    assert.ok(!file.header.includes('Amount'), 'a hidden field is not a column');
    assert.ok(!file.text.includes('4321') && !file.text.includes('999999'), 'and its values are nowhere in the file');
    assert.ok(!file.text.includes('4590.63'), 'a hidden cost is hidden here too');
  });

  it('refuses a role without the export box ticked, an unknown list, and no one', async () => {
    const reads = await reader('Reads Only', { deals: { read: 'all', create: false, update: 'none', delete: 'none', export: false } });
    const res = await fetch(reads, '/api/export/deals');
    assert.equal(res.statusCode, 403);
    assert.match((res.json() as { error: string }).error, /cannot export deals/);
    assert.equal((await fetch(fx.admin, '/api/export/secrets')).statusCode, 404);
    assert.equal((await fetch(null, '/api/export/deals')).statusCode, 401);
  });

  it('exports every list it offers', async () => {
    for (const list of ['leads', 'accounts', 'contacts', 'quotes', 'invoices', 'products', 'purchase-orders']) {
      const res = await fetch(fx.admin, `/api/export/${list}`);
      assert.equal(res.statusCode, 200, `${list}: ${res.body.slice(0, 120)}`);
    }
  });

  it('labels columns the way a person would', () => {
    assert.deepEqual(['closeDate', 'vatAmount', 'trn', 'customerPoNumber', 'isPrimary', 'sku'].map(label),
      ['Close date', 'VAT amount', 'TRN', 'Customer PO number', 'Is primary', 'SKU']);
  });
});
