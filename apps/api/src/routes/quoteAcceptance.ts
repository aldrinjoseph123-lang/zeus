import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, HttpError, notFound, requireDocument, requirePermission } from '../lib/http.js';
import { lineTotals } from '../lib/money.js';
import { getSetting } from '../lib/settings.js';
import { quotePdf, type QuotePdfData } from '../services/pdf.js';
import { acceptLinkFor } from '../services/quoteAcceptance.js';
import { announceAcceptance, ensureQuoteApproved, quoteInclude } from './quotes.js';

/**
 * A customer accepts a quotation themselves.
 *
 * Acceptance used to be a member of staff recording a phone call, which loses the two
 * things that matter in a dispute: exactly when they agreed, and who. The quotation email
 * now carries a link; it opens the quote — the sell side only, never cost or margin — and
 * offers an Accept button that records the name, the address, the moment and the origin.
 * The link is the capability, so it is unguessable and dies with the quote's validity;
 * nothing under /api/public/ is reachable by anything but that token.
 */
const publicSelect = {
  id: true, number: true, status: true, issueDate: true, validUntil: true, currency: true,
  subtotal: true, discountPct: true, discountAmt: true, vatRate: true, vatAmount: true, total: true, terms: true, notes: true,
  acceptedAt: true, acceptedByName: true, acceptTokenExpiresAt: true,
  account: { select: { name: true } },
  contact: { select: { firstName: true, lastName: true } },
  preparedBy: { select: { name: true, email: true, phone: true } },
  lines: { orderBy: { order: 'asc' as const }, select: { description: true, quantity: true, unit: true, unitPrice: true, discountPct: true, taxable: true } },
} as const;

async function byToken(token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw notFound('This link is not valid.');
  const quote = await prisma.quote.findUnique({ where: { acceptToken: token }, select: publicSelect });
  if (!quote) throw notFound('This link is not valid.');
  return quote;
}

const expired = (q: { acceptTokenExpiresAt: Date | null }) => !q.acceptTokenExpiresAt || q.acceptTokenExpiresAt.getTime() < Date.now();

export default async function quoteAcceptanceRoutes(app: FastifyInstance): Promise<void> {
  /** The link, for staff to paste into a chat. The same one the email carries. */
  app.post('/api/quotes/:id/accept-link', { preHandler: requirePermission('quotes', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    await requireDocument(request.user, 'quotes', id, 'update');
    const quote = await prisma.quote.findUnique({ where: { id }, select: { id: true, number: true, status: true, validUntil: true, acceptToken: true, acceptTokenExpiresAt: true } });
    if (!quote) throw notFound('Quote not found.');
    if (quote.status === 'ACCEPTED' || quote.status === 'REJECTED') throw badRequest(`${quote.number} is already ${quote.status.toLowerCase()}.`);
    await ensureQuoteApproved(id);
    const link = await acceptLinkFor(quote);
    await audit({ user: request.user, action: 'share', entity: 'Quote', entityId: id, summary: `${quote.number} acceptance link issued`, ip: clientIp(request) });
    return link;
  });

  /** What the customer sees: the quote's sell side, and where it stands. */
  app.get('/api/public/quotes/:token', async (request) => {
    const quote = await byToken((request.params as { token: string }).token);
    return {
      company: await getSetting<string>('company.name', 'Protect24x7'),
      number: quote.number, status: quote.status, issueDate: quote.issueDate, validUntil: quote.validUntil, currency: quote.currency,
      customer: quote.account.name,
      attention: quote.contact ? `${quote.contact.firstName} ${quote.contact.lastName}`.trim() : null,
      preparedBy: quote.preparedBy,
      lines: quote.lines.map((l) => ({
        description: l.description, quantity: num(l.quantity), unit: l.unit, unitPrice: num(l.unitPrice), discountPct: num(l.discountPct), taxable: l.taxable,
        lineTotal: lineTotals({ quantity: num(l.quantity), unitPrice: num(l.unitPrice), discountPct: num(l.discountPct) }).lineTotal,
      })),
      subtotal: num(quote.subtotal), discountPct: num(quote.discountPct), discountAmt: num(quote.discountAmt),
      vatRate: num(quote.vatRate), vatAmount: num(quote.vatAmount), total: num(quote.total),
      terms: quote.terms, notes: quote.notes,
      acceptedAt: quote.acceptedAt, acceptedByName: quote.acceptedByName,
      linkExpired: expired(quote),
    };
  });

  app.get('/api/public/quotes/:token/pdf', async (request, reply) => {
    const { id, number } = await byToken((request.params as { token: string }).token);
    const quote = await prisma.quote.findUnique({ where: { id }, include: quoteInclude });
    const pdf = await quotePdf(quote as unknown as QuotePdfData);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="${number}.pdf"`).send(pdf);
  });

  /** The click. Refused once the quote is no longer open to it, and once the link has died. */
  app.post('/api/public/quotes/:token/accept', async (request) => {
    const quote = await byToken((request.params as { token: string }).token);
    const parsed = z.object({ name: z.string().trim().min(2, 'Please give your name.').max(120), email: z.string().trim().email('Please give a valid email address.') }).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    if (expired(quote)) throw new HttpError(410, 'This link has expired. Ask us for a fresh quotation.');
    if (quote.status === 'ACCEPTED') throw new HttpError(409, `This quotation was already accepted${quote.acceptedByName ? ` by ${quote.acceptedByName}` : ''}.`);
    if (quote.status !== 'SENT' && quote.status !== 'DRAFT') throw new HttpError(409, `This quotation is ${quote.status.toLowerCase()} and can no longer be accepted.`);

    const ip = clientIp(request);
    const accepted = await prisma.quote.update({
      where: { id: quote.id },
      data: { status: 'ACCEPTED', acceptedAt: new Date(), acceptedByName: parsed.data.name, acceptedByEmail: parsed.data.email, acceptedFromIp: ip },
      include: { account: true, deal: true },
    });
    await announceAcceptance(accepted);
    await prisma.activity.create({
      data: {
        type: 'NOTE', subject: `Quotation ${accepted.number} accepted online`,
        description: `By ${parsed.data.name} (${parsed.data.email}).`, status: 'Completed', completedAt: new Date(),
        accountId: accepted.accountId, dealId: accepted.dealId, contactId: accepted.contactId,
        ownerId: accepted.deal?.ownerId ?? accepted.preparedById, createdById: accepted.preparedById,
      },
    });
    await audit({ user: null, action: 'update', entity: 'Quote', entityId: accepted.id, summary: `${accepted.number} accepted online by ${parsed.data.name} (${parsed.data.email})`, ip });
    return { ok: true, acceptedAt: accepted.acceptedAt };
  });
}
