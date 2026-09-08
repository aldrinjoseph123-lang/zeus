import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures, TestUser } from './harness.js';
import { invalidateSettings, setSetting } from '../lib/settings.js';
import { PORTAL_COOKIE } from '../portal/session.js';

/**
 * The partner screen. Scoped to the partner's own account, both sides of the channel,
 * only states that are safe to show, and an allowlist that never lets the discount or
 * the deal's value out unless a switch says so.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => {
  await resetDatabase();
  fx = await seedFixtures(app);
  await setSetting('portal.enabled', true, 'portal');
  invalidateSettings();
});

const id = (res: { body: unknown }) => (res.body as { id: string }).id;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const asPortal = (cookie: string): TestUser => ({ id: '', email: '', name: '', roleName: '', cookie });
const day = 86_400_000;
const at = (daysFromNow: number) => new Date(Date.now() + daysFromNow * day).toISOString();

/** A partner account with one contact who has portal access and a password. */
/**
 * A partner with one person signed in. That person is the partner's admin unless told
 * otherwise — most tests here are about what the *account* is allowed to see, and the
 * member/admin split has tests of its own.
 */
async function partner(name: string, email: string, role: 'admin' | 'member' = 'admin') {
  const account = await request(app, fx.admin).post('/api/accounts', { name, type: 'PARTNER', ignoreDuplicates: true });
  // The account's primary contact is the partner's admin on the portal.
  const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'P', lastName: name, email, accountId: id(account), isPrimary: role === 'admin', ignoreDuplicates: true });
  const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(contact) });
  const token = randomBytes(32).toString('hex');
  await prisma.portalUser.update({ where: { id: id(granted) }, data: { linkTokenHash: sha256(token), linkExpiresAt: new Date(Date.now() + 60_000) } });
  await request(app).post('/api/portal/auth/set-password', { token, password: 'correct-horse-battery-staple' });
  const login = await request(app).post('/api/portal/auth/login', { email, password: 'correct-horse-battery-staple' });
  const cookie = String(login.raw.headers['set-cookie']).match(new RegExp(`${PORTAL_COOKIE}=[^;]+`))![0];
  return { accountId: id(account), contactId: id(contact), portalUserId: id(granted), cookie };
}

/** A second person at an existing partner, with their own sign-in. */
async function colleague(accountId: string, name: string, email: string) {
  const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'C', lastName: name, email, accountId, ignoreDuplicates: true });
  const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(contact) });
  const token = randomBytes(32).toString('hex');
  await prisma.portalUser.update({ where: { id: id(granted) }, data: { linkTokenHash: sha256(token), linkExpiresAt: new Date(Date.now() + 60_000) } });
  await request(app).post('/api/portal/auth/set-password', { token, password: 'correct-horse-battery-staple' });
  const login = await request(app).post('/api/portal/auth/login', { email, password: 'correct-horse-battery-staple' });
  const cookie = String(login.raw.headers['set-cookie']).match(new RegExp(`${PORTAL_COOKIE}=[^;]+`))![0];
  return { contactId: id(contact), portalUserId: id(granted), cookie };
}
type Page = { data: Row[]; total: number; page: number; pageSize: number; facets: { vendors: string[]; stages: string[]; statuses: string[] }; scope: 'all' | 'mine' };
const list = async (cookie: string, qs = '') => (await request(app, asPortal(cookie)).get(`/api/portal/registrations${qs}`)).body as Page;

async function deal(name: string, amount = 25000, accountId = fx.customer.id) {
  const res = await request(app, fx.admin).post('/api/deals', { name, accountId, amount, ignoreDuplicates: true });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return id(res);
}

