import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures } from './harness.js';
import type { Fixtures } from './harness.js';
import { NOTIFICATION_EVENTS } from '../services/notify.js';

/**
 * Portal plan, phase 0: the positive half of the partner story. Until now a partner
 * only ever heard from Zeus when protection was running out. A PARTNER-side
 * registration moving to APPROVED now tells the deal owner in-app and mails the
 * partner — once, on the transition, and never for the vendor side.
 *
 * Mail itself is not sent under test (Microsoft 365 is not configured), which is
 * exactly the production case where it is not set up yet: the save must still
 * succeed and the notification must say the partner was not reached.
 */
let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  await migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

async function makeDealWithPartner() {
  const partner = await request(app, fx.admin).post('/api/accounts', { name: 'Channel Partner LLC', type: 'PARTNER', ignoreDuplicates: true });
  const partnerId = (partner.body as { id: string }).id;
  const contact = await request(app, fx.admin).post('/api/contacts', { firstName: 'Pat', lastName: 'Partner', email: 'pat@partner.example', accountId: partnerId, ignoreDuplicates: true });
  const deal = await request(app, fx.admin).post('/api/deals', { name: 'Protected opportunity', accountId: fx.customer.id, amount: 50000, ignoreDuplicates: true });
  assert.equal(deal.status, 201, JSON.stringify(deal.body));
  return { partnerId, partnerContactId: (contact.body as { id: string }).id, dealId: (deal.body as { id: string }).id };
}

const approvalNotifications = () => prisma.notification.findMany({ where: { type: 'registration_approved' } });

describe('partner registration approval', () => {
  it('is a configurable notification event', () => {
    const ev = NOTIFICATION_EVENTS.find((e) => e.event === 'registration_approved');
    assert.ok(ev, 'registration_approved must be in NOTIFICATION_EVENTS');
    assert.equal(ev.defaults.inApp, true);
  });

  it('moving a PARTNER-side registration to APPROVED notifies the deal owner once', async () => {
    const { partnerId, partnerContactId, dealId } = await makeDealWithPartner();
    const created = await request(app, fx.admin).post(`/api/deals/${dealId}/registrations`, { side: 'PARTNER', partnerId, partnerContactId, status: 'SUBMITTED' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const regId = (created.body as { id: string }).id;
    assert.equal((await approvalNotifications()).length, 0, 'nothing on submit');

    const approved = await request(app, fx.admin).patch(`/api/registrations/${regId}`, { status: 'APPROVED' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    let rows = await approvalNotifications();
    assert.equal(rows.length, 1, 'one notification on the transition');
    assert.match(rows[0].title, /Registration approved/);
    assert.match(rows[0].title, /Channel Partner LLC/);
    // Mail could not go out (no Microsoft 365 under test) — the save still succeeded and the
    // notification says so rather than pretending the partner was told.
    assert.match(rows[0].body ?? '', /not mailed/i);

    // Re-saving an approved row is not a second approval.
    const again = await request(app, fx.admin).patch(`/api/registrations/${regId}`, { notes: 'touched' });
    assert.equal(again.status, 200);
    rows = await approvalNotifications();
    assert.equal(rows.length, 1, 'no duplicate on a later edit');
  });

  it('creating a registration already APPROVED counts as the transition', async () => {
    const { partnerId, partnerContactId, dealId } = await makeDealWithPartner();
    const created = await request(app, fx.admin).post(`/api/deals/${dealId}/registrations`, { side: 'PARTNER', partnerId, partnerContactId, status: 'APPROVED' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await approvalNotifications()).length, 1);
  });

  it('the vendor side never mails a partner', async () => {
    const { dealId } = await makeDealWithPartner();
    const vendor = await request(app, fx.admin).post('/api/accounts', { name: 'Vendor Inc', type: 'VENDOR', ignoreDuplicates: true });
    const created = await request(app, fx.admin).post(`/api/deals/${dealId}/registrations`, { side: 'VENDOR', vendorId: (vendor.body as { id: string }).id, status: 'SUBMITTED' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const approved = await request(app, fx.admin).patch(`/api/registrations/${(created.body as { id: string }).id}`, { status: 'APPROVED' });
    assert.equal(approved.status, 200);
    assert.equal((await approvalNotifications()).length, 0);
  });
});
