import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, num } from '../db.js';
import { sanitizeCustomFields } from '../lib/customFields.js';
import { audit, auditRead, diff, undoHardDelete, undoSoftDelete, undoUpdate } from '../lib/audit.js';
import { badRequest, clientIp, conflict, forbidden, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { maskFields, ownerAllowed, scopeWhere, stripUnwritableFields } from '../auth/rbac.js';
import { checkDuplicates } from '../services/dedupe.js';
import { nextReference } from '../lib/counters.js';
import { applyVat, formatAed } from '../lib/money.js';
import { getSetting, vatRate } from '../lib/settings.js';
import { notify } from '../services/notify.js';
import { mailPartnerAboutRegistration } from '../services/registrations.js';
import { approvalRequired, blockedReason } from '../services/approvals.js';
import { markRenewed } from '../services/renewals.js';
import { touch } from '../lib/touch.js';

const dealSchema = z.object({
  name: z.string().min(1, 'Deal name is required.'),
  accountId: z.string().min(1, 'Pick the end customer.'),
  partnerAccountId: z.string().optional().nullable(),
  primaryContactId: z.string().optional().nullable(),
  pipelineId: z.string().optional(),
  stageId: z.string().optional(),
  type: z.enum(['PRODUCT', 'SERVICE', 'MIXED']).optional(),
  amount: z.number().nonnegative().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  cost: z.number().nonnegative().optional(),
  probability: z.number().int().min(0).max(100).optional(),
  closeDate: z.string().optional(),
  source: z.string().optional(),
  sourcePartnerId: z.string().optional().nullable(),
  competitor: z.string().optional().nullable(),
  nextStep: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  customFields: z.record(z.unknown()).optional(),
  ignoreDuplicates: z.boolean().optional(),
});

const dealInclude = {
  account: { select: { id: true, name: true, type: true, domain: true, industry: true } },
  partnerAccount: { select: { id: true, name: true, type: true } },
  primaryContact: { select: { id: true, firstName: true, lastName: true, email: true, phone: true, jobTitle: true } },
  stage: { select: { id: true, name: true, order: true, color: true, probability: true, isWon: true, isLost: true, rotDays: true } },
  pipeline: { select: { id: true, name: true, kind: true } },
  owner: { select: { id: true, name: true, avatarColor: true } },
  approvalRequestedBy: { select: { id: true, name: true } },
  approvalDecidedBy: { select: { id: true, name: true } },
};

/** Recompute VAT/total whenever the net amount or rate moves. */
function withVat(amount: number, rate: number) {
  const { vatAmount, total } = applyVat(amount, rate);
  return { amount, vatRate: rate, vatAmount, totalAmount: total };
}

export default async function dealRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/deals', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>);
    const scope = await scopeWhere(request.user, 'deals', 'read');
    const f = params.filters;

    const where: Record<string, unknown> = { deletedAt: null, ...scope };
    if (f.status) where.status = f.status;
    if (f.stageId) where.stageId = f.stageId;
    if (f.pipelineId) where.pipelineId = f.pipelineId;
    if (f.ownerId) where.ownerId = f.ownerId;
    if (f.accountId) where.accountId = f.accountId;
    if (f.partnerAccountId) where.partnerAccountId = f.partnerAccountId;
    if (f.type) where.type = f.type;
    if (f.source) where.source = f.source;
    if (f.hasPartner === 'true') where.partnerAccountId = { not: null };
    if (f.hasPartner === 'false') where.partnerAccountId = null;
    if (f.closeFrom || f.closeTo) {
      where.closeDate = {
        ...(f.closeFrom ? { gte: new Date(f.closeFrom) } : {}),
        ...(f.closeTo ? { lte: new Date(f.closeTo) } : {}),
      };
    }
    if (f.minAmount || f.maxAmount) {
      where.amount = {
        ...(f.minAmount ? { gte: Number(f.minAmount) } : {}),
        ...(f.maxAmount ? { lte: Number(f.maxAmount) } : {}),
      };
    }
    if (f.overdue === 'true') {
      where.status = 'OPEN';
      where.closeDate = { lt: new Date() };
    }
    if (params.search) {
      where.OR = [
        { name: { contains: params.search, mode: 'insensitive' } },
        { reference: { contains: params.search, mode: 'insensitive' } },
        { account: { name: { contains: params.search, mode: 'insensitive' } } },
        { account: { domain: { contains: params.search.toLowerCase() } } },
      ];
    }

    const [data, total, sums] = await Promise.all([
      prisma.deal.findMany({
        where,
        include: dealInclude,
        orderBy: orderBy(params, ['amount', 'closeDate', 'createdAt', 'updatedAt', 'name', 'probability', 'stageChangedAt']),
        skip: params.skip,
        take: params.take,
      }),
      prisma.deal.count({ where }),
      prisma.deal.aggregate({ where, _sum: { amount: true, totalAmount: true } }),
    ]);

    return {
      ...paged(maskFields(request.user, 'deals', data), total, params),
      totals: { net: num(sums._sum.amount), gross: num(sums._sum.totalAmount) },
    };
  });

  /** Kanban board: stages with their deals, plus per-column totals. */
  app.get('/api/deals/board', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const q = request.query as Record<string, string>;
    const scope = await scopeWhere(request.user, 'deals', 'read');

    const pipeline = q.pipelineId
      ? await prisma.pipeline.findUnique({ where: { id: q.pipelineId }, include: { stages: { orderBy: { order: 'asc' } } } })
      : await prisma.pipeline.findFirst({ where: { isDefault: true, isActive: true }, include: { stages: { orderBy: { order: 'asc' } } } });
    if (!pipeline) throw notFound('No pipeline configured.');

    const where: Record<string, unknown> = { deletedAt: null, pipelineId: pipeline.id, ...scope };
    if (q.ownerId) where.ownerId = q.ownerId;
    if (q.type) where.type = q.type;
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { reference: { contains: q.search, mode: 'insensitive' } },
        { account: { name: { contains: q.search, mode: 'insensitive' } } },
      ];
    }
    // Closed deals leave the board after 30 days so it stays a working surface.
    where.OR = [
      { status: 'OPEN' },
      { closedAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
    ];

    const deals = await prisma.deal.findMany({
      where,
      include: dealInclude,
      orderBy: [{ stageChangedAt: 'asc' }],
      take: 1000,
    });

    const byStage = new Map<string, typeof deals>();
    for (const deal of deals) {
      const list = byStage.get(deal.stageId) ?? [];
      list.push(deal);
      byStage.set(deal.stageId, list);
    }

    const columns = pipeline.stages.map((stage) => {
      const stageDeals = byStage.get(stage.id) ?? [];
      return {
        stage,
        count: stageDeals.length,
        netTotal: stageDeals.reduce((sum, d) => sum + num(d.amount), 0),
        weightedTotal: stageDeals.reduce((sum, d) => sum + (num(d.amount) * d.probability) / 100, 0),
        deals: maskFields(request.user, 'deals', stageDeals),
      };
    });

    return { pipeline: { id: pipeline.id, name: pipeline.name, kind: pipeline.kind }, columns };
  });

  app.get('/api/deals/:id', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const deal = await prisma.deal.findFirst({
      where: { id, deletedAt: null },
      include: {
        ...dealInclude,
        registrations: {
          include: {
            vendor: { select: { id: true, name: true } },
            partner: { select: { id: true, name: true } },
            partnerContact: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        quotes: { orderBy: { createdAt: 'desc' }, include: { lines: true } },
        invoices: { orderBy: { createdAt: 'desc' } },
        activities: { orderBy: { createdAt: 'desc' }, include: { owner: { select: { name: true, avatarColor: true } } } },
        attachments: true,
        stageHistory: { orderBy: { changedAt: 'asc' } },
      },
    });
    if (!deal) throw notFound('Deal not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'read', deal.ownerId))) throw forbidden();
    auditRead(request.user, 'Deal', deal.id, deal.reference, clientIp(request));
    return maskFields(request.user, 'deals', deal);
  });

  app.post('/api/deals', { preHandler: requirePermission('deals', 'create') }, async (request, reply) => {
    const parsed = dealSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = stripUnwritableFields(request.user, 'deals', parsed.data as Record<string, unknown>) as z.infer<typeof dealSchema>;

    const account = await prisma.account.findFirst({ where: { id: body.accountId, deletedAt: null } });
    if (!account) throw badRequest('That end customer no longer exists.');

    const dupes = await checkDuplicates({ module: 'deals', accountId: body.accountId, company: account.name, domain: account.domain });
    if (dupes.hasDuplicates && !body.ignoreDuplicates) {
      throw conflict(`${account.name} already has an open deal — review before saving.`, dupes);
    }

    const pipeline = body.pipelineId
      ? await prisma.pipeline.findUnique({ where: { id: body.pipelineId }, include: { stages: { orderBy: { order: 'asc' } } } })
      : await prisma.pipeline.findFirst({ where: { isDefault: true, isActive: true }, include: { stages: { orderBy: { order: 'asc' } } } });
    if (!pipeline || pipeline.stages.length === 0) throw badRequest('No pipeline with stages is configured.');

    const stage = body.stageId ? pipeline.stages.find((s) => s.id === body.stageId) : pipeline.stages[0];
    if (!stage) throw badRequest('That stage does not belong to the chosen pipeline.');

    const rate = body.vatRate ?? (await vatRate());
    const money = withVat(body.amount ?? 0, rate);

    const deal = await prisma.deal.create({
      data: {
        reference: await nextReference('deal'),
        name: body.name,
        accountId: body.accountId,
        partnerAccountId: body.partnerAccountId ?? null,
        primaryContactId: body.primaryContactId ?? null,
        pipelineId: pipeline.id,
        stageId: stage.id,
        type: body.type ?? 'PRODUCT',
        ...money,
        cost: body.cost ?? 0,
        probability: body.probability ?? stage.probability,
        closeDate: body.closeDate ? new Date(body.closeDate) : new Date(Date.now() + 30 * 86_400_000),
        source: body.source ?? 'Database',
        sourcePartnerId: body.sourcePartnerId ?? null,
        competitor: body.competitor ?? null,
        nextStep: body.nextStep ?? null,
        description: body.description ?? null,
        ownerId: body.ownerId ?? request.user.id,
        customFields: (await sanitizeCustomFields('deals', body.customFields, {}, { enforceRequired: true })) as never,
        lastActivityAt: new Date(),
      },
      include: dealInclude,
    });

    await prisma.stageHistory.create({
      data: { dealId: deal.id, toStageId: stage.id, toStatus: 'OPEN', amount: num(deal.amount), changedById: request.user.id },
    });
    await touch({ accountId: deal.accountId });

    if (deal.ownerId && deal.ownerId !== request.user.id) {
      await notify({
        event: 'deal_assigned',
        title: `Deal assigned to you: ${deal.name}`,
        body: `${account.name} · ${formatAed(num(deal.amount))} net`,
        link: `/deals/${deal.id}`,
        ownerId: deal.ownerId,
      });
    }

    await audit({ user: request.user, action: 'create', entity: 'Deal', entityId: deal.id, summary: `${deal.reference} ${deal.name}`, ip: clientIp(request) });
    return reply.status(201).send(maskFields(request.user, 'deals', deal));
  });

  app.patch('/api/deals/:id', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.deal.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Deal not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', existing.ownerId))) throw forbidden();

    const parsed = dealSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const { ignoreDuplicates: _i, ...body } = stripUnwritableFields(request.user, 'deals', parsed.data as Record<string, unknown>);

    const data: Record<string, unknown> = { ...body, lastActivityAt: new Date() };
    if (body.amount !== undefined || body.vatRate !== undefined) {
      Object.assign(data, withVat(
        (body.amount as number) ?? num(existing.amount),
        (body.vatRate as number) ?? num(existing.vatRate),
      ));
    }
    if (body.closeDate) data.closeDate = new Date(body.closeDate as string);
    if (body.stageId && body.stageId !== existing.stageId) {
      throw badRequest('Use the stage endpoint (POST /api/deals/:id/stage) to move a deal — it records the history.');
    }

    if ('customFields' in body) {
      data.customFields = await sanitizeCustomFields('deals', body.customFields, (existing.customFields ?? {}) as Record<string, unknown>);
    }

    const deal = await prisma.deal.update({ where: { id }, data: data as never, include: dealInclude });
    await touch({ accountId: deal.accountId });

    if (body.ownerId && body.ownerId !== existing.ownerId) {
      await notify({
        event: 'deal_assigned',
        title: `Deal assigned to you: ${deal.name}`,
        body: `${deal.account.name} · ${formatAed(num(deal.amount))} net`,
        link: `/deals/${deal.id}`,
        ownerId: deal.ownerId,
      });
    }

    await audit({
      user: request.user, action: 'update', entity: 'Deal', entityId: id, summary: `${deal.reference} ${deal.name}`,
      changes: diff(existing as unknown as Record<string, unknown>, deal as unknown as Record<string, unknown>),
      undo: undoUpdate('deal', 'deals', id, existing as unknown as Record<string, unknown>,
        diff(existing as unknown as Record<string, unknown>, deal as unknown as Record<string, unknown>)),
      ip: clientIp(request),
    });
    return maskFields(request.user, 'deals', deal);
  });

  /**
   * Move a deal between stages. This is the endpoint the Kanban drag and the
   * sales rep's status dropdown both hit — it is the only place stage changes
   * happen, so velocity history is never missing rows.
   */
  app.post('/api/deals/:id/stage', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      stageId: z.string(),
      lostReason: z.string().optional(),
      competitor: z.string().optional(),
      note: z.string().optional(),
    });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const deal = await prisma.deal.findFirst({ where: { id, deletedAt: null }, include: { account: true, stage: true } });
    if (!deal) throw notFound('Deal not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', deal.ownerId))) throw forbidden();

    const stage = await prisma.stage.findUnique({ where: { id: parsed.data.stageId } });
    if (!stage || stage.pipelineId !== deal.pipelineId) throw badRequest('That stage is not part of this deal\'s pipeline.');
    if (stage.id === deal.stageId) return maskFields(request.user, 'deals', deal);

    if (stage.isLost && !parsed.data.lostReason) throw badRequest('A lost reason is required when marking a deal lost.');

    // Closing a deal won is the committing step: it feeds the forecast, the targets
    // and everything invoiced off the back of it. A manager signs that off.
    if (stage.isWon) {
      const amount = num(deal.amount);
      const marginPct = deal.cost !== null && amount > 0 ? ((amount - num(deal.cost)) / amount) * 100 : null;
      const requirement = await approvalRequired('deals', { amount, marginPct });
      if (requirement.required && deal.approvalStatus !== 'APPROVED') {
        throw badRequest(
          blockedReason(deal, 'deals')
            ?? `${deal.reference} needs a sales manager's approval before it can be closed won.${requirement.reason ? ` ${requirement.reason}` : ''}`,
        );
      }
    }

    const status = stage.isWon ? 'WON' : stage.isLost ? 'LOST' : 'OPEN';
    const daysInStage = Math.max(0, Math.round((Date.now() - deal.stageChangedAt.getTime()) / 86_400_000));

    const updated = await prisma.deal.update({
      where: { id },
      data: {
        stageId: stage.id,
        status,
        probability: stage.isWon ? 100 : stage.isLost ? 0 : stage.probability,
        stageChangedAt: new Date(),
        lastActivityAt: new Date(),
        closedAt: status === 'OPEN' ? null : new Date(),
        lostReason: stage.isLost ? parsed.data.lostReason : null,
        competitor: parsed.data.competitor ?? deal.competitor,
      },
      include: dealInclude,
    });

    await prisma.stageHistory.create({
      data: {
        dealId: id,
        fromStageId: deal.stageId,
        toStageId: stage.id,
        fromStatus: deal.status,
        toStatus: status,
        amount: num(deal.amount),
        changedById: request.user.id,
        daysInStage,
      },
    });

    if (parsed.data.note) {
      await prisma.activity.create({
        data: {
          type: 'NOTE',
          subject: `Moved to ${stage.name}`,
          description: parsed.data.note,
          status: 'Completed',
          completedAt: new Date(),
          dealId: id,
          accountId: deal.accountId,
          ownerId: request.user.id,
          createdById: request.user.id,
        },
      });
    }

    await touch({ accountId: deal.accountId });

    // Winning a renewal closes the old term and starts the next one, so the chain
    // stays unbroken without anyone re-keying dates.
    if (status === 'WON') {
      await markRenewed(id).catch((err) => console.error('[renewals] could not roll the term forward:', (err as Error).message));
    }

    if (status !== 'OPEN') {
      const facts = [
        { title: 'Customer', value: deal.account.name },
        { title: 'Value', value: formatAed(num(deal.amount)) },
        { title: 'Owner', value: updated.owner?.name ?? 'Unassigned' },
        ...(status === 'LOST' && parsed.data.lostReason ? [{ title: 'Reason', value: parsed.data.lostReason }] : []),
      ];
      await notify({
        event: status === 'WON' ? 'deal_won' : 'deal_lost',
        title: status === 'WON' ? `Deal won — ${deal.name}` : `Deal lost — ${deal.name}`,
        body: `${deal.account.name} · ${formatAed(num(deal.amount))} net`,
        link: `/deals/${id}`,
        severity: status === 'WON' ? 'info' : 'warn',
        ownerId: deal.ownerId,
        facts,
      });
    }

    // A mis-drag on the kanban is the most common thing anyone wants back, so the
    // whole stage move — column, status, probability, close date — is one undo.
    const undoId = await audit({
      user: request.user, action: 'update', entity: 'Deal', entityId: id,
      summary: `${deal.reference}: ${deal.stage.name} → ${stage.name}`,
      changes: { stage: { from: deal.stage.name, to: stage.name }, status: { from: deal.status, to: status } },
      undo: {
        kind: 'update', model: 'deal', module: 'deals', id,
        before: {
          stageId: deal.stageId,
          status: deal.status,
          probability: deal.probability,
          stageChangedAt: deal.stageChangedAt,
          closedAt: deal.closedAt,
          lostReason: deal.lostReason,
        },
      },
      ip: clientIp(request),
    });

    return { ...maskFields(request.user, 'deals', updated), undoId };
  });

  app.delete('/api/deals/:id', { preHandler: requirePermission('deals', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.deal.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Deal not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'delete', existing.ownerId))) throw forbidden();
    await prisma.deal.update({ where: { id }, data: { deletedAt: new Date() } });
    const undoId = await audit({ user: request.user, action: 'delete', entity: 'Deal', entityId: id, summary: existing.reference,
      undo: undoSoftDelete('deal', 'deals', id), ip: clientIp(request) });
    return { ok: true, undoId };
  });

  /**
   * Bulk actions from the deals list. Each row is still scope-checked individually —
   * a rep bulk-selecting cannot touch a deal they could not touch one at a time — so a
   * mixed selection quietly skips what is not theirs rather than failing the whole call.
   */
  app.post('/api/deals/bulk-assign', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const parsed = z.object({ ids: z.array(z.string()).min(1, 'Select at least one deal.'), ownerId: z.string().min(1, 'Choose who to assign to.') }).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const { ids, ownerId } = parsed.data;

    let updated = 0, skipped = 0;
    for (const id of ids) {
      const deal = await prisma.deal.findFirst({ where: { id, deletedAt: null } });
      if (!deal || !(await ownerAllowed(request.user, 'deals', 'update', deal.ownerId))) { skipped++; continue; }
      await prisma.deal.update({ where: { id }, data: { ownerId } });
      await audit({ user: request.user, action: 'update', entity: 'Deal', entityId: id, summary: `${deal.reference} reassigned`, ip: clientIp(request) });
      updated++;
    }
    return { updated, skipped };
  });

  app.post('/api/deals/bulk-delete', { preHandler: requirePermission('deals', 'delete') }, async (request) => {
    const parsed = z.object({ ids: z.array(z.string()).min(1, 'Select at least one deal.') }).safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    let deleted = 0, skipped = 0;
    for (const id of parsed.data.ids) {
      const deal = await prisma.deal.findFirst({ where: { id, deletedAt: null } });
      if (!deal || !(await ownerAllowed(request.user, 'deals', 'delete', deal.ownerId))) { skipped++; continue; }
      await prisma.deal.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit({ user: request.user, action: 'delete', entity: 'Deal', entityId: id, summary: deal.reference, undo: undoSoftDelete('deal', 'deals', id), ip: clientIp(request) });
      deleted++;
    }
    return { deleted, skipped };
  });

  // ── deal registrations, both sides of the channel ────────────────────────────

  const registrationSchema = z.object({
    side: z.enum(['VENDOR', 'PARTNER']).default('VENDOR'),
    vendorId: z.string().optional().nullable(),
    partnerId: z.string().optional().nullable(),
    partnerContactId: z.string().optional().nullable(),
    regNumber: z.string().optional().nullable(),
    status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'EXPIRED']).optional(),
    submittedAt: z.string().optional().nullable(),
    approvedAt: z.string().optional().nullable(),
    expiresAt: z.string().optional().nullable(),
    approvedDiscount: z.number().min(0).max(100).optional().nullable(),
    notes: z.string().optional().nullable(),
  });

  const toDate = (v?: string | null) => (v ? new Date(v) : null);

  /** Who the registration is with, whichever side it points. */
  const counterparty = (reg: { vendor?: { name: string } | null; partner?: { name: string } | null }): string =>
    reg.vendor?.name ?? reg.partner?.name ?? 'unknown counterparty';

  const registrationInclude = {
    vendor: { select: { id: true, name: true } },
    partner: { select: { id: true, name: true } },
    partnerContact: { select: { id: true, firstName: true, lastName: true, email: true } },
  } as const;

  app.post('/api/deals/:id/registrations', { preHandler: requirePermission('deals', 'update') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = registrationSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const body = parsed.data;

    if (body.side === 'VENDOR' && !body.vendorId) throw badRequest('Pick the vendor this deal is registered with.');
    if (body.side === 'PARTNER' && !body.partnerId) throw badRequest('Pick the partner holding this registration.');

    const deal = await prisma.deal.findFirst({ where: { id, deletedAt: null } });
    if (!deal) throw notFound('Deal not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', deal.ownerId))) throw forbidden();

    // Both sides run 90 days by default — the clock starts the day it was submitted.
    const validDays = Number(await getSetting<number>('pipeline.registrationValidDays', 90));
    const submitted = toDate(body.submittedAt) ?? new Date();
    const expires = toDate(body.expiresAt) ?? new Date(submitted.getTime() + validDays * 86_400_000);

    const registration = await prisma.dealRegistration.create({
      data: {
        dealId: id,
        side: body.side,
        vendorId: body.side === 'VENDOR' ? body.vendorId! : null,
        partnerId: body.side === 'PARTNER' ? body.partnerId! : null,
        partnerContactId: body.side === 'PARTNER' ? body.partnerContactId ?? null : null,
        regNumber: body.regNumber ?? null,
        status: body.status ?? 'DRAFT',
        submittedAt: submitted,
        approvedAt: toDate(body.approvedAt),
        expiresAt: expires,
        approvedDiscount: body.approvedDiscount ?? null,
        notes: body.notes ?? null,
      },
      include: registrationInclude,
    });

    await audit({
      user: request.user, action: 'create', entity: 'DealRegistration', entityId: registration.id,
      summary: `${deal.reference} ${registration.side === 'PARTNER' ? 'protected for' : 'registered with'} ${counterparty(registration)}`,
      ip: clientIp(request),
    });
    return reply.status(201).send(registration);
  });

  app.patch('/api/registrations/:regId', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { regId } = request.params as { regId: string };
    const parsed = registrationSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const existing = await prisma.dealRegistration.findUnique({ where: { id: regId }, include: { deal: true } });
    if (!existing) throw notFound('Registration not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', existing.deal.ownerId))) throw forbidden();

    const registration = await prisma.dealRegistration.update({
      where: { id: regId },
      data: {
        ...parsed.data,
        submittedAt: parsed.data.submittedAt !== undefined ? toDate(parsed.data.submittedAt) : undefined,
        approvedAt: parsed.data.approvedAt !== undefined ? toDate(parsed.data.approvedAt) : undefined,
        expiresAt: parsed.data.expiresAt !== undefined ? toDate(parsed.data.expiresAt) : undefined,
        // A fresh expiry date means the protection was renewed, so the partner is due
        // a new warning rather than being silenced by the last one.
        partnerNotifiedAt: parsed.data.expiresAt !== undefined ? null : undefined,
      } as never,
      include: registrationInclude,
    });
    await audit({ user: request.user, action: 'update', entity: 'DealRegistration', entityId: regId, summary: `${existing.deal.reference} / ${counterparty(registration)}`, ip: clientIp(request) });
    return registration;
  });

  /**
   * Mail the partner about their registration on demand — the same message the
   * scheduler sends, for when a rep wants to chase now rather than wait for the job.
   */
  app.post('/api/registrations/:regId/notify-partner', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { regId } = request.params as { regId: string };
    const registration = await prisma.dealRegistration.findUnique({
      where: { id: regId },
      include: { ...registrationInclude, deal: { select: { id: true, reference: true, name: true, ownerId: true, account: { select: { name: true } } } } },
    });
    if (!registration) throw notFound('Registration not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', registration.deal.ownerId))) throw forbidden();
    if (registration.side !== 'PARTNER') throw badRequest('Only a partner registration can be mailed to the partner.');

    const sent = await mailPartnerAboutRegistration(registration);
    if (!sent.ok) throw badRequest(sent.reason);

    await audit({ user: request.user, action: 'update', entity: 'DealRegistration', entityId: regId, summary: `Emailed ${sent.to} about ${registration.deal.reference}`, ip: clientIp(request) });
    return { ok: true, to: sent.to };
  });

  app.delete('/api/registrations/:regId', { preHandler: requirePermission('deals', 'update') }, async (request) => {
    const { regId } = request.params as { regId: string };
    const existing = await prisma.dealRegistration.findUnique({ where: { id: regId }, include: { deal: true } });
    if (!existing) throw notFound('Registration not found.');
    if (!(await ownerAllowed(request.user, 'deals', 'update', existing.deal.ownerId))) throw forbidden();
    await prisma.dealRegistration.delete({ where: { id: regId } });
    const undoId = await audit({
      user: request.user, action: 'delete', entity: 'DealRegistration', entityId: regId,
      summary: existing.deal.reference,
      undo: undoHardDelete('dealRegistration', 'deals', regId, existing), ip: clientIp(request),
    });
    return { ok: true, undoId };
  });

  /** Registrations expiring inside the warning window — surfaced on the dashboard. */
  app.get('/api/registrations/expiring', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const days = Number(await getSetting<number>('pipeline.registrationExpiryWarnDays', 30));
    const scope = await scopeWhere(request.user, 'deals', 'read');
    return prisma.dealRegistration.findMany({
      where: {
        status: { in: ['SUBMITTED', 'APPROVED'] },
        expiresAt: { not: null, lte: new Date(Date.now() + days * 86_400_000) },
        deal: { deletedAt: null, status: 'OPEN', ...scope },
      },
      include: {
        ...registrationInclude,
        deal: { select: { id: true, reference: true, name: true, amount: true, account: { select: { name: true } }, owner: { select: { name: true } } } },
      },
      orderBy: { expiresAt: 'asc' },
      take: 50,
    });
  });
}