async function register(dealId: string, body: Record<string, unknown>) {
  const res = await request(app, fx.admin).post(`/api/deals/${dealId}/registrations`, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return id(res);
}

type Row = { id: string; deal: { reference: string; endCustomer: string; stage?: string; value?: number; quoted?: number }; ours: { status: string; daysLeft: number | null; regNumber?: string | null; expiresAt: string | null }; vendors: Array<{ vendor: string; status: string; daysLeft: number | null; regNumber?: string | null }> };

describe('portal: the partner screen', () => {
  it('shows only the signed-in partner\'s registrations, with the vendor side attached', async () => {
    const a = await partner('Partner A', 'a@partner.example');
    const b = await partner('Partner B', 'b@partner.example');
    const vendor = await request(app, fx.admin).post('/api/accounts', { name: 'Vendor Inc', type: 'VENDOR', ignoreDuplicates: true });

    const d1 = await deal('Protected for A');
    await register(d1, { side: 'PARTNER', partnerId: a.accountId, status: 'APPROVED', approvedDiscount: 12.5, regNumber: 'PRT-1', expiresAt: at(40) });
    await register(d1, { side: 'VENDOR', vendorId: id(vendor), status: 'APPROVED', approvedDiscount: 30, regNumber: 'VND-1', expiresAt: at(60) });
    const d2 = await deal('Protected for B');
    await register(d2, { side: 'PARTNER', partnerId: b.accountId, status: 'SUBMITTED', expiresAt: at(20) });

    const seenByA = await request(app, asPortal(a.cookie)).get('/api/portal/registrations');
    assert.equal(seenByA.status, 200, JSON.stringify(seenByA.body));
    const rows = (seenByA.body as Page).data;
    assert.equal(rows.length, 1, 'A sees only A');
    assert.equal(rows[0].deal.endCustomer, fx.customer.name);
    assert.equal(rows[0].ours.status, 'APPROVED');
    assert.equal(rows[0].ours.daysLeft, 40);
    assert.equal(rows[0].ours.regNumber, 'PRT-1', 'vendor number shown by default');
    assert.equal(rows[0].vendors.length, 1);
    assert.equal(rows[0].vendors[0].vendor, 'Vendor Inc');
    assert.equal(rows[0].vendors[0].status, 'APPROVED');
    assert.equal(rows[0].vendors[0].daysLeft, 60);

    // Nothing that is not on the allowlist leaves — the discount above all.
    assert.doesNotMatch(JSON.stringify(seenByA.body), /approvedDiscount|12\.5|"30"|notes|ownerId|amount/);
    assert.equal(rows[0].deal.value, undefined, 'deal value is off by default');

    const seenByB = (await request(app, asPortal(b.cookie)).get('/api/portal/registrations')).body.data as Row[];
    assert.equal(seenByB.length, 1);
    assert.equal(seenByB[0].ours.status, 'SUBMITTED');
  });

  it('hides DRAFT, shows REJECTED, keeps EXPIRED for 30 days, sorts by soonest expiry', async () => {
    const a = await partner('Partner A', 'a@partner.example');
    const mk = async (name: string, body: Record<string, unknown>) => register(await deal(name), { side: 'PARTNER', partnerId: a.accountId, ...body });
    await mk('draft', { status: 'DRAFT', expiresAt: at(5) });
    await mk('rejected', { status: 'REJECTED', expiresAt: at(5) });
    await mk('recently lapsed', { status: 'EXPIRED', expiresAt: at(-10) });
    await mk('long gone', { status: 'EXPIRED', expiresAt: at(-45) });
    await mk('soon', { status: 'APPROVED', expiresAt: at(3) });
    await mk('later', { status: 'APPROVED', expiresAt: at(30) });
    // The create route always sets an expiry; a missing date is a later edit or an old row.
    const noDate = await mk('no date', { status: 'SUBMITTED' });
    await prisma.dealRegistration.update({ where: { id: noDate }, data: { expiresAt: null } });

    const rows = (await request(app, asPortal(a.cookie)).get('/api/portal/registrations')).body.data as Row[];
    // A rejection is an answer the partner is owed; a draft is not an answer yet.
    assert.deepEqual(rows.map((r) => [r.ours.status, r.ours.daysLeft]), [
      ['EXPIRED', -10], ['APPROVED', 3], ['REJECTED', 5], ['APPROVED', 30], ['SUBMITTED', null],
    ]);
  });

  it('the switches: deal value on, registration number off', async () => {
    const a = await partner('Partner A', 'a@partner.example');
    await register(await deal('Switched', 99000), { side: 'PARTNER', partnerId: a.accountId, status: 'APPROVED', regNumber: 'PRT-9', expiresAt: at(10) });
    await setSetting('portal.partner.showDealValue', true, 'portal');
    await setSetting('portal.partner.showRegNumber', false, 'portal');
    invalidateSettings();
    const [row] = (await request(app, asPortal(a.cookie)).get('/api/portal/registrations')).body.data as Row[];
    assert.equal(row.deal.value, 99000);
    assert.equal('regNumber' in row.ours, false, 'number withheld when switched off');
  });

  it('shows where the opportunity stands and what we quoted — each behind its own switch', async () => {
    const a = await partner('Partner S', 's@partner.example');
    const dealId = await deal('Staged', 50000);
    await register(dealId, { side: 'PARTNER', partnerId: a.accountId, status: 'APPROVED', expiresAt: at(30) });
    // A draft quote is not a number the customer has seen; a sent one is.
    const product = await request(app, fx.admin).post('/api/products', { sku: 'Q-1', name: 'Thing', unit: 'each', listPrice: 100, cost: 40 });
    const draft = await request(app, fx.admin).post('/api/quotes', { accountId: fx.customer.id, dealId, lines: [{ productId: id(product), description: 'Thing', quantity: 1, unitPrice: 999, unitCost: 0, discountPct: 0, taxable: true }] });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    const sent = await request(app, fx.admin).post('/api/quotes', { accountId: fx.customer.id, dealId, lines: [{ productId: id(product), description: 'Thing', quantity: 10, unitPrice: 380, unitCost: 0, discountPct: 0, taxable: true }] });
    // Sent straight in the table: the approval workflow is its own test, not this one's.
    const sentRow = await prisma.quote.update({ where: { id: id(sent) }, data: { status: 'SENT', sentAt: new Date() } });
    const sentTotal = Number(sentRow.total);

    // Defaults: stage shown, quoted amount hidden.
    let [row] = (await request(app, asPortal(a.cookie)).get('/api/portal/registrations')).body.data as Row[];
    assert.ok(row.deal.stage, 'the stage is on by default');
    assert.equal('quoted' in row.deal, false, 'the quoted amount is off by default');

    await setSetting('portal.partner.showQuotedValue', true, 'portal');
    await setSetting('portal.partner.showStage', false, 'portal');
    invalidateSettings();
    [row] = (await request(app, asPortal(a.cookie)).get('/api/portal/registrations')).body.data as Row[];
    assert.equal(row.deal.quoted, sentTotal, 'the latest sent quote, never the draft');
    assert.notEqual(row.deal.quoted, 999);
    assert.equal('stage' in row.deal, false, 'and the stage can be switched off');
  });

  it('a customer gets nothing here, and an outsider gets 401', async () => {
    const customer = await request(app, fx.admin).post('/api/accounts', { name: 'Cust Co', type: 'CUSTOMER', ignoreDuplicates: true });
    const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'C', lastName: 'C', email: 'c@cust.example', accountId: id(customer), ignoreDuplicates: true });
    const granted = await request(app, fx.admin).post('/api/portal-admin/users', { contactId: id(contact) });
    await request(app, fx.admin).post('/api/subscriptions', { accountId: id(customer), description: 'MDR', quantity: 1, unitPrice: 1, termMonths: 12, startDate: new Date().toISOString().slice(0, 10) });
    const token = randomBytes(32).toString('hex');
    await prisma.portalUser.update({ where: { id: id(granted) }, data: { linkTokenHash: sha256(token), linkExpiresAt: new Date(Date.now() + 60_000) } });
    await request(app).post('/api/portal/auth/set-password', { token, password: 'correct-horse-battery-staple' });
    const login = await request(app).post('/api/portal/auth/login', { email: 'c@cust.example', password: 'correct-horse-battery-staple' });
    const cookie = String(login.raw.headers['set-cookie']).match(new RegExp(`${PORTAL_COOKIE}=[^;]+`))![0];
    assert.equal((await request(app, asPortal(cookie)).get('/api/portal/registrations')).status, 404);
    assert.equal((await request(app).get('/api/portal/registrations')).status, 401);
  });
});

