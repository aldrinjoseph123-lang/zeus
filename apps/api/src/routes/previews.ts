import type { FastifyInstance } from 'fastify';
import { prisma, num } from '../db.js';
import { can, maskFields, ownerAllowed, scopeWhere } from '../auth/rbac.js';
import { forbidden, HttpError, notFound } from '../lib/http.js';

/**
 * The card shown when someone hovers a record's name.
 *
 * A handful of fields, not the record: enough to answer "which one is this?" without
 * opening it. It is read under the same rules as opening the record itself, so a preview
 * never shows what the reader could not see on the record's own page. That means the
 * module's read permission, its owner scope, and the same field masking.
 */
const MODULES = { account: 'accounts', deal: 'deals', contact: 'contacts', lead: 'leads' } as const;
type PreviewType = keyof typeof MODULES;

const owner = { select: { name: true } } as const;

export default async function previewRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/previews/:type/:id', async (request) => {
    const { type, id } = request.params as { type: string; id: string };
    if (!request.user) throw new HttpError(401, 'Sign in required.');
    const module = MODULES[type as PreviewType];
    if (!module) throw notFound();
    if (!can(request.user, module, 'read')) throw forbidden();

    const record = await load(type as PreviewType, id, request.user);
    if (!record) throw notFound();
    if (!(await ownerAllowed(request.user, module, 'read', record.ownerId))) throw forbidden();
    return maskFields(request.user, module, record);
  });
}

async function load(type: PreviewType, id: string, user: Parameters<typeof scopeWhere>[0]) {
  if (type === 'account') {
    const account = await prisma.account.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, name: true, type: true, industry: true, city: true, emirate: true, phone: true, email: true, domain: true,
        ownerId: true, owner, lastActivityAt: true,
        _count: { select: { contacts: { where: { deletedAt: null } } } },
      },
    });
    if (!account) return null;
    // Open pipeline counts only the deals the reader could open, as the account page does.
    const open = await prisma.deal.aggregate({
      where: { accountId: id, deletedAt: null, status: 'OPEN', ...(await scopeWhere(user, 'deals', 'read')) },
      _count: true,
      _sum: { amount: true },
    });
    return { ...account, openDeals: open._count, openValue: num(open._sum.amount) };
  }
  if (type === 'deal') {
    const deal = await prisma.deal.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, reference: true, name: true, status: true, amount: true, probability: true, closeDate: true, stageChangedAt: true,
        ownerId: true, owner,
        account: { select: { id: true, name: true } },
        partnerAccount: { select: { id: true, name: true } },
        stage: { select: { name: true, color: true } },
      },
    });
    return deal ? { ...deal, amount: num(deal.amount) } : null;
  }
  if (type === 'contact') {
    return prisma.contact.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, firstName: true, lastName: true, jobTitle: true, email: true, phone: true, mobile: true, isPrimary: true,
        ownerId: true, owner,
        account: { select: { id: true, name: true } },
      },
    });
  }
  const lead = await prisma.lead.findFirst({
    where: { id, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true, company: true, jobTitle: true, email: true, phone: true,
      status: true, rating: true, score: true, source: true, estimatedValue: true, lastActivityAt: true,
      ownerId: true, owner,
    },
  });
  return lead ? { ...lead, estimatedValue: lead.estimatedValue === null ? null : num(lead.estimatedValue) } : null;
}
