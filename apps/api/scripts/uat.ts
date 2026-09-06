/**
 * Zeus end-to-end UAT against a running server, through the public HTTP API only.
 *
 *   UAT_URL=http://192.168.1.45 UAT_EMAIL=admin@… UAT_PASSWORD=… npm run uat
 *
 * Signs in as the given user, walks one real commercial chain — account → contact →
 * deal → quote → invoice → payment — asserting the money at each step, then exercises
 * the operational surfaces (dashboard, reports, system status, data integrity, a real
 * backup run + validate + verify). Everything it creates is removed at the end, even
 * when a step fails. Exit code is non-zero on any failure.
 *
 * No test database, no fixtures: this is the same path a person clicking through the
 * UI takes, which is the point. Never prints the password.
 *
 * One run consumes one invoice number: an issued tax document cannot be deleted, only
 * cancelled, so ZEU-INV-… advances by one per run. Wipe the database before go-live if
 * the sequence should start from 000001.
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const BASE = (process.env.UAT_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const EMAIL = process.env.UAT_EMAIL ?? '';
const PASSWORD = process.env.UAT_PASSWORD ?? '';
if (!EMAIL || !PASSWORD) {
  console.error('Set UAT_EMAIL and UAT_PASSWORD (an administrator without 2FA).');
  process.exit(2);
}

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const TAG = `UAT ${stamp}`;
const APPROVER_EMAIL = 'uat-approver@example.com';

let cookie = '';
type Json = Record<string, unknown>;

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  // Only claim a JSON body when there is one — Fastify refuses an empty JSON body.
  const headers: Record<string, string> = cookie ? { cookie } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, json: parse(text) };
}
function parse(text: string): Json {
  if (!text) return {};
  try { return JSON.parse(text) as Json; } catch { return { raw: text.slice(0, 200) }; }
}
const num = (v: unknown) => Number(v);
const brief = (j: Json) => JSON.stringify(j).slice(0, 200);

// ── runner ────────────────────────────────────────────────────────────────────
const failures: string[] = [];
async function step(name: string, fn: () => Promise<string | void>) {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`  ✓ ${name}${note ? ` — ${note}` : ''} (${Date.now() - t0}ms)`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}: ${(err as Error).message}`);
  }
}

// Ids to remove at the end, in reverse order of creation.
const created: { paymentId?: string; invoiceId?: string; quoteId?: string; dealId?: string; contactId?: string; accountId?: string; approverId?: string } = {};

console.log(`\nZeus UAT against ${BASE} as ${EMAIL}\n`);

await step('health answers without a session', async () => {
  const r = await api('GET', '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

await step('anonymous traffic is refused', async () => {
  const r = await api('GET', '/api/accounts');
  assert.equal(r.status, 401);
});

await step('a wrong password is refused cleanly', async () => {
  const r = await api('POST', '/api/auth/login', { email: EMAIL, password: 'definitely-not-it-' + stamp });
  assert.equal(r.status, 401, `expected 401, got ${r.status}`);
});

await step('sign in', async () => {
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  assert.equal(res.status, 200, `login returned ${res.status}`);
  const body = (await res.json()) as Json;
  assert.notEqual(body.twoFactorRequired, true, 'this user has 2FA on — UAT needs an admin without it');
  const m = (res.headers.get('set-cookie') ?? '').match(/zeus_session=[^;]+/);
  assert.ok(m, 'no zeus_session cookie in the login response');
  cookie = m[0];
});

await step('session resolves to the signed-in user', async () => {
  const r = await api('GET', '/api/auth/me');
  assert.equal(r.status, 200);
  const email = String((r.json.user as Json | undefined)?.email ?? r.json.email ?? '');
  assert.equal(email.toLowerCase(), EMAIL.toLowerCase());
});

let pipelineId = '', openStageId = '', productId = '';
await step('pipelines and catalog are seeded', async () => {
  const p = await api('GET', '/api/pipelines');
  assert.equal(p.status, 200);
  const pipelines = p.json as unknown as Array<{ id: string; stages: Array<{ id: string; isWon?: boolean; isLost?: boolean }> }>;
  assert.ok(pipelines.length > 0, 'no pipelines');
  pipelineId = pipelines[0].id;
  const open = pipelines[0].stages.find((s) => !s.isWon && !s.isLost);
  assert.ok(open, 'no open stage');
  openStageId = open.id;

  const c = await api('GET', '/api/products?pageSize=5');
  assert.equal(c.status, 200);
  const items = (c.json.data ?? c.json.items ?? c.json) as Array<{ id: string }>;
  assert.ok(Array.isArray(items) && items.length > 0, 'no products');
  productId = items[0].id;
  return `${pipelines.length} pipeline(s), ${items.length}+ products`;
});

await step('create account', async () => {
  // A 15-digit TRN: a full tax invoice above AED 10,000 must carry the recipient's.
  const r = await api('POST', '/api/accounts', { name: `${TAG} Co`, type: 'CUSTOMER', domain: `uat-${stamp}.example`, trn: '100000000000003', ignoreDuplicates: true });
  assert.equal(r.status, 201, brief(r.json));
  created.accountId = String(r.json.id);
});

await step('create contact', async () => {
  const r = await api('POST', '/api/contacts', { firstName: 'Uat', lastName: stamp, email: `uat-${stamp}@example.com`, accountId: created.accountId, ignoreDuplicates: true });
  assert.equal(r.status, 201, brief(r.json));
  created.contactId = String(r.json.id);
});

await step('create deal in an open stage', async () => {
  const r = await api('POST', '/api/deals', { name: `${TAG} deal`, accountId: created.accountId, pipelineId, stageId: openStageId, amount: 10000, ignoreDuplicates: true });
  assert.equal(r.status, 201, brief(r.json));
  assert.equal(r.json.status, 'OPEN', `deal status ${r.json.status}`);
  created.dealId = String(r.json.id);
});

const lines = [{ productId, description: `${TAG} line`, quantity: 2, unitPrice: 5000 }];
let invoiceTotal = 0;

await step('quote totals reconcile', async () => {
  const r = await api('POST', '/api/quotes', { accountId: created.accountId, dealId: created.dealId, contactId: created.contactId, lines });
  assert.equal(r.status, 201, brief(r.json));
  created.quoteId = String(r.json.id);
  const subtotal = num(r.json.subtotal), vat = num(r.json.vatAmount), total = num(r.json.total);
  assert.equal(subtotal, 10000, `subtotal ${subtotal}`);
  assert.ok(Math.abs(subtotal + vat - total) < 0.005, `total ${total} ≠ ${subtotal} + ${vat}`);
  return `AED ${total.toFixed(2)} incl. VAT ${vat.toFixed(2)}`;
});

await step('invoice from the quote, then issue it', async () => {
  const r = await api('POST', '/api/invoices', { accountId: created.accountId, dealId: created.dealId, quoteId: created.quoteId, contactId: created.contactId, lines });
  assert.equal(r.status, 201, brief(r.json));
  created.invoiceId = String(r.json.id);
  assert.equal(r.json.status, 'DRAFT');
  invoiceTotal = num(r.json.total);
  // Issue through the status route: /send would also email the customer. When the
  // approval policy applies, go through it the way a team does — the owner submits,
  // a second person signs off — rather than switching the policy off for the test.
  let s = await api('POST', `/api/invoices/${created.invoiceId}/status`, { status: 'SENT' });
  let note = '';
  if (s.status === 400 && /approval/i.test(String(s.json.error))) {
    note = await approveAsSecondPerson('invoices', created.invoiceId);
    s = await api('POST', `/api/invoices/${created.invoiceId}/status`, { status: 'SENT' });
  }
  assert.equal(s.status, 200, brief(s.json));
  const after = await api('GET', `/api/invoices/${created.invoiceId}`);
  assert.equal(after.json.status, 'SENT', `status ${after.json.status}`);
  return `${after.json.number} · AED ${invoiceTotal.toFixed(2)}${note ? ` · ${note}` : ''}`;
});

/**
 * Self-approval is off by default, so the sign-off needs a second user. One "UAT
 * Approver" (Sales Manager) lives permanently, inactive between runs: reactivated with
 * a fresh random password here, deactivated again in cleanup. Nothing accumulates.
 */
