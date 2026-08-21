import { access } from 'node:fs/promises';
import path from 'node:path';
import { prisma, num } from '../db.js';
import { env } from '../env.js';
import { logSystem } from './systemLog.js';
import { notify } from './notify.js';
import { taxDocumentTotals, round2 } from '../lib/money.js';

/**
 * Daily data-integrity sweep.
 *
 * The component monitor in systemStatus.ts answers "are the pipes connected" — is
 * Postgres reachable, is M365 up, is a backup recent. It would not notice a payment
 * that stopped adding up, a deal stranded in an impossible state, or an attachment
 * whose file vanished. Those failures are silent by nature and cost money and trust,
 * which is exactly why they need something that goes looking for them on a schedule.
 *
 * Two rules hold for everything in here:
 *   1. Every check is READ-ONLY. The sweep reports drift, it never repairs it —
 *      auto-repair hides the bug that caused the drift, and those bugs are real
 *      (a deal-status desync shipped in POST /api/deals and sat there unnoticed).
 *      Fixing is a separate, deliberate, human decision.
 *   2. A check names the records it is unhappy about. "3 invoices don't reconcile" is
 *      an alert nobody can act on; three ids can be opened.
 *
 * ponytail: loads each table it checks into memory rather than doing the arithmetic in
 * SQL. Right for this size (thousands of rows, once a day, off-peak). If a table ever
 * gets big enough to matter, move that one check to a raw aggregate query — the shape
 * here (one function per invariant, returning Finding) does not need to change for it.
 */

export interface Finding {
  /** Stable key so the same problem reads the same way every day. */
  check: string;
  label: string;
  count: number;
  /** A handful of offending record ids — enough to start looking, not a data dump. */
  examples: string[];
  detail: string;
}

export interface DataHealthReport {
  ok: boolean;
  checkedAt: string;
  findings: Finding[];
  /** Every check that ran, so a clean sweep still proves it looked. */
  checksRun: string[];
  durationMs: number;
}

/** Money rounds to fils; anything under half a fil is float noise, not drift. */
const EPSILON = 0.005;
const sample = (ids: string[]) => ids.slice(0, 5);

// ── money reconciles ──────────────────────────────────────────────────────────

/**
 * `Invoice.amountPaid` is derived, never typed: payments plus non-cancelled credit
 * notes (see refreshInvoicePayment in lib/commercial.ts). This asserts the stored
 * value still matches that sum — a crash between the payment write and the refresh,
 * a manual database edit, or a future bug would all break it silently.
 */
async function invoicePaymentsReconcile(): Promise<Finding> {
  const invoices = await prisma.invoice.findMany({
    select: {
      id: true, number: true, amountPaid: true,
      payments: { select: { amount: true } },
      creditNotes: { where: { status: { not: 'CANCELLED' } }, select: { total: true } },
    },
  });

  const bad: string[] = [];
  for (const inv of invoices) {
    const expected = inv.payments.reduce((s, p) => s + num(p.amount), 0)
      + inv.creditNotes.reduce((s, c) => s + num(c.total), 0);
    if (Math.abs(expected - num(inv.amountPaid)) > EPSILON) bad.push(inv.number);
  }

  return {
    check: 'invoice_payments_reconcile',
    label: 'Invoice paid amounts match their payments and credit notes',
    count: bad.length,
    examples: sample(bad),
    detail: bad.length
      ? `${bad.length} invoice(s) whose amountPaid does not equal payments + credit notes.`
      : `${invoices.length} invoice(s) reconcile.`,
  };
}

async function purchaseOrderPaymentsReconcile(): Promise<Finding> {
  const orders = await prisma.purchaseOrder.findMany({
    where: { deletedAt: null },
    select: { id: true, number: true, amountPaid: true, payments: { select: { amount: true } } },
  });

  const bad = orders
    .filter((po) => Math.abs(po.payments.reduce((s, p) => s + num(p.amount), 0) - num(po.amountPaid)) > EPSILON)
    .map((po) => po.number);

  return {
    check: 'po_payments_reconcile',
    label: 'Purchase order paid amounts match their payments',
    count: bad.length,
    examples: sample(bad),
    detail: bad.length
      ? `${bad.length} purchase order(s) whose amountPaid does not equal the sum of payments.`
      : `${orders.length} purchase order(s) reconcile.`,
  };
}

