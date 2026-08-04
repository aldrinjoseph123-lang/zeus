import assert from 'node:assert/strict';
import { applyVat, lineTotals, round2, stripVat, taxDocumentTotals } from './lib/money.js';
import { extractDomain, normalizeCompany } from './services/dedupe.js';
import { parseCsv } from './services/xlsx.js';
import { buildCard } from './services/teams.js';
import { alertText, normalizeNumber } from './services/whatsapp.js';
import { MODULES, SYSTEM_ROLES, can, type SessionUser, maskFields, stripUnwritableFields } from './auth/rbac.js';

/**
 * The money, dedupe and permission paths get one runnable check each.
 * `npm test` runs this; it needs no database and no framework.
 */

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

console.log('\nZeus self-check\n');

// ── money ─────────────────────────────────────────────────────────────────────
check('round2 handles binary float error', () => {
  assert.equal(round2(0.1 + 0.2), 0.3);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(2.675), 2.68);
  assert.equal(round2(-1.005), -1.01);
});

check('5% VAT on a plain amount', () => {
  assert.deepEqual(applyVat(10000), { vatAmount: 500, total: 10500 });
  assert.deepEqual(applyVat(33.33), { vatAmount: 1.67, total: 35 });
  assert.deepEqual(applyVat(0), { vatAmount: 0, total: 0 });
});

check('stripVat inverts applyVat', () => {
  const { total } = applyVat(18750.5);
  const { net } = stripVat(total);
  assert.equal(net, 18750.5);
});

check('line discount applies before VAT', () => {
  assert.deepEqual(lineTotals({ quantity: 10, unitPrice: 100, discountPct: 10 }), { lineTotal: 900, lineCost: 0 });
  assert.deepEqual(lineTotals({ quantity: 3, unitPrice: 33.33, unitCost: 20 }), { lineTotal: 99.99, lineCost: 60 });
});

// ── per-line tax (invoices, credit notes, purchase orders) ────────────────────
check('per-line VAT: mixed rates on one document', () => {
  const t = taxDocumentTotals([
    { quantity: 800, unitPrice: 55, unitCost: 30, taxable: true, vatRate: 5 },  // 44,000 @ 5%
    { quantity: 1, unitPrice: 15000, unitCost: 9000, taxable: false },          // zero-rated export
  ]);
  assert.equal(t.subtotal, 59000);
  assert.equal(t.vatAmount, 2200, 'VAT must come off the taxable line only');
  assert.equal(t.total, 61200);
  assert.equal(t.marginAmount, 26000);
  assert.equal(t.lines[0].lineVat, 2200);
  assert.equal(t.lines[1].lineVat, 0, 'a zero-rated line must carry no tax');
});

check('per-line VAT sums to the document VAT', () => {
  // Odd amounts: rounding per line must still reconcile against the printed total.
  const t = taxDocumentTotals([
    { quantity: 3, unitPrice: 33.33, taxable: true, vatRate: 5 },
    { quantity: 7, unitPrice: 12.49, taxable: true, vatRate: 5 },
    { quantity: 1, unitPrice: 99.99, taxable: true, vatRate: 5 },
  ]);
  const summed = t.lines.reduce((s, l) => s + l.lineVat, 0);
  assert.equal(round2(summed), t.vatAmount, 'line tax must add up to the header tax');
  assert.equal(round2(t.netAfterDiscount + t.vatAmount), t.total);
});

check('header discount reduces the taxable base', () => {
  const t = taxDocumentTotals(
    [{ quantity: 1, unitPrice: 10000, unitCost: 6000, taxable: true, vatRate: 5 }],
    { headerDiscountPct: 10 },
  );
  assert.equal(t.discountAmt, 1000);
  assert.equal(t.netAfterDiscount, 9000);
  assert.equal(t.vatAmount, 450, 'VAT is charged on 9,000, not 10,000');
  assert.equal(t.total, 9450);
});

check('VAT breakdown by rate is filed-return ready', () => {
  const t = taxDocumentTotals([
    { quantity: 1, unitPrice: 1000, taxable: true, vatRate: 5 },
    { quantity: 1, unitPrice: 2000, taxable: true, vatRate: 5 },
    { quantity: 1, unitPrice: 500, taxable: false },
  ]);
  const standard = t.byRate.find((b) => b.rate === 5)!;
  const zero = t.byRate.find((b) => b.rate === 0)!;
  assert.equal(standard.taxableAmount, 3000);
  assert.equal(standard.vatAmount, 150);
  assert.equal(zero.taxableAmount, 500);
  assert.equal(zero.vatAmount, 0);
  assert.equal(round2(standard.taxableAmount + zero.taxableAmount), t.subtotal);
});

