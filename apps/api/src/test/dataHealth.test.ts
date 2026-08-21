import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Both directories are inspected by the sweep, so point them somewhere disposable
// before anything reads env.
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-dh-uploads-'));
process.env.BACKUP_DIR = mkdtempSync(path.join(tmpdir(), 'zeus-dh-backups-'));

const { migrateTestDatabase, prisma, resetDatabase, seedFixtures } = await import('./harness.js');
const { runDataHealthChecks } = await import('../services/dataHealth.js');

let app: Awaited<ReturnType<typeof import('../app.js')['buildApp']>>;
let fx: Awaited<ReturnType<typeof seedFixtures>>;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

/** The one finding for `check`, or undefined when that check was happy. */
async function finding(check: string) {
  const report = await runDataHealthChecks();
  return report.findings.find((f) => f.check === check);
}

async function makeInvoice(total: number, over: Record<string, unknown> = {}) {
  return prisma.invoice.create({
    data: {
      number: `INV-${Math.random().toString(36).slice(2, 8)}`,
      accountId: fx.customer.id, status: 'SENT', sentAt: new Date(),
      subtotal: total, vatAmount: 0, total, amountPaid: 0,
      createdById: fx.admin.id,
      ...over,
    },
  });
}

describe('a healthy database', () => {
  it('passes every check and says which ones it ran', async () => {
    const report = await runDataHealthChecks();
    assert.equal(report.ok, true, JSON.stringify(report.findings, null, 2));
    assert.equal(report.findings.length, 0);
    assert.ok(report.checksRun.length >= 7, 'a clean sweep still proves it looked');
    assert.ok(report.checksRun.includes('invoice_payments_reconcile'));
  });
});

describe('money reconciles', () => {
  it('catches an invoice whose amountPaid no longer matches its payments', async () => {
    const invoice = await makeInvoice(1000);
    await prisma.payment.create({
      data: { direction: 'INCOMING', amount: 400, accountId: fx.customer.id, invoiceId: invoice.id, recordedById: fx.admin.id },
    });
    // What a crash between the payment write and refreshInvoicePayment would leave.
    await prisma.invoice.update({ where: { id: invoice.id }, data: { amountPaid: 400 } });
    assert.equal(await finding('invoice_payments_reconcile'), undefined, 'in sync to start with');

    await prisma.invoice.update({ where: { id: invoice.id }, data: { amountPaid: 999 } });
    const f = await finding('invoice_payments_reconcile');
    assert.ok(f, 'drift is caught');
    assert.equal(f?.count, 1);
    assert.ok(f?.examples[0]?.includes('INV-'), 'the finding names the invoice');
  });

  it('counts non-cancelled credit notes as settlement, not as drift', async () => {
    const invoice = await makeInvoice(1000);
    await prisma.invoice.create({
      data: {
        number: `CN-${Math.random().toString(36).slice(2, 8)}`,
        accountId: fx.customer.id, type: 'CREDIT_NOTE', status: 'SENT', sentAt: new Date(),
        subtotal: 250, vatAmount: 0, total: 250, originalInvoiceId: invoice.id, createdById: fx.admin.id,
      },
    });
    // amountPaid must equal payments + credit notes — a check that only summed
    // payments would report every credited invoice as broken.
    await prisma.invoice.update({ where: { id: invoice.id }, data: { amountPaid: 250 } });
    assert.equal(await finding('invoice_payments_reconcile'), undefined);
  });

  it('catches a purchase order whose amountPaid drifted', async () => {
    const po = await prisma.purchaseOrder.create({
      data: {
        number: `PO-${Math.random().toString(36).slice(2, 8)}`, direction: 'SUPPLIER',
        accountId: fx.vendor.id, subtotal: 500, vatAmount: 0, total: 500, amountPaid: 500,
        createdById: fx.admin.id,
      },
    });
    const f = await finding('po_payments_reconcile');
    assert.ok(f, 'claims 500 paid with no payment rows behind it');
    assert.ok(f?.examples[0]?.includes(po.number));
  });
});

describe('document totals reconcile', () => {
  it('catches a total that no longer matches its lines', async () => {
    const invoice = await makeInvoice(100, { subtotal: 100, total: 100, vatRate: 0 });
    await prisma.invoiceLine.create({
      data: {
        invoiceId: invoice.id, order: 0, description: 'One widget',
        quantity: 1, unitPrice: 100, unitCost: 0, discountPct: 0, taxable: false, vatRate: 0,
        lineTotal: 100, lineVat: 0, lineCost: 0,
      },
    });
    assert.equal(await finding('document_totals_reconcile'), undefined, 'header matches the line');

    // Someone edits the line without the totals following.
    await prisma.invoiceLine.updateMany({ where: { invoiceId: invoice.id }, data: { quantity: 5 } });
    const f = await finding('document_totals_reconcile');
    assert.ok(f, '5 x 100 no longer totals 100');
    assert.equal(f?.count, 1);
  });
});