describe('portal: the three layers of control', () => {
  it('a per-account override narrows or widens the global switch, and only for that account', async () => {
    const a = await partner('Partner A', 'a@partner.example');
    const b = await partner('Partner B', 'b@partner.example');
    await register(await deal('A deal', 40000), { side: 'PARTNER', partnerId: a.accountId, status: 'APPROVED', regNumber: 'PRT-A', expiresAt: at(10) });
    await register(await deal('B deal', 50000), { side: 'PARTNER', partnerId: b.accountId, status: 'APPROVED', regNumber: 'PRT-B', expiresAt: at(10) });

    // Global: number on, value off. Override A: number off, value on.
    const patched = await request(app, fx.admin).patch(`/api/portal-admin/accounts/${a.accountId}`, { overrides: { showRegNumber: false, showDealValue: true, notASwitch: true } });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const view = patched.body as { overrides: Record<string, boolean>; effective: Record<string, boolean>; switches: Array<{ key: string }> };
    assert.deepEqual(view.overrides, { showRegNumber: false, showDealValue: true }, 'the unknown key was dropped, never stored');
    // The two untouched switches fall through to their global defaults.
    assert.deepEqual(view.effective, { showStage: true, showRegNumber: false, showDealValue: true, showQuotedValue: false });
    assert.deepEqual(view.switches.map((s) => s.key).sort(), ['showDealValue', 'showQuotedValue', 'showRegNumber', 'showStage']);

    const [rowA] = (await request(app, asPortal(a.cookie)).get('/api/portal/registrations')).body.data as Row[];
    assert.equal('regNumber' in rowA.ours, false, 'A: number withheld by override');
    assert.equal(rowA.deal.value, 40000, 'A: value shown by override');
    const [rowB] = (await request(app, asPortal(b.cookie)).get('/api/portal/registrations')).body.data as Row[];
    assert.equal(rowB.ours.regNumber, 'PRT-B', 'B: still the global default');
    assert.equal(rowB.deal.value, undefined);

    // null clears an override; the global default applies again.
    const cleared = (await request(app, fx.admin).patch(`/api/portal-admin/accounts/${a.accountId}`, { overrides: { showRegNumber: null } })).body as { effective: Record<string, boolean> };
    assert.equal(cleared.effective.showRegNumber, true);
  });

  it('a logo must be a small image data URL; branding is served per audience', async () => {
    const a = await partner('Partner A', 'a@partner.example');
    const png = 'data:image/png;base64,' + Buffer.from('not-really-a-png-but-fine-for-storage').toString('base64');
    assert.equal((await request(app, fx.admin).patch(`/api/portal-admin/accounts/${a.accountId}`, { logo: 'https://evil.example/x.png' })).status, 400, 'a URL is not accepted');
    assert.equal((await request(app, fx.admin).patch(`/api/portal-admin/accounts/${a.accountId}`, { logo: 'data:text/html;base64,PHNjcmlwdD4=' })).status, 400, 'only images');
    assert.equal((await request(app, fx.admin).patch(`/api/portal-admin/accounts/${a.accountId}`, { logo: 'data:image/png;base64,' + 'A'.repeat(210_000) })).status, 400, 'too large');
    assert.equal((await request(app, fx.admin).patch(`/api/portal-admin/accounts/${a.accountId}`, { logo: png })).status, 200);

    await request(app, fx.admin).put('/api/settings', { 'portal.branding.welcome.partner': 'Welcome, partner.', 'portal.branding.banner.partner': 'Q4 registrations close 15 Dec.' });
    const b = (await request(app, asPortal(a.cookie)).get('/api/portal/branding')).body as { accountLogo: string | null; welcome: string; banner: string | null; contact: string };
    assert.equal(b.accountLogo, png);
    assert.equal(b.welcome, 'Welcome, partner.');
    assert.equal(b.banner, 'Q4 registrations close 15 Dec.');
    assert.equal((await request(app, fx.rep).patch(`/api/portal-admin/accounts/${a.accountId}`, { logo: null })).status, 403);
  });
});