// ── document totals reconcile ─────────────────────────────────────────────────

/**
 * Header figures are recomputed from the lines on every write (recalcInvoice /
 * recalcQuote / recalcPurchaseOrder). Re-runs that same arithmetic and compares —
 * catching a document whose lines were changed without the totals following.
 */
async function documentTotalsReconcile(): Promise<Finding> {
  const bad: string[] = [];
  let checked = 0;

  const invoices = await prisma.invoice.findMany({
    select: {
      number: true, subtotal: true, vatAmount: true, total: true, discountPct: true, vatRate: true,
      lines: { select: { quantity: true, unitPrice: true, unitCost: true, discountPct: true, taxable: true, vatRate: true } },
    },
  });
  for (const doc of invoices) {
    checked += 1;
    if (doc.lines.length === 0) continue; // a document with no lines has nothing to reconcile against
    const t = taxDocumentTotals(
      doc.lines.map((l) => ({
        quantity: num(l.quantity), unitPrice: num(l.unitPrice), unitCost: num(l.unitCost ?? 0),
        discountPct: num(l.discountPct), taxable: l.taxable, vatRate: num(l.vatRate),
      })),
      { headerDiscountPct: num(doc.discountPct), defaultVatRate: num(doc.vatRate) },
    );
    if (Math.abs(t.total - num(doc.total)) > EPSILON || Math.abs(t.vatAmount - num(doc.vatAmount)) > EPSILON) {
      bad.push(doc.number);
    }
  }

  const quotes = await prisma.quote.findMany({
    select: {
      number: true, subtotal: true, vatAmount: true, total: true, discountPct: true, vatRate: true,
      lines: { select: { quantity: true, unitPrice: true, unitCost: true, discountPct: true, taxable: true } },
    },
  });
  for (const doc of quotes) {
    checked += 1;
    if (doc.lines.length === 0) continue;
    const t = taxDocumentTotals(
      doc.lines.map((l) => ({
        quantity: num(l.quantity), unitPrice: num(l.unitPrice), unitCost: num(l.unitCost ?? 0),
        discountPct: num(l.discountPct), taxable: l.taxable, vatRate: num(doc.vatRate),
      })),
      { headerDiscountPct: num(doc.discountPct), defaultVatRate: num(doc.vatRate) },
    );
    if (Math.abs(t.total - num(doc.total)) > EPSILON) bad.push(doc.number);
  }

  return {
    check: 'document_totals_reconcile',
    label: 'Invoice and quote totals match their line items',
    count: bad.length,
    examples: sample(bad),
    detail: bad.length
      ? `${bad.length} document(s) whose stored total does not match a recompute from its lines.`
      : `${checked} document(s) reconcile.`,
  };
}

// ── workflow states are possible ──────────────────────────────────────────────

/**
 * States the app should never be able to produce. The deal case is not hypothetical:
 * `POST /api/deals` used to leave a deal created directly into a won/lost stage at
 * status OPEN, which silently corrupted every won/lost report until it was fixed.
 */
