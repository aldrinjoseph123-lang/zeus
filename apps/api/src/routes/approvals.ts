import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../db.js';
import { audit } from '../lib/audit.js';
import { getSetting } from '../lib/settings.js';
import { badRequest, clientIp, forbidden, notFound, requirePermission } from '../lib/http.js';
import { can, ownerAllowed } from '../auth/rbac.js';
import {
  ENTITIES, approvalRequired, delegateFor, notifyDecided, notifyRequested, type Entity,
} from '../services/approvals.js';

/**
 * One set of endpoints for every approvable record, because the workflow is identical
 * whatever is being signed: submit → a manager approves or rejects → the record's
 * committing step unblocks. Per-entity behaviour lives in ENTITIES, not in three
 * near-identical route files.
 */

const isEntity = (value: string): value is Entity => value in ENTITIES;

/** Enough of each record to describe it in a notification and check the threshold. */
const SELECT = {
  deals: {
    id: true, reference: true, name: true, amount: true, cost: true, ownerId: true,
    approvalStatus: true, approvalNote: true, approvalRequestedById: true,
  },
  'purchase-orders': {
    id: true, number: true, total: true, ownerId: true, direction: true,
    approvalStatus: true, approvalNote: true, approvalRequestedById: true, account: { select: { name: true } },
  },
  invoices: {
    id: true, number: true, total: true, type: true,
    approvalStatus: true, approvalNote: true, approvalRequestedById: true, account: { select: { name: true } },
  },
} as const;

interface Described {
  reference: string;
  title: string;
  value: number;
  ownerId: string | null;
  marginPct: number | null;
}

function describe(entity: Entity, record: Record<string, unknown>): Described {
  if (entity === 'deals') {
    const amount = num(record.amount);
    const cost = record.cost === null || record.cost === undefined ? null : num(record.cost);
    return {
      reference: String(record.reference),
      title: String(record.name),
      value: amount,
      ownerId: (record.ownerId as string) ?? null,
      marginPct: cost !== null && amount > 0 ? ((amount - cost) / amount) * 100 : null,
    };
  }
  const account = (record.account as { name?: string } | null)?.name ?? '';
  return {
    reference: String(record.number),
    title: account,
    value: num(record.total),
    ownerId: (record.ownerId as string) ?? null,
    marginPct: null,
  };
}

const linkFor = (entity: Entity, id: string): string =>
  entity === 'deals' ? `/deals/${id}` : entity === 'invoices' ? `/invoices/${id}` : `/purchase-orders/${id}`;

