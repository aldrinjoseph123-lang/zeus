import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { can, documentScope, scopeWhere } from '../auth/rbac.js';
import { HttpError } from '../lib/http.js';

/**
 * One request behind the ⌘K palette.
 *
 * It used to be four list calls from the browser, each returning whole rows for the
 * palette to throw away; now it is one call returning a name, a line under it and a
 * link, for every kind of record a person types the number or name of — including the
 * quotes, invoices and purchase orders the palette could not find before. Each finder
 * matches the same fields as that record's own list, and reads under the same permission
 * and scope, so the palette never shows what the list would not.
 */
const LIMIT = 5;

type Kind = 'deal' | 'account' | 'lead' | 'contact';
interface Row { id: string; primary: string; secondary: string; path: string; type?: Kind }
interface Found extends Row { keys: string[] }
export interface Group { label: string; rows: Row[] }

const like = (q: string) => ({ contains: q, mode: 'insensitive' as const });
const person = (r: { firstName: string; lastName: string }) => `${r.firstName} ${r.lastName}`.trim();

/** An exact match on what was typed outranks a prefix, which outranks a mention. */
function rank(row: Found, q: string): number {
  const keys = row.keys.map((k) => k.toLowerCase());
  return keys.includes(q) ? 0 : keys.some((k) => k.startsWith(q)) ? 1 : 2;
}

export default async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/search', async (request): Promise<{ groups: Group[] }> => {
    const user = request.user;
    if (!user) throw new HttpError(401, 'Sign in required.');
    const q = String((request.query as { q?: string }).q ?? '').trim();
    if (q.length < 2) return { groups: [] };
    const lower = q.toLowerCase();
    const recent = { updatedAt: 'desc' as const };

    const finders: Array<[string, string, () => Promise<Found[]>]> = [
      ['Deals', 'deals', async () => (await prisma.deal.findMany({
        where: { deletedAt: null, ...(await scopeWhere(user, 'deals')), OR: [{ name: like(q) }, { reference: like(q) }, { account: { name: like(q) } }, { account: { domain: { contains: lower } } }] },
        select: { id: true, reference: true, name: true, account: { select: { name: true } } }, take: LIMIT, orderBy: recent,
      })).map((d) => ({ id: d.id, primary: `${d.reference} · ${d.name}`, secondary: d.account.name, path: `/deals/${d.id}`, type: 'deal' as const, keys: [d.reference, d.name] }))],

      ['Accounts', 'accounts', async () => (await prisma.account.findMany({
        where: { deletedAt: null, ...(await scopeWhere(user, 'accounts')), OR: [{ name: like(q) }, { domain: { contains: lower } }, { email: like(q) }, { trn: { contains: q } }] },
        select: { id: true, name: true, type: true }, take: LIMIT, orderBy: recent,
      })).map((a) => ({ id: a.id, primary: a.name, secondary: a.type, path: `/accounts/${a.id}`, type: 'account' as const, keys: [a.name] }))],

      ['Leads', 'leads', async () => (await prisma.lead.findMany({
        where: { deletedAt: null, ...(await scopeWhere(user, 'leads')), OR: [{ firstName: like(q) }, { lastName: like(q) }, { company: like(q) }, { email: like(q) }, { domain: { contains: lower } }] },
        select: { id: true, firstName: true, lastName: true, company: true }, take: LIMIT, orderBy: recent,
      })).map((l) => ({ id: l.id, primary: person(l), secondary: l.company, path: `/leads/${l.id}`, type: 'lead' as const, keys: [person(l), l.company] }))],

      ['Contacts', 'contacts', async () => (await prisma.contact.findMany({
        where: { deletedAt: null, ...(await scopeWhere(user, 'contacts')), OR: [{ firstName: like(q) }, { lastName: like(q) }, { email: like(q) }, { phone: { contains: q } }, { account: { name: like(q) } }] },
        select: { id: true, firstName: true, lastName: true, account: { select: { name: true } } }, take: LIMIT, orderBy: recent,
      })).map((c) => ({ id: c.id, primary: person(c), secondary: c.account?.name ?? '—', path: `/contacts?search=${encodeURIComponent(c.firstName)}`, type: 'contact' as const, keys: [person(c)] }))],

      ['Quotes', 'quotes', async () => (await prisma.quote.findMany({
        where: { AND: [await documentScope(user, 'quotes', 'read')], OR: [{ number: like(q) }, { account: { name: like(q) } }] },
        select: { id: true, number: true, status: true, account: { select: { name: true } } }, take: LIMIT, orderBy: recent,
      })).map((x) => ({ id: x.id, primary: x.number, secondary: `${x.status} · ${x.account.name}`, path: `/quotes/${x.id}`, keys: [x.number] }))],

      ['Invoices', 'invoices', async () => (await prisma.invoice.findMany({
        where: { AND: [await documentScope(user, 'invoices', 'read')], OR: [{ number: like(q) }, { poNumber: like(q) }, { account: { name: like(q) } }] },
        select: { id: true, number: true, poNumber: true, status: true, account: { select: { name: true } } }, take: LIMIT, orderBy: recent,
      })).map((x) => ({ id: x.id, primary: x.poNumber ? `${x.number} · PO ${x.poNumber}` : x.number, secondary: `${x.status} · ${x.account.name}`, path: `/invoices/${x.id}`, keys: [x.number, x.poNumber ?? ''] }))],

      ['Purchase orders', 'invoices', async () => (await prisma.purchaseOrder.findMany({
        where: { deletedAt: null, OR: [{ number: like(q) }, { supplierInvoiceNumber: like(q) }, { account: { name: like(q) } }] },
        select: { id: true, number: true, status: true, account: { select: { name: true } } }, take: LIMIT, orderBy: recent,
      })).map((x) => ({ id: x.id, primary: x.number, secondary: `${x.status} · ${x.account.name}`, path: `/purchase-orders/${x.id}`, keys: [x.number] }))],

      ['Products', 'products', async () => (await prisma.product.findMany({
        where: { isActive: true, OR: [{ name: like(q) }, { sku: like(q) }, { vendor: { name: like(q) } }] },
        select: { id: true, sku: true, name: true, vendor: { select: { name: true } } }, take: LIMIT, orderBy: recent,
      })).map((p) => ({ id: p.id, primary: `${p.sku} · ${p.name}`, secondary: p.vendor?.name ?? '', path: `/products?search=${encodeURIComponent(p.sku)}`, keys: [p.sku, p.name] }))],
    ];

    const groups = await Promise.all(finders
      .filter(([, module]) => can(user, module, 'read'))
      .map(async ([label, , find]) => {
        const rows = (await find()).map((row) => ({ row, rank: rank(row, lower) })).sort((a, b) => a.rank - b.rank);
        return { label, best: rows[0]?.rank ?? 3, rows: rows.map(({ row: { keys: _keys, ...row } }) => row) };
      }));
    // The group holding what was typed exactly comes first; the rest keep their order.
    return { groups: groups.filter((g) => g.rows.length).sort((a, b) => a.best - b.best).map(({ label, rows }) => ({ label, rows })) };
  });
}
