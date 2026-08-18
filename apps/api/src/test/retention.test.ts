import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrateTestDatabase, prisma, request, resetDatabase, seedFixtures, type Fixtures } from './harness.js';
import { setSetting, invalidateSettings } from '../lib/settings.js';
import { pruneLoginAudit, purgeExpiredLeads } from '../services/retention.js';

let app: FastifyInstance;
let fx: Fixtures;

before(async () => {
  migrateTestDatabase();
  const { buildApp } = await import('../app.js');
  app = await buildApp();
});
after(async () => { await app.close(); await prisma.$disconnect(); });
beforeEach(async () => { await resetDatabase(); fx = await seedFixtures(app); });

describe('right to erasure', () => {
  it('scrubs a contact\'s PII but keeps the row and its relations', async () => {
    const contact = await prisma.contact.create({
      data: { firstName: 'Ahmed', lastName: 'Al Farsi', email: 'ahmed@customer.ae', phone: '+9715000', ownerId: fx.rep.id },
    });

    const res = await request(app, fx.admin).post(`/api/contacts/${contact.id}/erase`, { reason: 'Customer requested deletion under GDPR.' });
    assert.equal(res.status, 200);

    const after = await prisma.contact.findUnique({ where: { id: contact.id } });
    assert.equal(after?.firstName, 'Erased');
    assert.equal(after?.email, null);
    assert.equal(after?.phone, null);
    assert.ok(after?.erasedAt);
    assert.ok(after?.deletedAt);

    // Cannot be erased twice.
    const again = await request(app, fx.admin).post(`/api/contacts/${contact.id}/erase`, { reason: 'Retry.' });
    assert.equal(again.status, 400);
  });

  it('requires a reason', async () => {
    const contact = await prisma.contact.create({ data: { firstName: 'A', lastName: 'B', ownerId: fx.rep.id } });
    const res = await request(app, fx.admin).post(`/api/contacts/${contact.id}/erase`, {});
    assert.equal(res.status, 400);
  });

  it('scrubs a lead\'s PII but keeps the company/status history', async () => {
    const lead = await prisma.lead.create({
      data: { firstName: 'Sara', lastName: 'Khan', company: 'Acme LLC', email: 'sara@acme.ae', ownerId: fx.rep.id, status: 'QUALIFIED' },
    });

    const res = await request(app, fx.admin).post(`/api/leads/${lead.id}/erase`, { reason: 'Right to erasure request.' });
    assert.equal(res.status, 200);

    const after = await prisma.lead.findUnique({ where: { id: lead.id } });
    assert.equal(after?.firstName, 'Erased');
    assert.equal(after?.email, null);
    assert.equal(after?.company, 'Acme LLC', 'business record, not personal data — stays');
    assert.equal(after?.status, 'QUALIFIED');
    assert.ok(after?.erasedAt);
  });
});

describe('retention sweeps', () => {
  it('leaves login-audit rows alone when retention is off (0)', async () => {
    await setSetting('auth.loginAuditRetentionDays', 0);
    invalidateSettings();
    await prisma.auditLog.create({ data: { action: 'login', entity: 'User', entityId: fx.rep.id, ip: '1.2.3.4', at: new Date(0) } });

    const removed = await pruneLoginAudit();
    assert.equal(removed, 0);
    assert.equal(await prisma.auditLog.count({ where: { action: 'login' } }), 1);
  });

  it('prunes old login-audit rows but leaves recent ones and other actions', async () => {
    await setSetting('auth.loginAuditRetentionDays', 30);
    invalidateSettings();
    await prisma.auditLog.createMany({
      data: [
        { action: 'login', entity: 'User', entityId: fx.rep.id, ip: '1.2.3.4', at: new Date(Date.now() - 90 * 86_400_000) },
        { action: 'login_failed', entity: 'User', entityId: fx.rep.id, ip: '1.2.3.4', at: new Date(Date.now() - 90 * 86_400_000) },
        { action: 'login', entity: 'User', entityId: fx.rep.id, ip: '1.2.3.4', at: new Date() },
        { action: 'update', entity: 'Deal', entityId: 'x', at: new Date(Date.now() - 90 * 86_400_000) },
      ],
    });

    const removed = await pruneLoginAudit();
    assert.equal(removed, 2);
    assert.equal(await prisma.auditLog.count(), 2, 'the recent login and the unrelated update both survive');
  });

  it('purges an abandoned soft-deleted lead but keeps one with activity on it', async () => {
    await setSetting('retention.deletedLeadDays', 30);
    invalidateSettings();

    const old = Date.now() - 90 * 86_400_000;
    const abandoned = await prisma.lead.create({
      data: { firstName: 'A', lastName: 'B', company: 'Gone', deletedAt: new Date(old) },
    });
    const worked = await prisma.lead.create({
      data: { firstName: 'C', lastName: 'D', company: 'Kept', deletedAt: new Date(old) },
    });
    await prisma.activity.create({
      data: { type: 'NOTE', subject: 'Called', status: 'Completed', leadId: worked.id },
    });
    const recent = await prisma.lead.create({
      data: { firstName: 'E', lastName: 'F', company: 'TooRecent', deletedAt: new Date() },
    });

    const purged = await purgeExpiredLeads();
    assert.equal(purged, 1);
    assert.equal(await prisma.lead.findUnique({ where: { id: abandoned.id } }), null);
    assert.ok(await prisma.lead.findUnique({ where: { id: worked.id } }));
    assert.ok(await prisma.lead.findUnique({ where: { id: recent.id } }));
  });
});
