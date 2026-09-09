import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SubscriptionStatus } from '@prisma/client';
import { prisma, num } from '../db.js';
import { audit, undoSoftDelete, undoUpdate, diff } from '../lib/audit.js';
import { badRequest, clientIp, forbidden, listParams, notFound, orderBy, paged, patchOf, requirePermission } from '../lib/http.js';
import { maskFields, ownerAllowed, permissionFor, scopeWhere, type SessionUser } from '../auth/rbac.js';
import { round2 } from '../lib/money.js';
import { getSetting } from '../lib/settings.js';
import { createFromInvoice, createSubscription, openRenewalDeal, sweepRenewals, termEnd, wonDealsWithoutRenewal } from '../services/renewals.js';
import { entitlementsForSubscription } from '../services/deliverables.js';

/**
 * Renewals sit under the `deals` permission rather than a module of their own: an
 * entitlement is a future opportunity, and anyone who can work deals should see what
 * is coming up. That also means every role already in the database keeps working
 * without an admin editing permissions first.
 */

const include = {
  account: { select: { id: true, name: true, type: true } },
  product: { select: { id: true, sku: true, name: true } },
  vendor: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  renewalDeal: { select: { id: true, reference: true, name: true, status: true, stage: { select: { name: true } } } },
  sourceInvoice: { select: { id: true, number: true } },
  renewedFrom: { select: { id: true, reference: true } },
};

const subscriptionSchema = z.object({
  accountId: z.string().min(1, 'Pick the customer.'),
  description: z.string().min(1, 'Describe what they are entitled to.'),
  productId: z.string().optional().nullable(),
  vendorId: z.string().optional().nullable(),
  quantity: z.number().positive().default(1),
  unit: z.string().optional(),
  unitPrice: z.number().nonnegative().default(0),
  unitCost: z.number().nonnegative().optional(),
  startDate: z.string(),
  termMonths: z.number().int().positive().default(12),
  endDate: z.string().optional().nullable(),
  autoRenew: z.boolean().optional(),
  vendorRef: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
});

/**
 * Subscriptions are gated on the deals permission, so they inherit its field rules —
 * but the buy price is spelled differently here. The role hides the key `cost`, and
 * maskFields strips exactly that; these rows carry `unitCost` and `termCost`, and the
 * aggregates are added after the mask has already run. So a Sales Executive, whose
 * deals permission hides cost, was reading the whole subscription book's buy price.
 *
 * Same rule, third spelling: the price book report and the coaching escalation each
 * leaked it once before, which is why this is a list rather than a single name.
 */
const COST_FIELDS = new Set(['cost', 'unitCost', 'termCost', 'totalCost', 'margin', 'marginAmount', 'marginPct']);

function withoutCost<T>(user: SessionUser, value: T): T {
  if (permissionFor(user, 'deals').fields?.cost !== 'hidden') return value;
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object' || Object.getPrototypeOf(v) !== Object.prototype) return v;
    return Object.fromEntries(
      Object.entries(v).filter(([k]) => !COST_FIELDS.has(k)).map(([k, child]) => [k, strip(child)]),
    );
  };
  return strip(value) as T;
}