describe('workflow states are possible', () => {
  it('catches a deal sitting in a won stage with an open status', async () => {
    const won = fx.pipeline.stages.find((s) => s.isWon)!;
    const deal = await prisma.deal.create({
      data: {
        reference: `T-${Math.random().toString(36).slice(2, 8)}`, name: 'Stranded deal',
        accountId: fx.customer.id, pipelineId: fx.pipeline.id, stageId: won.id,
        status: 'OPEN', // exactly what the POST /api/deals bug used to write
        amount: 1000, cost: 0, vatRate: 5, vatAmount: 50, totalAmount: 1050,
        probability: 10, closeDate: new Date(), ownerId: fx.rep.id,
      },
    });

    const f = await finding('workflow_states_possible');
    assert.ok(f, 'the exact corruption the deal-status bug produced');
    assert.ok(f?.examples.some((e) => e.includes(deal.reference)));
  });

  it('catches an invoice marked PAID that still owes money', async () => {
    await makeInvoice(1000, { status: 'PAID', amountPaid: 400 });
    const f = await finding('workflow_states_possible');
    assert.ok(f);
    assert.ok(f?.examples.some((e) => e.includes('still outstanding')));
  });

  it('is quiet about a correctly closed deal', async () => {
    const won = fx.pipeline.stages.find((s) => s.isWon)!;
    await prisma.deal.create({
      data: {
        reference: `T-${Math.random().toString(36).slice(2, 8)}`, name: 'Properly won',
        accountId: fx.customer.id, pipelineId: fx.pipeline.id, stageId: won.id,
        status: 'WON', amount: 1000, cost: 0, vatRate: 5, vatAmount: 50, totalAmount: 1050,
        probability: 100, closeDate: new Date(), closedAt: new Date(), ownerId: fx.rep.id,
      },
    });
    assert.equal(await finding('workflow_states_possible'), undefined);
  });
});

describe('soft-delete drift', () => {
  it('catches a live deal whose account has been deleted', async () => {
    const deal = await prisma.deal.create({
      data: {
        reference: `T-${Math.random().toString(36).slice(2, 8)}`, name: 'Orphan',
        accountId: fx.customer.id, pipelineId: fx.pipeline.id, stageId: fx.pipeline.stages[0].id,
        amount: 1, cost: 0, vatRate: 5, vatAmount: 0, totalAmount: 1,
        probability: 10, closeDate: new Date(), ownerId: fx.rep.id,
      },
    });
    assert.equal(await finding('soft_delete_drift'), undefined);

    // Foreign keys are perfectly happy with this — deletedAt is a column, not a delete.
    await prisma.account.update({ where: { id: fx.customer.id }, data: { deletedAt: new Date() } });

    const f = await finding('soft_delete_drift');
    assert.ok(f, 'no FK in Postgres can catch a soft-deleted parent');
    assert.ok(f?.examples.some((e) => e.includes(deal.reference)));
  });
});

describe('files match rows', () => {
  it('catches an attachment row whose file has vanished', async () => {
    const storedName = `${Math.random().toString(36).slice(2)}.txt`;
    const full = path.join(process.env.UPLOAD_DIR!, storedName);
    writeFileSync(full, 'present');
    await prisma.attachment.create({
      data: {
        filename: 'contract.txt', storedName, mimeType: 'text/plain', sizeBytes: 7,
        uploadedById: fx.admin.id, accountId: fx.customer.id,
      },
    });
    assert.equal(await finding('attachment_files_present'), undefined, 'file is there');

    rmSync(full);
    const f = await finding('attachment_files_present');
    assert.ok(f, 'found before a user clicks the download and gets a 404');
    assert.equal(f?.examples[0], 'contract.txt');
  });

  it('catches a backup recorded as local whose file is not on disk', async () => {
    await prisma.backupRun.create({
      data: {
        kind: 'physical', tier: 'daily', status: 'success',
        filename: 'zeus-physical-gone.sql.gz', sizeBytes: 1234,
        destinations: ['local'], encrypted: false, finishedAt: new Date(),
      },
    });
    const f = await finding('backup_files_present');
    assert.ok(f, 'a backup you cannot open is not a backup');
    assert.ok(f?.examples[0]?.includes('missing'));
  });
});

describe('the sweep itself is resilient', () => {
  it('reports every finding together rather than stopping at the first', async () => {
    await makeInvoice(1000, { status: 'PAID', amountPaid: 0 });
    await prisma.backupRun.create({
      data: {
        kind: 'logical', tier: 'daily', status: 'success', filename: 'not-there.ndjson.gz',
        sizeBytes: 10, destinations: ['local'], encrypted: false, finishedAt: new Date(),
      },
    });

    const report = await runDataHealthChecks();
    assert.equal(report.ok, false);
    assert.ok(report.findings.length >= 2, 'one bad check does not mask another');
    assert.ok(report.durationMs >= 0);
  });
});
