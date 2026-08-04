import assert from 'node:assert/strict';
import {
  INVOICE_STEPS, LEAD_STEPS, accountJourney, dealJourney, invoiceTrack,
  leadTrack, poTrack, quoteTrack,
} from './lifecycle.js';

/**
 * The rails are only worth drawing if they point at the right step.
 * `npm test --workspace=apps/web` runs this; no DOM, no framework.
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

console.log('\nZeus lifecycle check\n');

check('every on-path status lands on its own step', () => {
  for (const [index, status] of LEAD_STEPS.entries()) assert.equal(leadTrack(status).current, index);
  for (const [index, status] of INVOICE_STEPS.entries()) assert.equal(invoiceTrack(status).current, index);
});

check('nurturing sits beside working, it does not tick it off', () => {
  const track = leadTrack('NURTURING');
  assert.equal(track.current, LEAD_STEPS.indexOf('WORKING'));
  assert.equal(track.note, 'Nurturing');
  assert.equal(track.stopped, undefined);
  // The point of the change: a converted lead must not claim it was nurtured.
  assert.ok(!LEAD_STEPS.includes('NURTURING'));
});

check('a dead end stops on the step it died on', () => {
  assert.equal(quoteTrack('REJECTED').stopped, 'Rejected');
  assert.equal(quoteTrack('REJECTED').current, 1, 'a rejected quote still got as far as sent');
  assert.equal(leadTrack('DISQUALIFIED').stopped, 'Disqualified');
  assert.equal(poTrack('CANCELLED').current, 0);
});

check('overdue is sent with the clock run out, not a step of its own', () => {
  const track = invoiceTrack('OVERDUE');
  assert.equal(track.current, INVOICE_STEPS.indexOf('SENT'));
  assert.equal(track.note, 'Overdue');
  assert.equal(track.stopped, undefined);
});

check('a deal only counts documents that actually left draft', () => {
  const base = { status: 'OPEN', quotes: [], invoices: [] };
  assert.equal(dealJourney(base).current, 0);
  assert.equal(dealJourney({ ...base, quotes: [{ status: 'SENT' }] }).current, 1);
  assert.equal(dealJourney({ ...base, quotes: [{ status: 'ACCEPTED' }] }).current, 2);
  assert.equal(
    dealJourney({ ...base, quotes: [{ status: 'ACCEPTED' }], invoices: [{ status: 'DRAFT' }] }).current,
    2,
    'a draft invoice has not been raised on the customer',
  );
  assert.equal(dealJourney({ ...base, quotes: [{ status: 'ACCEPTED' }], invoices: [{ status: 'SENT' }] }).current, 3);
  assert.equal(dealJourney({ ...base, quotes: [{ status: 'ACCEPTED' }], invoices: [{ status: 'PAID' }] }).current, 4);
});

check('one unpaid invoice keeps the deal off "paid"', () => {
  const deal = { status: 'WON', quotes: [{ status: 'ACCEPTED' }], invoices: [{ status: 'PAID' }, { status: 'PARTIAL' }] };
  assert.equal(dealJourney(deal).current, 3);
  assert.equal(dealJourney(deal).note, 'Won');
});

check('a lost deal stops wherever its paperwork got to', () => {
  const track = dealJourney({ status: 'LOST', lostReason: 'Price', quotes: [{ status: 'SENT' }], invoices: [] });
  assert.equal(track.current, 1);
  assert.equal(track.stopped, 'Lost — Price');
});

check('an account is only "paying" once money moved', () => {
  const blank = { type: 'PROSPECT', deals: [], quotes: [], invoices: [] };
  assert.equal(accountJourney(blank).current, 0);
  assert.equal(accountJourney({ ...blank, deals: [{ status: 'OPEN' }] }).current, 1);
  assert.equal(accountJourney({ ...blank, deals: [{ status: 'OPEN' }], quotes: [{ status: 'SENT' }] }).current, 2);
  assert.equal(accountJourney({ ...blank, deals: [{ status: 'WON' }], quotes: [{ status: 'ACCEPTED' }] }).current, 3);
  assert.equal(
    accountJourney({ ...blank, deals: [{ status: 'WON' }], quotes: [], invoices: [{ status: 'SENT' }] }).current,
    3,
    'an issued invoice is not yet cash',
  );
  assert.equal(accountJourney({ ...blank, deals: [{ status: 'WON' }], quotes: [], invoices: [{ status: 'PARTIAL' }] }).current, 4);
});

check('the current step is always inside the track', () => {
  const all = [
    ...['NEW', 'WORKING', 'NURTURING', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED'].map(leadTrack),
    ...['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'].map(quoteTrack),
    ...['DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED'].map(invoiceTrack),
    ...['DRAFT', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'].map(poTrack),
  ];
  for (const track of all) {
    assert.ok(track.current >= 0 && track.current < track.steps.length, `out of range: ${JSON.stringify(track)}`);
  }
});

console.log(process.exitCode ? '\nLifecycle check FAILED\n' : '\nAll checks passed\n');
