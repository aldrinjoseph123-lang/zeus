import { prisma } from '../src/db.js';

/** Staging only: a handful of representative rows so the Email log screen has something to show. */
const admin = await prisma.user.findFirst({ where: { email: 'uat-admin@example.com' } });
const day = 86_400_000;
const rows = [
  { to: ['ap@emiratesnbd.example'], subject: 'Quotation ZEU-Q-000012 from Protect24x7', kind: 'quote', status: 'SENT', entity: 'Quote', entityId: 'q-demo', attachments: ['ZEU-Q-000012.pdf'], preview: 'Please find attached quotation ZEU-Q-000012 for AED 189,000.00 including VAT.', userId: admin?.id, createdAt: new Date(Date.now() - 2 * day) },
  { to: ['finance@gulfsystems.example'], cc: ['siju@protect24x7.com'], subject: 'Tax invoice ZEU-INV-000021', kind: 'invoice', status: 'SENT', entity: 'Invoice', entityId: 'i-demo', attachments: ['ZEU-INV-000021.pdf'], preview: 'Please find attached tax invoice ZEU-INV-000021 for AED 10,500.00.', userId: admin?.id, createdAt: new Date(Date.now() - day) },
  { to: ['pat@staging-partner.example'], subject: 'Set your Protect24x7 portal password', kind: 'portal_link', status: 'SENT', entity: 'PortalUser', entityId: 'pu-demo', preview: 'Use the link below to choose a password. It is good for 60 minutes.', createdAt: new Date(Date.now() - 3_600_000) },
  { to: ['ops@crowdstrike.example'], subject: 'Purchase order ZEU-PO-000008', kind: 'purchase_order', status: 'FAILED', entity: 'PurchaseOrder', entityId: 'po-demo', attachments: ['ZEU-PO-000008.pdf'], preview: 'Please find attached purchase order ZEU-PO-000008. Kindly acknowledge receipt.', error: 'Graph sendMail failed (400): {"error":{"code":"ErrorInvalidRecipients","message":"At least one recipient is not valid."}}', userId: admin?.id, payload: { html: '<p>Please find attached purchase order ZEU-PO-000008.</p>', attachments: [] }, createdAt: new Date(Date.now() - 1_800_000) },
  { to: ['siju@protect24x7.com'], subject: '[Zeus] Deal registration expiring — Emirates NBD', kind: 'notification', status: 'SENT', entity: 'Notification', entityId: 'registration_expiring', preview: 'Your protection on Emirates NBD lapses in 9 days.', createdAt: new Date(Date.now() - 600_000) },
];
for (const r of rows) await prisma.emailLog.create({ data: r as never });
console.log('seeded', rows.length, 'email rows');
await prisma.$disconnect();