async function workflowStatesPossible(): Promise<Finding> {
  const problems: string[] = [];

  const deals = await prisma.deal.findMany({
    where: { deletedAt: null },
    select: { reference: true, status: true, stage: { select: { isWon: true, isLost: true } } },
  });
  for (const d of deals) {
    if (d.stage.isWon && d.status !== 'WON') problems.push(`${d.reference} (won stage, status ${d.status})`);
    else if (d.stage.isLost && d.status !== 'LOST') problems.push(`${d.reference} (lost stage, status ${d.status})`);
    else if (!d.stage.isWon && !d.stage.isLost && d.status !== 'OPEN') problems.push(`${d.reference} (open stage, status ${d.status})`);
  }

  const invoices = await prisma.invoice.findMany({
    where: { status: { in: ['PAID', 'SENT', 'PARTIAL', 'OVERDUE'] } },
    select: { number: true, status: true, total: true, amountPaid: true, sentAt: true },
  });
  for (const inv of invoices) {
    const balance = num(inv.total) - num(inv.amountPaid);
    if (inv.status === 'PAID' && balance > EPSILON) {
      problems.push(`${inv.number} (marked PAID, ${round2(balance)} still outstanding)`);
    }
    // Leaving DRAFT always stamps sentAt (POST /invoices/:id/status), and PARTIAL /
    // PAID / OVERDUE are only reachable from SENT — so a payment-state invoice with no
    // sentAt means something wrote the status directly, bypassing the transition.
    if (!inv.sentAt) problems.push(`${inv.number} (status ${inv.status} but never marked sent)`);
  }

  return {
    check: 'workflow_states_possible',
    label: 'No record is stranded in an impossible state',
    count: problems.length,
    examples: sample(problems),
    detail: problems.length
      ? `${problems.length} record(s) in a state the app should not be able to produce.`
      : `${deals.length} deal(s) and ${invoices.length} invoice(s) are in valid states.`,
  };
}

// ── soft-delete referential drift ─────────────────────────────────────────────

/**
 * Postgres foreign keys cannot catch this: `deletedAt` is a column, not a delete, so a
 * live deal pointing at a soft-deleted account satisfies every constraint while being
 * exactly the kind of record that renders as a blank name in the UI.
 */