export default async function renewalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/subscriptions', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>, 'endDate');
    const scope = await scopeWhere(request.user, 'deals', 'read');
    const f = params.filters;

    const where: Record<string, unknown> = { deletedAt: null, ...scope };
    if (f.status) where.status = f.status;
    if (f.accountId) where.accountId = f.accountId;
    if (f.vendorId) where.vendorId = f.vendorId;
    if (f.ownerId) where.ownerId = f.ownerId;
    if (f.autoRenew === 'true') where.autoRenew = true;
    if (f.autoRenew === 'false') where.autoRenew = false;
    // "expiring within N days" is the question this screen exists to answer.
    if (f.withinDays) {
      where.endDate = { lte: new Date(Date.now() + Number(f.withinDays) * 86_400_000) };
      where.status = where.status ?? { in: ['ACTIVE', 'EXPIRING'] };
    }
    if (f.from || f.to) {
      where.endDate = {
        ...(typeof where.endDate === 'object' ? where.endDate : {}),
        ...(f.from ? { gte: new Date(f.from) } : {}),
        ...(f.to ? { lte: new Date(f.to) } : {}),
      };
    }
    /** Live cover that nobody has opened a renewal for — the actual risk list. */
    if (f.unworked === 'true') {
      where.status = { in: ['ACTIVE', 'EXPIRING'] };
      where.renewalDealId = null;
    }
    if (params.search) {
      where.OR = [
        { reference: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
        { vendorRef: { contains: params.search, mode: 'insensitive' } },
        { account: { name: { contains: params.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total, sums] = await Promise.all([
      prisma.subscription.findMany({
        where,
        include,
        orderBy: orderBy(params, ['endDate', 'startDate', 'termValue', 'createdAt'], 'endDate'),
        skip: params.skip,
        take: params.take,
      }),
      prisma.subscription.count({ where }),
      prisma.subscription.aggregate({ where, _sum: { termValue: true, termCost: true } }),
    ]);

    return withoutCost(request.user, {
      ...paged(maskFields(request.user, 'deals', data), total, params),
      totals: { value: round2(num(sums._sum.termValue)), cost: round2(num(sums._sum.termCost)) },
    });
  });

  /** The renewals dashboard: what is at risk, when, and worth how much. */
  app.get('/api/subscriptions/summary', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const scope = await scopeWhere(request.user, 'deals', 'read');
    const live = { deletedAt: null, status: { in: ['ACTIVE', 'EXPIRING'] as SubscriptionStatus[] }, ...scope };

    const window = async (days: number) =>
      prisma.subscription.aggregate({
        where: { ...live, endDate: { gte: new Date(), lte: new Date(Date.now() + days * 86_400_000) } },
        _sum: { termValue: true },
        _count: true,
      });

    const [next30, next60, next90, unworked, lapsed, all, renewalGaps] = await Promise.all([
      window(30),
      window(60),
      window(90),
      prisma.subscription.aggregate({
        where: { ...live, renewalDealId: null, endDate: { lte: new Date(Date.now() + 90 * 86_400_000) } },
        _sum: { termValue: true },
        _count: true,
      }),
      prisma.subscription.aggregate({
        where: { deletedAt: null, status: 'LAPSED', endDate: { gte: new Date(Date.now() - 365 * 86_400_000) }, ...scope },
        _sum: { termValue: true },
        _count: true,
      }),
      prisma.subscription.aggregate({ where: live, _sum: { termValue: true, termCost: true }, _count: true }),
      wonDealsWithoutRenewal(scope),
    ]);

    // Twelve months of expiries, so the shape of next year is visible at a glance.
    const upcoming = await prisma.subscription.findMany({
      where: { ...live, endDate: { gte: new Date(), lte: new Date(Date.now() + 365 * 86_400_000) } },
      select: { endDate: true, termValue: true, renewalDealId: true },
    });

    const byMonth = new Map<string, { month: string; value: number; count: number; worked: number }>();
    for (const sub of upcoming) {
      const key = `${sub.endDate.getFullYear()}-${String(sub.endDate.getMonth() + 1).padStart(2, '0')}`;
      const row = byMonth.get(key) ?? { month: key, value: 0, count: 0, worked: 0 };
      row.value = round2(row.value + num(sub.termValue));
      row.count += 1;
      if (sub.renewalDealId) row.worked += 1;
      byMonth.set(key, row);
    }

    return withoutCost(request.user, {
      underCover: { count: all._count, value: round2(num(all._sum.termValue)), cost: round2(num(all._sum.termCost)) },
      next30: { count: next30._count, value: round2(num(next30._sum.termValue)) },
      next60: { count: next60._count, value: round2(num(next60._sum.termValue)) },
      next90: { count: next90._count, value: round2(num(next90._sum.termValue)) },
      unworked: { count: unworked._count, value: round2(num(unworked._sum.termValue)) },
      lapsed12m: { count: lapsed._count, value: round2(num(lapsed._sum.termValue)) },
      byMonth: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
      leadDays: Number(await getSetting<number>('renewals.leadDays', 90)),
      renewalGaps: {
        count: renewalGaps.length,
        value: round2(renewalGaps.reduce((sum, d) => sum + num(d.amount), 0)),
        rows: renewalGaps.map((d) => ({
          id: d.id, reference: d.reference, name: d.name, amount: num(d.amount),
          closedAt: d.closedAt, account: d.account.name, owner: d.owner?.name ?? null,
        })),
      },
    });
  });

  app.get('/api/subscriptions/:id', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const sub = await prisma.subscription.findFirst({ where: { id, deletedAt: null }, include });
    if (!sub) throw notFound('Subscription not found.');
    return maskFields(request.user, 'deals', sub);
  });

  app.post('/api/subscriptions', { preHandler: requirePermission('deals', 'create') }, async (request, reply) => {
    const parsed = subscriptionSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const body = parsed.data;

    const start = new Date(body.startDate);
    const sub = await createSubscription({
      ...body,
      startDate: start,
      endDate: body.endDate ? new Date(body.endDate) : termEnd(start, body.termMonths),
      ownerId: body.ownerId ?? request.user.id,
    });

    await audit({
      user: request.user, action: 'create', entity: 'Subscription', entityId: sub.id,
      summary: `${sub.reference} — ${sub.description}`, ip: clientIp(request),
    });
    return reply.status(201).send(sub);
  });

  app.patch('/api/subscriptions/:id', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = patchOf(subscriptionSchema).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const existing = await prisma.subscription.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Subscription not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', existing.ownerId))) throw forbidden();

    const body = parsed.data;
    const quantity = body.quantity ?? num(existing.quantity);
    const unitPrice = body.unitPrice ?? num(existing.unitPrice);
    const unitCost = body.unitCost ?? num(existing.unitCost);
    const startDate = body.startDate ? new Date(body.startDate) : existing.startDate;
    const termMonths = body.termMonths ?? existing.termMonths;

    const sub = await prisma.subscription.update({
      where: { id },
      data: {
        ...body,
        startDate,
        termMonths,
        // The end date follows the term unless it was set by hand.
        endDate: body.endDate ? new Date(body.endDate) : body.startDate || body.termMonths ? termEnd(startDate, termMonths) : undefined,
        quantity,
        unitPrice,
        unitCost,
        termValue: round2(quantity * unitPrice),
        termCost: round2(quantity * unitCost),
        // A changed date means the old reminders no longer describe this term.
        lastRemindedDays: body.endDate || body.startDate || body.termMonths ? null : undefined,
      } as never,
      include,
    });

    const changes = diff(existing as unknown as Record<string, unknown>, sub as unknown as Record<string, unknown>);
    await audit({
      user: request.user, action: 'update', entity: 'Subscription', entityId: id, summary: sub.reference,
      changes,
      undo: undoUpdate('subscription', 'deals', id, existing as unknown as Record<string, unknown>, changes),
      ip: clientIp(request),
    });
    return sub;
  });

  /** Open the renewal opportunity now rather than waiting for the nightly pass. */
  app.post('/api/subscriptions/:id/renew', { preHandler: requirePermission('deals', 'create') }, async (request) => {
    const { id } = request.params as { id: string };
    const sub = await prisma.subscription.findFirst({ where: { id, deletedAt: null } });
    if (!sub) throw notFound('Subscription not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', sub.ownerId))) throw forbidden();

    try {
      const deal = await openRenewalDeal(id, request.user.id);
      await audit({
        user: request.user, action: 'create', entity: 'Deal', entityId: deal.id,
        summary: `${deal.reference} opened to renew ${sub.reference}`, ip: clientIp(request),
      });
      return deal;
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  /** Stop chasing this one, with the reason on the record. */
  app.post('/api/subscriptions/:id/cancel', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ reason: z.string().min(1, 'Say why it is not renewing.') }).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const existing = await prisma.subscription.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Subscription not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', existing.ownerId))) throw forbidden();

    const sub = await prisma.subscription.update({
      where: { id },
      data: { status: 'CANCELLED', autoRenew: false, cancelReason: parsed.data.reason },
    });
    await audit({
      user: request.user, action: 'update', entity: 'Subscription', entityId: id,
      summary: `${sub.reference} cancelled — ${parsed.data.reason}`,
      undo: undoUpdate('subscription', 'deals', id, existing as unknown as Record<string, unknown>, {
        status: { from: existing.status, to: 'CANCELLED' },
        autoRenew: { from: existing.autoRenew, to: false },
        cancelReason: { from: existing.cancelReason, to: parsed.data.reason },
      }),
      ip: clientIp(request),
    });
    return sub;
  });

  app.delete('/api/subscriptions/:id', { preHandler: requirePermission('deals', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.subscription.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Subscription not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'delete', existing.ownerId))) throw forbidden();

    await prisma.subscription.update({ where: { id }, data: { deletedAt: new Date() } });
    const undoId = await audit({
      user: request.user, action: 'delete', entity: 'Subscription', entityId: id, summary: existing.reference,
      undo: undoSoftDelete('subscription', 'deals', id), ip: clientIp(request),
    });
    return { ok: true, undoId };
  });

  /** Backfill entitlements from an invoice that was issued before this existed. */
  app.post('/api/invoices/:id/entitlements', { preHandler: requirePermission('invoices', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const created = await createFromInvoice(id, request.user.id);
    if (!created) {
      throw badRequest('Nothing to create — the invoice has no lines with a term, or its entitlements already exist.');
    }
    await audit({
      user: request.user, action: 'create', entity: 'Subscription', entityId: id,
      summary: `${created} entitlement(s) created from invoice`, ip: clientIp(request),
    });
    return { ok: true, created };
  });

  // ── deliverables: what a subscription includes, used a piece at a time ───────

  app.get('/api/subscriptions/:id/entitlements', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    return entitlementsForSubscription(id);
  });

  app.post('/api/subscriptions/:id/entitlements', { preHandler: requirePermission('deals', 'update') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const sub = await prisma.subscription.findFirst({ where: { id, deletedAt: null } });
    if (!sub) throw notFound('Subscription not found.');
    const body = z.object({
      label: z.string().min(1), quantity: z.number().positive().default(1), unit: z.string().default('unit'),
      validFrom: z.string().optional(), validTo: z.string().optional(), notes: z.string().max(1000).optional().nullable(),
    }).parse(request.body);
    const ent = await prisma.entitlement.create({ data: {
      subscriptionId: id, label: body.label, quantity: body.quantity, unit: body.unit,
      validFrom: body.validFrom ? new Date(body.validFrom) : sub.startDate,
      validTo: body.validTo ? new Date(body.validTo) : sub.endDate,
      notes: body.notes ?? null,
    } });
    await audit({ user: request.user, action: 'create', entity: 'Entitlement', entityId: ent.id, summary: `${body.quantity} ${body.unit} — ${body.label} on ${sub.reference}`, ip: clientIp(request) });
    return reply.status(201).send(ent);
  });

  app.delete('/api/entitlements/:id', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const ent = await prisma.entitlement.findUnique({ where: { id } });
    if (!ent) throw notFound('Entitlement not found.');
    await prisma.entitlement.delete({ where: { id } });
    await audit({ user: request.user, action: 'delete', entity: 'Entitlement', entityId: id, summary: ent.label, ip: clientIp(request) });
    return { ok: true };
  });

  app.post('/api/entitlements/:id/deliveries', { preHandler: requirePermission('deals', 'update') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ent = await prisma.entitlement.findUnique({ where: { id } });
    if (!ent) throw notFound('Entitlement not found.');
    const body = z.object({
      quantity: z.number().positive().default(1),
      status: z.enum(['SCHEDULED', 'DELIVERED']).default('SCHEDULED'),
      scheduledFor: z.string().optional().nullable(), deliveredAt: z.string().optional().nullable(),
      reference: z.string().max(200).optional().nullable(), notes: z.string().max(1000).optional().nullable(),
    }).parse(request.body);
    const delivery = await prisma.delivery.create({ data: {
      entitlementId: id, quantity: body.quantity, status: body.status,
      scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
      deliveredAt: body.status === 'DELIVERED' ? (body.deliveredAt ? new Date(body.deliveredAt) : new Date()) : (body.deliveredAt ? new Date(body.deliveredAt) : null),
      reference: body.reference ?? null, notes: body.notes ?? null,
    } });
    await audit({ user: request.user, action: 'create', entity: 'Delivery', entityId: delivery.id, summary: `${body.status.toLowerCase()} ${body.quantity} ${ent.unit} of ${ent.label}`, ip: clientIp(request) });
    return reply.status(201).send(delivery);
  });

  app.patch('/api/deliveries/:id', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.delivery.findUnique({ where: { id } });
    if (!existing) throw notFound('Delivery not found.');
    const body = z.object({
      quantity: z.number().positive().optional(),
      status: z.enum(['SCHEDULED', 'DELIVERED']).optional(),
      scheduledFor: z.string().optional().nullable(), deliveredAt: z.string().optional().nullable(),
      reference: z.string().max(200).optional().nullable(), notes: z.string().max(1000).optional().nullable(),
    }).parse(request.body);
    // Marking delivered stamps the date if one was not given; nothing else infers a date.
    const deliveredAt = body.status === 'DELIVERED' && !existing.deliveredAt && body.deliveredAt === undefined ? new Date()
      : body.deliveredAt !== undefined ? (body.deliveredAt ? new Date(body.deliveredAt) : null) : undefined;
    const delivery = await prisma.delivery.update({ where: { id }, data: {
      quantity: body.quantity, status: body.status,
      scheduledFor: body.scheduledFor !== undefined ? (body.scheduledFor ? new Date(body.scheduledFor) : null) : undefined,
      deliveredAt, reference: body.reference ?? undefined, notes: body.notes ?? undefined,
    } });
    await audit({ user: request.user, action: 'update', entity: 'Delivery', entityId: id, summary: `${delivery.status.toLowerCase()}`, ip: clientIp(request) });
    return delivery;
  });

  app.delete('/api/deliveries/:id', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.delivery.findUnique({ where: { id } });
    if (!existing) throw notFound('Delivery not found.');
    await prisma.delivery.delete({ where: { id } });
    await audit({ user: request.user, action: 'delete', entity: 'Delivery', entityId: id, summary: 'delivery removed', ip: clientIp(request) });
    return { ok: true };
  });

  /** Run the nightly pass on demand — useful the day the module is switched on. */
  app.post('/api/subscriptions/sweep', { preHandler: requirePermission('settings', 'update') }, async (request) => {
    const result = await sweepRenewals();
    await audit({
      user: request.user, action: 'update', entity: 'Subscription',
      summary: `Renewal sweep: ${result.opened} opened, ${result.reminded} reminded, ${result.lapsed} lapsed, ${result.gaps} gaps flagged`,
      ip: clientIp(request),
    });
    return result;
  });
}