check('a credit note computes exactly like the invoice it reverses', () => {
  const original = taxDocumentTotals([{ quantity: 10, unitPrice: 500, taxable: true, vatRate: 5 }]);
  const credit = taxDocumentTotals([{ quantity: 2, unitPrice: 500, taxable: true, vatRate: 5 }]);
  assert.equal(credit.total, 1050, 'returning 2 of 10 credits 1,000 net plus 50 VAT');
  assert.ok(credit.total < original.total);
});

check('a quote and the invoice raised from it agree to the fil', () => {
  // Both documents now round tax per line. Before they did not, and odd amounts
  // could leave a quote and its invoice differing by a fil.
  const lines = [
    { quantity: 3, unitPrice: 33.33, taxable: true },
    { quantity: 7, unitPrice: 12.49, taxable: true },
  ];
  const quote = taxDocumentTotals(lines, { headerDiscountPct: 7.5, defaultVatRate: 5 });
  // The invoice copies the lines and stamps the document rate onto each one.
  const invoice = taxDocumentTotals(
    lines.map((l) => ({ ...l, vatRate: 5 })),
    { headerDiscountPct: 7.5, defaultVatRate: 5 },
  );
  assert.equal(quote.total, invoice.total);
  assert.equal(quote.vatAmount, invoice.vatAmount);
});

// ── duplicate detection ───────────────────────────────────────────────────────
check('extractDomain normalises every input shape', () => {
  assert.equal(extractDomain('ahmed@EmiratesNBD.com'), 'emiratesnbd.com');
  assert.equal(extractDomain('https://www.emiratesnbd.com/personal'), 'emiratesnbd.com');
  assert.equal(extractDomain('emiratesnbd.com:443'), 'emiratesnbd.com');
  assert.equal(extractDomain('not a domain'), null);
  assert.equal(extractDomain(''), null);
  assert.equal(extractDomain(null), null);
});

check('normalizeCompany strips UAE legal suffixes', () => {
  assert.equal(normalizeCompany('Emirates NBD Bank P.J.S.C.'), 'emirates nbd bank pjsc');
  assert.equal(normalizeCompany('Protect24x7 FZ-LLC'), 'protect24x7');
  assert.equal(normalizeCompany('Al Futtaim Trading LLC'), 'al futtaim');
  assert.equal(normalizeCompany('Acme DMCC'), 'acme');
  assert.equal(
    normalizeCompany('Gulf Systems General Trading'),
    normalizeCompany('Gulf Systems'),
    'a trading-suffix variant must collide with the base name',
  );
});

// ── CSV import ────────────────────────────────────────────────────────────────
check('CSV parser handles quotes, commas and newlines', () => {
  const { headers, rows } = parseCsv(
    'Company,Contact,Notes\n"Al Futtaim, LLC",Ahmed,"Line one\nLine two"\nAcme,Sara,""\n',
  );
  assert.deepEqual(headers, ['Company', 'Contact', 'Notes']);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Company, 'Al Futtaim, LLC');
  assert.equal(rows[0].Notes, 'Line one\nLine two');
  assert.equal(rows[1].Contact, 'Sara');
});

// ── RBAC ──────────────────────────────────────────────────────────────────────
const roleByName = (name: string): SessionUser => {
  const role = SYSTEM_ROLES.find((r) => r.name === name)!;
  return { id: 'u1', email: 'x@y.ae', name, roleId: 'r1', roleName: name, teamId: null, permissions: role.permissions };
};

check('every module appears in every shipped role', () => {
  for (const role of SYSTEM_ROLES) {
    for (const module of MODULES) {
      assert.ok(role.permissions[module], `${role.name} is missing "${module}"`);
    }
  }
});

check('Read Only cannot write anything', () => {
  const user = roleByName('Read Only');
  for (const module of MODULES) {
    assert.equal(can(user, module, 'create'), false, `Read Only can create ${module}`);
    assert.equal(can(user, module, 'update'), false, `Read Only can update ${module}`);
    assert.equal(can(user, module, 'delete'), false, `Read Only can delete ${module}`);
  }
  assert.equal(can(user, 'deals', 'read'), true);
  assert.equal(can(user, 'deals', 'export'), true);
});

check('Sales Executive cannot reach settings or users', () => {
  const user = roleByName('Sales Executive');
  assert.equal(can(user, 'settings', 'read'), false);
  assert.equal(can(user, 'users', 'read'), false);
  assert.equal(can(user, 'integrations', 'update'), false);
  assert.equal(can(user, 'deals', 'create'), true);
});

check('cost and margin are stripped for roles that cannot see them', () => {
  const rep = roleByName('Sales Executive');
  const deal = { id: 'd1', name: 'Bank MDR', amount: 100000, cost: 60000, margin: 40000, account: { name: 'ENBD', cost: 1 } };
  const masked = maskFields(rep, 'deals', deal) as Record<string, unknown>;
  assert.equal(masked.amount, 100000);
  assert.equal('cost' in masked, false, 'cost leaked to a rep');
  assert.equal('margin' in masked, false, 'margin leaked to a rep');
  assert.equal('cost' in (masked.account as Record<string, unknown>), false, 'nested cost leaked to a rep');

  const manager = roleByName('Sales Manager');
  assert.equal((maskFields(manager, 'deals', deal) as Record<string, unknown>).cost, 60000);
});