export default async function approvalRoutes(app: FastifyInstance): Promise<void> {
  const load = async (entity: Entity, id: string) => {
    const record = await delegateFor(entity).findUnique({ where: { id }, select: SELECT[entity] });
    if (!record) throw notFound(`${ENTITIES[entity].label} not found.`);
    return record;
  };

  /** Ask a manager to sign it off. */
  app.post('/api/approvals/:entity/:id/submit', async (request) => {
    const { entity, id } = request.params as { entity: string; id: string };
    if (!isEntity(entity)) throw badRequest(`Nothing to approve on "${entity}".`);
    const { module, label, auditEntity } = ENTITIES[entity];
    if (!can(request.user, module, 'update')) throw forbidden(`Your role (${request.user.roleName}) cannot submit a ${label.toLowerCase()} for approval.`);

    const record = await load(entity, id);
    const described = describe(entity, record);
    if (entity === 'deals' && !(await ownerAllowed(request.user, 'deals', 'update', described.ownerId))) throw forbidden();
    if (record.approvalStatus === 'PENDING') throw badRequest(`${described.reference} is already waiting on approval.`);
    if (record.approvalStatus === 'APPROVED') throw badRequest(`${described.reference} has already been approved.`);

    const requirement = await approvalRequired(entity, { total: described.value, marginPct: described.marginPct });
    if (!requirement.required) throw badRequest(`${described.reference} does not need approval — it is under the threshold set in Settings.`);

    const note = z.object({ note: z.string().max(500).optional() }).safeParse(request.body ?? {});

    await delegateFor(entity).update({
      where: { id },
      data: {
        approvalStatus: 'PENDING',
        approvalRequestedAt: new Date(),
        approvalRequestedById: request.user.id,
        approvalDecidedAt: null,
        approvalDecidedById: null,
        approvalNote: note.success ? note.data.note ?? null : null,
      },
    });

    await notifyRequested(entity, {
      reference: described.reference,
      title: described.title,
      value: described.value,
      link: linkFor(entity, id),
      requestedBy: request.user.name,
      note: note.success ? note.data.note : undefined,
    });
    await audit({ user: request.user, action: 'update', entity: auditEntity, entityId: id, summary: `${described.reference} submitted for approval`, ip: clientIp(request) });
    return { ok: true, approvalStatus: 'PENDING', reason: requirement.reason ?? null };
  });

  /** Approve or reject. Requires `approve` on the module, which a rep does not have. */
  for (const [action, approved] of [['approve', true], ['reject', false]] as const) {
    app.post(`/api/approvals/:entity/:id/${action}`, async (request) => {
      const { entity, id } = request.params as { entity: string; id: string };
      if (!isEntity(entity)) throw badRequest(`Nothing to approve on "${entity}".`);
      const { module, label, auditEntity } = ENTITIES[entity];
      if (!can(request.user, module, 'approve')) {
        throw forbidden(`Your role (${request.user.roleName}) cannot approve a ${label.toLowerCase()}. Ask a sales manager.`);
      }

      const parsed = z.object({ note: z.string().max(500).optional() }).safeParse(request.body ?? {});
      const note = parsed.success ? parsed.data.note ?? null : null;
      if (!approved && !note) throw badRequest('Say why it is being rejected so the rep knows what to fix.');

      const record = await load(entity, id);
      const described = describe(entity, record);
      if (record.approvalStatus !== 'PENDING') throw badRequest(`${described.reference} is not waiting for a decision.`);
      const ownWork = record.approvalRequestedById === request.user.id && described.ownerId === request.user.id;
      if (ownWork && !(await getSetting<boolean>('approvals.allowSelfApproval', false))) {
        throw badRequest('You cannot approve your own submission. Ask another manager, or allow self-approval in Settings if you are a one-manager team.');
      }

      await delegateFor(entity).update({
        where: { id },
        data: {
          approvalStatus: approved ? 'APPROVED' : 'REJECTED',
          approvalDecidedAt: new Date(),
          approvalDecidedById: request.user.id,
          approvalNote: note,
        },
      });

      await notifyDecided(entity, {
        approved,
        reference: described.reference,
        link: linkFor(entity, id),
        ownerId: described.ownerId,
        decidedBy: request.user.name,
        note,
      });
      await audit({
        user: request.user, action: 'update', entity: auditEntity, entityId: id,
        summary: `${described.reference} ${approved ? 'approved' : `rejected — ${note}`}`, ip: clientIp(request),
      });
      return { ok: true, approvalStatus: approved ? 'APPROVED' : 'REJECTED' };
    });
  }

  /** Everything sitting on this user's desk, across all three record types. */
  app.get('/api/approvals/pending', { preHandler: requirePermission('dashboard', 'read') }, async (request) => {
    const mayDeals = can(request.user, 'deals', 'approve');
    const mayMoney = can(request.user, 'invoices', 'approve');

    const [deals, purchaseOrders, invoices] = await Promise.all([
      mayDeals
        ? prisma.deal.findMany({
            where: { approvalStatus: 'PENDING', deletedAt: null },
            select: { id: true, reference: true, name: true, amount: true, cost: true, approvalRequestedAt: true, account: { select: { name: true } }, approvalRequestedBy: { select: { name: true } } },
            orderBy: { approvalRequestedAt: 'asc' },
            take: 25,
          })
        : [],
      mayMoney
        ? prisma.purchaseOrder.findMany({
            where: { approvalStatus: 'PENDING', deletedAt: null },
            select: { id: true, number: true, total: true, approvalRequestedAt: true, account: { select: { name: true } }, approvalRequestedBy: { select: { name: true } } },
            orderBy: { approvalRequestedAt: 'asc' },
            take: 25,
          })
        : [],
      mayMoney
        ? prisma.invoice.findMany({
            where: { approvalStatus: 'PENDING' },
            select: { id: true, number: true, total: true, approvalRequestedAt: true, account: { select: { name: true } }, approvalRequestedBy: { select: { name: true } } },
            orderBy: { approvalRequestedAt: 'asc' },
            take: 25,
          })
        : [],
    ]);

    /**
     * The margin the approver is signing off, called out when it is below the floor or
     * gone negative. A manager working the queue on a phone should not have to open the
     * record to find out they are approving a loss.
     */
    const floor = Number(await getSetting<number>('approvals.dealMinMarginPct', 0));

    return [
      ...deals.map((d) => {
        const net = num(d.amount);
        const marginPct = net > 0 ? ((net - num(d.cost)) / net) * 100 : 0;
        return {
          entity: 'deals' as const, id: d.id, reference: d.reference, title: d.name,
          account: d.account.name, value: net, requestedAt: d.approvalRequestedAt, requestedBy: d.approvalRequestedBy?.name ?? null,
          marginPct,
          marginBelowFloor: marginPct < 0 || (floor > 0 && marginPct < floor),
        };
      }),
      ...purchaseOrders.map((p) => ({
        entity: 'purchase-orders' as const, id: p.id, reference: p.number, title: 'Purchase order',
        account: p.account.name, value: num(p.total), requestedAt: p.approvalRequestedAt, requestedBy: p.approvalRequestedBy?.name ?? null,
      })),
      ...invoices.map((i) => ({
        entity: 'invoices' as const, id: i.id, reference: i.number, title: 'Invoice',
        account: i.account.name, value: num(i.total), requestedAt: i.approvalRequestedAt, requestedBy: i.approvalRequestedBy?.name ?? null,
      })),
    ].sort((a, b) => (a.requestedAt?.getTime() ?? 0) - (b.requestedAt?.getTime() ?? 0));
  });
}