describe('portal: who at the partner sees what', () => {
  it('a member sees only the registrations under their own name; the admin sees the whole account', async () => {
    const pat = await partner('Roles Co', 'pat@roles.example', 'member');
    const sam = await colleague(pat.accountId, 'Sam', 'sam@roles.example');
    await register(await deal('Pat brought this', 10000), { side: 'PARTNER', partnerId: pat.accountId, partnerContactId: pat.contactId, status: 'APPROVED', expiresAt: at(20) });
    await register(await deal('Sam brought this', 20000), { side: 'PARTNER', partnerId: pat.accountId, partnerContactId: sam.contactId, status: 'APPROVED', expiresAt: at(30) });
    await register(await deal('Nobody named', 30000), { side: 'PARTNER', partnerId: pat.accountId, status: 'SUBMITTED', expiresAt: at(40) });

    // Both start as members: each sees only their own, and the unowned row belongs to nobody.
    assert.deepEqual((await list(pat.cookie)).data.map((r) => r.deal.endCustomer).length, 1);
    assert.equal((await list(pat.cookie)).scope, 'mine');
    assert.equal((await list(sam.cookie)).total, 1);

    // Pat becomes the primary contact — the flag sales already set on the account's people.
    const promoted = await request(app, fx.admin).patch(`/api/contacts/${pat.contactId}`, { isPrimary: true });
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));

    const all = await list(pat.cookie);
    assert.equal(all.scope, 'all');
    assert.equal(all.total, 3, 'the admin sees every registration, including the one nobody is named on');
    assert.equal((await list(sam.cookie)).total, 1, 'Sam is still a member and still sees only Sam\'s');
    assert.equal(((await request(app, asPortal(pat.cookie)).get('/api/portal/me')).body as { role: string }).role, 'admin');

    // One primary contact per account, so exactly one admin: making Sam primary demotes Pat.
    await request(app, fx.admin).patch(`/api/contacts/${sam.contactId}`, { isPrimary: true });
    assert.equal((await list(sam.cookie)).total, 3);
    assert.equal((await list(pat.cookie)).total, 1, 'Pat is back to their own');
  });

  it('a partner cannot make themselves the admin — the primary flag is ours to set', async () => {
    const pat = await partner('Roles Co', 'pat@roles.example', 'member');
    assert.equal((await request(app, asPortal(pat.cookie)).patch(`/api/contacts/${pat.contactId}`, { isPrimary: true })).status, 401);
    assert.equal((await list(pat.cookie)).scope, 'mine');
  });
});