check('a rep cannot write a field their role hides', () => {
  const rep = roleByName('Sales Executive');
  const body = stripUnwritableFields(rep, 'deals', { name: 'Bank MDR', amount: 5000, cost: 1 });
  assert.equal(body.name, 'Bank MDR');
  assert.equal(body.amount, 5000);
  assert.equal('cost' in body, false, 'a rep managed to set cost');
});

check('Administrator keeps full access to every module', () => {
  const admin = roleByName('Administrator');
  for (const module of MODULES) {
    assert.equal(can(admin, module, 'read'), true);
    assert.equal(can(admin, module, 'delete'), true);
  }
});

// ── approvals ─────────────────────────────────────────────────────────────────
const withPermissions = (name: string, permissions: Record<string, unknown>): SessionUser =>
  ({ id: 'u2', email: 'x@y.ae', name, roleId: 'r2', roleName: name, teamId: null, permissions: permissions as never });

check('approve falls back to whoever can already edit every record', () => {
  // Roles saved before approvals existed carry no `approve` key at all.
  const manager = withPermissions('Legacy Manager', { deals: { read: 'all', create: true, update: 'all', delete: 'none', export: true } });
  const rep = withPermissions('Legacy Rep', { deals: { read: 'team', create: true, update: 'own', delete: 'none', export: false } });
  assert.equal(can(manager, 'deals', 'approve'), true, 'a manager keeps signing off without a role re-save');
  assert.equal(can(rep, 'deals', 'approve'), false, 'a rep must never inherit approval');
});

check('an explicit approve flag beats the fallback both ways', () => {
  const denied = withPermissions('Ops', { invoices: { read: 'all', create: true, update: 'all', delete: 'none', export: true, approve: false } });
  const granted = withPermissions('Finance', { invoices: { read: 'own', create: false, update: 'own', delete: 'none', export: false, approve: true } });
  assert.equal(can(denied, 'invoices', 'approve'), false);
  assert.equal(can(granted, 'invoices', 'approve'), true);
});

check('the shipped roles put sign-off with the managers', () => {
  for (const module of ['deals', 'invoices'] as const) {
    assert.equal(can(roleByName('Administrator'), module, 'approve'), true);
    assert.equal(can(roleByName('Sales Manager'), module, 'approve'), true);
    assert.equal(can(roleByName('Sales Executive'), module, 'approve'), false);
    assert.equal(can(roleByName('Read Only'), module, 'approve'), false);
  }
});

// ── WhatsApp ──────────────────────────────────────────────────────────────────
check('phone numbers are normalised to what Meta accepts', () => {
  assert.equal(normalizeNumber('+971 50 123 4567'), '971501234567');
  assert.equal(normalizeNumber('971-50-123-4567'), '971501234567');
  // A UAE mobile typed the local way is missing its country code.
  assert.equal(normalizeNumber('0501234567'), '971501234567');
  assert.equal(normalizeNumber('12345'), null, 'too short to be a number');
});

check('an alert survives becoming a single template parameter', () => {
  const text = alertText({
    title: 'Approval needed — ZEU-D-000002',
    body: 'ENBD\nMDR\trollout',
    facts: [{ title: 'Value', value: 'AED 59,000' }],
    linkUrl: 'https://zeus.local/deals/abc',
  });
  // WhatsApp rejects newlines and tabs inside a template parameter.
  assert.ok(!/[\n\r\t]/.test(text), `control characters left in: ${JSON.stringify(text)}`);
  assert.ok(text.includes('AED 59,000'));
  assert.ok(text.includes('https://zeus.local/deals/abc'));
  assert.ok(text.length <= 1000);
});

// ── Teams card ────────────────────────────────────────────────────────────────
check('Teams adaptive card has the shape Teams accepts', () => {
  const card = buildCard({ title: 'Deal won', text: 'ENBD', facts: [{ title: 'Value', value: 'AED 100,000' }], linkUrl: 'https://zeus.local/deals/1' }) as {
    type: string;
    attachments: Array<{ contentType: string; content: { type: string; body: unknown[]; actions: unknown[] } }>;
  };
  assert.equal(card.type, 'message');
  assert.equal(card.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(card.attachments[0].content.type, 'AdaptiveCard');
  assert.ok(card.attachments[0].content.body.length >= 2);
  assert.equal(card.attachments[0].content.actions.length, 1);
});

console.log(process.exitCode ? '\nSelf-check FAILED\n' : '\nAll checks passed\n');
