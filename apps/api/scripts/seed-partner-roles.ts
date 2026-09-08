import { prisma } from '../src/db.js';

/**
 * Staging only: two people at Staging Partner LLC, each named on a different
 * registration. Pat is the account's primary contact, so the portal treats Pat as the
 * partner's admin — the role scoping and the filter bar can then be looked at in a browser.
 */
const account = await prisma.account.findFirstOrThrow({ where: { name: 'Staging Partner LLC' } });
const pat = await prisma.contact.findFirstOrThrow({ where: { email: 'pat@staging-partner.example' } });

let sam = await prisma.contact.findFirst({ where: { email: 'sam@staging-partner.example' } });
if (!sam) sam = await prisma.contact.create({ data: { firstName: 'Sam', lastName: 'Sales', email: 'sam@staging-partner.example', accountId: account.id } });
await prisma.portalUser.upsert({ where: { contactId: sam.id }, create: { contactId: sam.id, email: sam.email! }, update: {} });
await prisma.contact.updateMany({ where: { accountId: account.id, id: { not: pat.id } }, data: { isPrimary: false } });
await prisma.contact.update({ where: { id: pat.id }, data: { isPrimary: true } });

// 038 under Pat, 039 under Sam.
for (const [ref, contactId] of [['ZEU-D-000038', pat.id], ['ZEU-D-000039', sam.id]] as const) {
  const deal = await prisma.deal.findFirstOrThrow({ where: { reference: ref } });
  await prisma.dealRegistration.updateMany({ where: { dealId: deal.id, side: 'PARTNER', partnerId: account.id }, data: { partnerContactId: contactId } });
}
console.log('Pat = primary contact (sees all) · Sam = member (sees ZEU-D-000039 only)');
await prisma.$disconnect();
