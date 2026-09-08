import { prisma } from '../src/db.js';

/** Staging only: a sent quote on a Staging Partner deal, so the partner screen has a quoted amount to show. */
const B = 'http://localhost:4000';
const login = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'uat-admin@example.com', password: 'Uat-E8sGg-eYN-gw' }) });
const cookie = (login.headers.get('set-cookie') ?? '').match(/zeus_session=[^;]+/)?.[0] ?? '';
const H = { cookie, 'content-type': 'application/json' };

const deal = await prisma.deal.findFirstOrThrow({ where: { reference: 'ZEU-D-000038' }, select: { id: true, accountId: true, name: true } });
const product = await prisma.product.findFirstOrThrow({ select: { id: true, name: true } });
const res = await fetch(`${B}/api/quotes`, { method: 'POST', headers: H, body: JSON.stringify({
  accountId: deal.accountId, dealId: deal.id,
  lines: [{ productId: product.id, description: `${product.name} — 250 endpoints`, quantity: 250, unitPrice: 720, unitCost: 0, discountPct: 0, taxable: true }],
}) });
const quote = (await res.json()) as { id: string; number: string };
if (!res.ok) throw new Error(JSON.stringify(quote));
const sent = await prisma.quote.update({ where: { id: quote.id }, data: { status: 'SENT', sentAt: new Date() }, select: { number: true, total: true } });
console.log(`${sent.number} sent on ${deal.name}: AED ${Number(sent.total).toLocaleString()}`);
await prisma.$disconnect();