describe('portal: filters over hundreds of registrations', () => {
  async function partnerWithMany() {
    const pat = await partner('Busy Co', 'pat@busy.example');
    const cs = await request(app, fx.admin).post('/api/accounts', { name: 'CrowdStrike', type: 'VENDOR', ignoreDuplicates: true });
    const ft = await request(app, fx.admin).post('/api/accounts', { name: 'Fortinet', type: 'VENDOR', ignoreDuplicates: true });
    const rows = [
      { name: 'Alpha Bank', amount: 90000, status: 'APPROVED', expires: 10, vendor: id(cs) },
      { name: 'Beta Foods', amount: 20000, status: 'APPROVED', expires: 50, vendor: id(ft) },
      { name: 'Gamma Logistics', amount: 40000, status: 'SUBMITTED', expires: 80, vendor: id(cs) },
      { name: 'Delta Retail', amount: 10000, status: 'EXPIRED', expires: -5, vendor: null },
      { name: 'Epsilon Clinic', amount: 5000, status: 'REJECTED', expires: null, vendor: null },
      { name: 'Zeta Drafted', amount: 1000, status: 'DRAFT', expires: 30, vendor: null },
    ];
    for (const r of rows) {
      // Each row is its own end customer, so the text filter and the names mean something.
      const customer = await request(app, fx.admin).post('/api/accounts', { name: r.name, type: 'CUSTOMER', ignoreDuplicates: true });
      const d = await deal(r.name, r.amount, id(customer));
      await register(d, { side: 'PARTNER', partnerId: pat.accountId, status: r.status, expiresAt: r.expires === null ? undefined : at(r.expires) });
      if (r.vendor) await register(d, { side: 'VENDOR', vendorId: r.vendor, status: 'APPROVED', expiresAt: at(60) });
    }
    return pat;
  }

  it('shows rejected and expired but never a draft, and counts what it shows', async () => {
    const pat = await partnerWithMany();
    const page = await list(pat.cookie);
    assert.equal(page.total, 5, 'five visible, the draft is not a fact yet');
    assert.deepEqual(page.facets.statuses, ['APPROVED', 'EXPIRED', 'REJECTED', 'SUBMITTED']);
    assert.deepEqual(page.facets.vendors, ['CrowdStrike', 'Fortinet'], 'only vendors on this partner\'s own deals');
    assert.equal(page.data[0].ours.status, 'EXPIRED', 'soonest expiry first, and lapsed is soonest of all');
    assert.equal(page.data.at(-1)?.ours.status, 'REJECTED', 'no date at all sorts last');
  });

  it('filters by vendor, status, expiry window and text — each narrowing, never widening', async () => {
    const pat = await partnerWithMany();
    assert.deepEqual((await list(pat.cookie, '?vendor=CrowdStrike')).data.map((r) => r.deal.endCustomer).sort(), ['Alpha Bank', 'Gamma Logistics']);
    assert.deepEqual((await list(pat.cookie, '?status=SUBMITTED')).data.map((r) => r.deal.endCustomer), ['Gamma Logistics']);
    assert.deepEqual((await list(pat.cookie, '?expiring=30')).data.map((r) => r.deal.endCustomer), ['Alpha Bank']);
    assert.deepEqual((await list(pat.cookie, '?expiring=lapsed')).data.map((r) => r.deal.endCustomer), ['Delta Retail']);
    assert.deepEqual((await list(pat.cookie, '?q=beta')).data.map((r) => r.deal.endCustomer), ['Beta Foods']);
    assert.equal((await list(pat.cookie, '?vendor=Fortinet&status=SUBMITTED')).total, 0, 'filters combine');
    assert.equal((await list(pat.cookie, '?vendor=NotTheirVendor')).total, 0, 'a name off the list matches nothing');
  });

  it('sorts by value only when value may be seen, and pages', async () => {
    const pat = await partnerWithMany();
    const byExpiry = (await list(pat.cookie)).data.map((r) => r.deal.endCustomer);
    const byValueHidden = (await list(pat.cookie, '?sort=value')).data.map((r) => r.deal.endCustomer);
    assert.deepEqual(byValueHidden, byExpiry, 'value hidden: the sort is quietly ignored');

    await setSetting('portal.partner.showDealValue', true, 'portal');
    invalidateSettings();
    assert.equal((await list(pat.cookie, '?sort=value')).data[0].deal.endCustomer, 'Alpha Bank', 'highest value first');

    const p1 = await list(pat.cookie, '?pageSize=2&page=1');
    const p3 = await list(pat.cookie, '?pageSize=2&page=3');
    assert.equal(p1.data.length, 2); assert.equal(p1.total, 5);
    assert.equal(p3.data.length, 1, 'the last page holds the remainder');
  });

  it('a member\'s facets and filters are drawn from their own rows only', async () => {
    const pat = await partnerWithMany();
    const sam = await colleague(pat.accountId, 'Sam', 'sam@busy.example');
    const page = await list(sam.cookie);
    assert.equal(page.total, 0, 'nothing is under Sam\'s name');
    assert.deepEqual(page.facets.vendors, [], 'and no vendor is offered as a filter');
    assert.equal((await list(sam.cookie, '?vendor=CrowdStrike')).total, 0, 'naming a vendor does not reach into the account');
  });
});