async function approveAsSecondPerson(entity: string, id: string): Promise<string> {
  const sub = await api('POST', `/api/approvals/${entity}/${id}/submit`, {});
  assert.equal(sub.status, 200, `submit: ${brief(sub.json)}`);

  const roles = await api('GET', '/api/roles');
  const manager = ((roles.json.roles as Array<{ id: string; name: string }>) ?? []).find((r) => r.name === 'Sales Manager');
  assert.ok(manager, 'no Sales Manager role');
  const password = randomBytes(12).toString('base64url');

  const existing = ((await api('GET', `/api/users?search=${encodeURIComponent(APPROVER_EMAIL)}&pageSize=5`)).json.data as Array<{ id: string; email: string }> | undefined)
    ?.find((u) => u.email === APPROVER_EMAIL);
  let approverId: string;
  if (existing) {
    const r = await api('PATCH', `/api/users/${existing.id}`, { isActive: true, password });
    assert.equal(r.status, 200, `reactivate approver: ${brief(r.json)}`);
    approverId = existing.id;
  } else {
    const r = await api('POST', '/api/users', { name: 'UAT Approver', email: APPROVER_EMAIL, roleId: manager.id, password });
    assert.equal(r.status, 201, `create approver: ${brief(r.json)}`);
    approverId = String(r.json.id);
  }
  created.approverId = approverId;

  const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: APPROVER_EMAIL, password }) });
  assert.equal(login.status, 200, `approver login ${login.status}`);
  const m = (login.headers.get('set-cookie') ?? '').match(/zeus_session=[^;]+/);
  assert.ok(m, 'approver got no session');
  const res = await fetch(BASE + `/api/approvals/${entity}/${id}/approve`, { method: 'POST', headers: { cookie: m[0], 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 200, `approve: ${(await res.text()).slice(0, 200)}`);
  return `approved by ${existing ? 'existing' : 'new'} UAT Approver`;
}

await step('full payment closes the invoice', async () => {
  const r = await api('POST', '/api/payments', { direction: 'INCOMING', invoiceId: created.invoiceId, amount: invoiceTotal, method: 'Bank transfer' });
  assert.equal(r.status, 201, brief(r.json));
  created.paymentId = String(r.json.id);
  const inv = await api('GET', `/api/invoices/${created.invoiceId}`);
  assert.equal(inv.json.status, 'PAID', `status ${inv.json.status}`);
  assert.ok(Math.abs(num(inv.json.amountPaid) - invoiceTotal) < 0.005, `amountPaid ${inv.json.amountPaid}`);
});

async function integrityClean(): Promise<string> {
  const r = await api('POST', '/api/system/data-health');
  assert.equal(r.status, 200, brief(r.json));
  const findings = (r.json.findings as Array<{ check: string; count: number }>) ?? [];
  assert.equal(r.json.ok, true, findings.map((f) => `${f.check}×${f.count}`).join(', ') || brief(r.json));
  return `${(r.json.checks as unknown[] | undefined)?.length ?? 7} checks clean`;
}
await step('data integrity is clean after the writes', integrityClean);

await step('dashboard, reports and system status respond', async () => {
  for (const path of ['/api/dashboard/overview', '/api/dashboard/attention', '/api/reports']) {
    const r = await api('GET', path);
    assert.equal(r.status, 200, `${path} → ${r.status}`);
  }
  const s = await api('GET', '/api/system/status');
  assert.equal(s.status, 200);
  const comps = (s.json.components as Array<{ key: string; ok: boolean }>) ?? [];
  const db = comps.find((c) => /database|postgres|db/i.test(c.key));
  assert.ok(db?.ok, `database component: ${db ? 'down' : 'not reported'}`);
  const down = comps.filter((c) => !c.ok).map((c) => c.key);
  return down.length ? `up (not configured: ${down.join(', ')})` : 'all components up';
});

await step('backup: run, validate, verify (real restore into a scratch database)', async () => {
  const run = await api('POST', '/api/backups/run', { kind: 'physical' });
  assert.equal(run.status, 200, brief(run.json));
  assert.notEqual(run.json.ok, false, brief(run.json));
  const val = await api('POST', '/api/backups/validate');
  assert.equal(val.status, 200, brief(val.json));
  assert.equal(val.json.ok, true, `validate: ${brief(val.json)}`);
  const ver = await api('POST', '/api/backups/verify');
  assert.equal(ver.status, 200, brief(ver.json));
  assert.equal(ver.json.ok, true, `verify: ${brief(ver.json)}`);
  return String(val.json.filename ?? '');
});

// ── cleanup — always, in reverse, every item attempted even if one fails ─────
console.log('\nCleanup');
await step('remove everything this run created', async () => {
  const gone: string[] = [], problems: string[] = [];
  const attempt = async (label: string, fn: () => Promise<{ status: number; json: Json }>) => {
    const r = await fn();
    if (r.status >= 200 && r.status < 300) gone.push(label);
    else problems.push(`${label}: ${r.status} ${brief(r.json).slice(0, 120)}`);
  };
  if (created.paymentId) await attempt('payment', () => api('DELETE', `/api/payments/${created.paymentId}`));
  if (created.invoiceId) {
    // A draft can go; an issued tax document keeps its number and is cancelled instead.
    const inv = await api('GET', `/api/invoices/${created.invoiceId}`);
    if (inv.json.status === 'DRAFT') await attempt('invoice', () => api('DELETE', `/api/invoices/${created.invoiceId}`));
    else await attempt('invoice (cancelled)', () => api('POST', `/api/invoices/${created.invoiceId}/status`, { status: 'CANCELLED' }));
  }
  if (created.quoteId) await attempt('quote', () => api('DELETE', `/api/quotes/${created.quoteId}`));
  if (created.dealId) await attempt('deal', () => api('DELETE', `/api/deals/${created.dealId}`));
  if (created.contactId) await attempt('contact', () => api('DELETE', `/api/contacts/${created.contactId}`));
  if (created.accountId) await attempt('account', () => api('DELETE', `/api/accounts/${created.accountId}`));
  if (created.approverId) await attempt('approver (deactivated)', () => api('DELETE', `/api/users/${created.approverId}`));
  if (problems.length) throw new Error(problems.join(' | '));
  return gone.join(', ') || 'nothing to remove';
});

await step('data integrity is still clean after cleanup', integrityClean);

await api('POST', '/api/auth/logout').catch(() => undefined);

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(' · ')}\n` : '\nAll UAT steps passed.\n');
process.exit(failures.length ? 1 : 0);