async function softDeleteDrift(): Promise<Finding> {
  const [deals, contacts, quotes, invoices] = await Promise.all([
    prisma.deal.findMany({
      where: { deletedAt: null, account: { deletedAt: { not: null } } },
      select: { reference: true },
    }),
    prisma.contact.findMany({
      where: { deletedAt: null, accountId: { not: null }, account: { deletedAt: { not: null } } },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.quote.findMany({
      where: { account: { deletedAt: { not: null } } },
      select: { number: true },
    }),
    prisma.invoice.findMany({
      where: { account: { deletedAt: { not: null } } },
      select: { number: true },
    }),
  ]);

  const problems = [
    ...deals.map((d) => `deal ${d.reference}`),
    ...contacts.map((c) => `contact ${c.firstName} ${c.lastName}`),
    ...quotes.map((q) => `quote ${q.number}`),
    ...invoices.map((i) => `invoice ${i.number}`),
  ];

  return {
    check: 'soft_delete_drift',
    label: 'No live record points at a deleted parent',
    count: problems.length,
    examples: sample(problems),
    detail: problems.length
      ? `${problems.length} live record(s) whose account has been deleted.`
      : 'No live record points at a deleted account.',
  };
}

// ── files match rows ──────────────────────────────────────────────────────────

/** An attachment row whose file is gone downloads as a 404 the moment a user clicks
 * it. Better to know on the day it happens than from the person who needed the file. */
async function attachmentFilesPresent(): Promise<Finding> {
  const attachments = await prisma.attachment.findMany({ select: { id: true, filename: true, storedName: true } });

  const missing: string[] = [];
  for (const a of attachments) {
    try {
      await access(path.join(env.UPLOAD_DIR, path.basename(a.storedName)));
    } catch {
      missing.push(a.filename);
    }
  }

  return {
    check: 'attachment_files_present',
    label: 'Every attachment row still has its file on disk',
    count: missing.length,
    examples: sample(missing),
    detail: missing.length
      ? `${missing.length} attachment(s) whose file is missing from the uploads directory.`
      : `${attachments.length} attachment(s) present.`,
  };
}

/**
 * Complements the freshness checks elsewhere: `backupsComponent()` asks whether a run
 * succeeded recently and `checkMissedBackups()` asks whether each kind is on schedule.
 * Neither opens the cupboard. This confirms the newest local file of each kind is
 * actually there, at the size that was recorded.
 */
async function backupFilesPresent(): Promise<Finding> {
  const problems: string[] = [];
  let checked = 0;

  for (const kind of ['physical', 'logical', 'config'] as const) {
    const run = await prisma.backupRun.findFirst({
      where: { kind, status: { in: ['success', 'partial'] }, filename: { not: null }, destinations: { has: 'local' } },
      orderBy: { startedAt: 'desc' },
      select: { filename: true, sizeBytes: true },
    });
    if (!run?.filename) continue;
    checked += 1;

    try {
      const { stat } = await import('node:fs/promises');
      const onDisk = await stat(path.join(env.BACKUP_DIR, run.filename));
      if (run.sizeBytes && onDisk.size !== run.sizeBytes) {
        problems.push(`${run.filename} (recorded ${run.sizeBytes} bytes, found ${onDisk.size})`);
      }
    } catch {
      problems.push(`${run.filename} (missing from ${env.BACKUP_DIR})`);
    }
  }

  return {
    check: 'backup_files_present',
    label: 'The newest local backup of each kind is really on disk',
    count: problems.length,
    examples: sample(problems),
    detail: problems.length
      ? `${problems.length} backup file(s) missing or the wrong size.`
      : `${checked} backup file(s) present at the recorded size.`,
  };
}

// ── the sweep ─────────────────────────────────────────────────────────────────

const CHECKS = [
  invoicePaymentsReconcile,
  purchaseOrderPaymentsReconcile,
  documentTotalsReconcile,
  workflowStatesPossible,
  softDeleteDrift,
  attachmentFilesPresent,
  backupFilesPresent,
];

/**
 * Run every check and return the report. Read-only — safe to call by hand at any time,
 * which is also how the System status page offers it.
 *
 * One failing check never stops the others: a check that throws is itself reported as
 * a finding, because "the integrity check is broken" is exactly as worth knowing as
 * anything it would have found.
 */
export async function runDataHealthChecks(): Promise<DataHealthReport> {
  const started = Date.now();
  const findings: Finding[] = [];
  const checksRun: string[] = [];

  for (const check of CHECKS) {
    try {
      const finding = await check();
      checksRun.push(finding.check);
      if (finding.count > 0) findings.push(finding);
    } catch (err) {
      const name = check.name || 'unknown_check';
      checksRun.push(name);
      findings.push({
        check: name,
        label: 'Integrity check failed to run',
        count: 1,
        examples: [],
        detail: `${name} threw: ${(err as Error).message}`,
      });
    }
  }

  return {
    ok: findings.length === 0,
    checkedAt: new Date().toISOString(),
    findings,
    checksRun,
    durationMs: Date.now() - started,
  };
}

/**
 * The scheduled entry point. Records every sweep in the system log so a clean run is
 * evidence rather than silence, and alerts admins only when something is actually
 * wrong — a daily "all fine" notification trains people to ignore the alert that
 * matters.
 */
export async function dailyDataHealthSweep(): Promise<DataHealthReport> {
  const report = await runDataHealthChecks();

  if (report.ok) {
    logSystem('info', 'app', `Data integrity sweep clean — ${report.checksRun.length} checks in ${report.durationMs}ms.`, {
      checks: report.checksRun.length,
    });
    return report;
  }

  const summary = report.findings.map((f) => `${f.label}: ${f.count}`).join('\n');
  const detail = report.findings
    .map((f) => `${f.label} — ${f.detail}${f.examples.length ? ` e.g. ${f.examples.join(', ')}` : ''}`)
    .join('\n');

  logSystem('error', 'app', `Data integrity sweep found ${report.findings.length} problem(s).`, {
    findings: report.findings.map((f) => ({ check: f.check, count: f.count })),
  });

  await notify({
    event: 'data_integrity_failed',
    title: `Data integrity: ${report.findings.length} problem(s) found`,
    body: `${summary}\n\n${detail}`,
    severity: 'critical',
  });

  return report;
}
