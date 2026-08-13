import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { sanitizeCustomFields } from '../lib/customFields.js';
import { audit, auditRead, diff, undoSoftDelete, undoUpdate } from '../lib/audit.js';
import { badRequest, clientIp, conflict, forbidden, listParams, notFound, orderBy, paged, requirePermission } from '../lib/http.js';
import { maskFields, ownerAllowed, scopeWhere, stripUnwritableFields } from '../auth/rbac.js';
import { checkDuplicates, extractDomain } from '../services/dedupe.js';
import { nextReference } from '../lib/counters.js';
import { applyVat } from '../lib/money.js';
import { vatRate } from '../lib/settings.js';
import { notify } from '../services/notify.js';
import { formatAed } from '../lib/money.js';

const leadSchema = z.object({
  firstName: z.string().min(1, 'First name is required.'),
  lastName: z.string().min(1, 'Last name is required.'),
  company: z.string().min(1, 'Company is required.'),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  jobTitle: z.string().optional().nullable(),
  linkedinUrl: z.string().optional().nullable(),
  source: z.string().default('Database'),
  sourcePartnerId: z.string().optional().nullable(),
  status: z.enum(['NEW', 'WORKING', 'NURTURING', 'QUALIFIED', 'DISQUALIFIED', 'CONVERTED']).optional(),
  rating: z.string().optional().nullable(),
  score: z.number().int().min(0).max(100).optional(),
  interestArea: z.string().optional().nullable(),
  estimatedValue: z.number().nonnegative().optional().nullable(),
  description: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  emirate: z.string().optional().nullable(),
  country: z.string().optional(),
  disqualifyReason: z.string().optional().nullable(),
  domain: z.string().optional().nullable(),
  customFields: z.record(z.unknown()).optional(),
  ignoreDuplicates: z.boolean().optional(),
});

export default async function leadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/leads', { preHandler: requirePermission('leads', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>);
    const scope = await scopeWhere(request.user, 'leads', 'read');
    const where: Record<string, unknown> = { deletedAt: null, ...scope };
    if (params.filters.status) where.status = params.filters.status;
    if (params.filters.source) where.source = params.filters.source;
    if (params.filters.ownerId) where.ownerId = params.filters.ownerId;
    if (params.filters.rating) where.rating = params.filters.rating;
    if (params.filters.open === 'true') where.status = { notIn: ['CONVERTED', 'DISQUALIFIED'] };
    if (params.search) {
      where.OR = [
        { firstName: { contains: params.search, mode: 'insensitive' } },
        { lastName: { contains: params.search, mode: 'insensitive' } },
        { company: { contains: params.search, mode: 'insensitive' } },
        { email: { contains: params.search, mode: 'insensitive' } },
        { domain: { contains: params.search.toLowerCase() } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        include: { owner: { select: { id: true, name: true, avatarColor: true } } },
        orderBy: orderBy(params, ['createdAt', 'updatedAt', 'company', 'score', 'estimatedValue', 'status']),
        skip: params.skip,
        take: params.take,
      }),
      prisma.lead.count({ where }),
    ]);
    return paged(maskFields(request.user, 'leads', data), total, params);
  });

  app.get('/api/leads/:id', { preHandler: requirePermission('leads', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const lead = await prisma.lead.findFirst({
      where: { id, deletedAt: null },
      include: {
        owner: { select: { id: true, name: true, avatarColor: true } },
        activities: { orderBy: { createdAt: 'desc' }, include: { owner: { select: { name: true, avatarColor: true } } } },
        attachments: true,
        convertedAccount: { select: { id: true, name: true } },
      },
    });
    if (!lead) throw notFound('Lead not found.');
    if (!(await ownerAllowed(request.user, 'leads', 'read', lead.ownerId))) throw forbidden();
    auditRead(request.user, 'Lead', lead.id, `${lead.firstName} ${lead.lastName}`, clientIp(request));
    return maskFields(request.user, 'leads', lead);
  });

  app.get('/api/leads/check-duplicates', { preHandler: requirePermission('leads', 'read') }, async (request) => {
    const q = request.query as Record<string, string>;
    return checkDuplicates({
      module: 'leads',
      company: q.company,
      email: q.email,
      domain: q.domain ? extractDomain(q.domain) : undefined,
      excludeId: q.excludeId,
    });
  });

  app.post('/api/leads', { preHandler: requirePermission('leads', 'create') }, async (request, reply) => {
    const parsed = leadSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = stripUnwritableFields(request.user, 'leads', parsed.data as Record<string, unknown>) as z.infer<typeof leadSchema>;

    const domain = extractDomain(body.domain) ?? extractDomain(body.email);
    const dupes = await checkDuplicates({ module: 'leads', company: body.company, email: body.email, domain });
    if ((dupes.blocked || dupes.hasDuplicates) && !body.ignoreDuplicates) {
      throw conflict('Possible duplicate — review before saving.', dupes);
    }

    const { ignoreDuplicates: _i, ...data } = body;
    const lead = await prisma.lead.create({
      data: {
        ...data,
        email: data.email || null,
        domain,
        ownerId: data.ownerId ?? request.user.id,
        estimatedValue: data.estimatedValue ?? null,
        customFields: (await sanitizeCustomFields('leads', data.customFields, {}, { enforceRequired: true })) as never,
        lastActivityAt: new Date(),
      },
    });

    if (dupes.hasDuplicates) {
      await notify({
        event: 'duplicate_found',
        title: 'Possible duplicate lead created',
        body: `${lead.company} matched ${dupes.matches.length} existing record(s).`,
        link: `/leads/${lead.id}`,
        severity: 'warn',
        ownerId: lead.ownerId,
      });
    }
    if (lead.ownerId && lead.ownerId !== request.user.id) {
      await notify({
        event: 'lead_assigned',
        title: `New lead assigned: ${lead.company}`,
        body: `${lead.firstName} ${lead.lastName} — ${lead.source}`,
        link: `/leads/${lead.id}`,
        ownerId: lead.ownerId,
      });
    }

    await audit({ user: request.user, action: 'create', entity: 'Lead', entityId: lead.id, summary: `${lead.company} — ${lead.firstName} ${lead.lastName}`, ip: clientIp(request) });
    return reply.status(201).send(maskFields(request.user, 'leads', lead));
  });

  app.patch('/api/leads/:id', { preHandler: requirePermission('leads', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.lead.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Lead not found.');
    if (!(await ownerAllowed(request.user, 'leads', 'update', existing.ownerId))) throw forbidden();
    if (existing.status === 'CONVERTED') throw badRequest('This lead is already converted and cannot be edited.');

    const parsed = leadSchema.partial().safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const { ignoreDuplicates: _i, ...body } = stripUnwritableFields(request.user, 'leads', parsed.data as Record<string, unknown>);

    const data: Record<string, unknown> = { ...body, lastActivityAt: new Date() };
    if ('email' in body || 'domain' in body) {
      data.domain = extractDomain((body.domain as string) ?? existing.domain) ?? extractDomain((body.email as string) ?? existing.email);
    }
    if (body.email === '') data.email = null;

    if ('customFields' in body) {
      data.customFields = await sanitizeCustomFields('leads', body.customFields, (existing.customFields ?? {}) as Record<string, unknown>);
    }

    const lead = await prisma.lead.update({ where: { id }, data: data as never });
    if (body.ownerId && body.ownerId !== existing.ownerId) {
      await notify({
        event: 'lead_assigned',
        title: `Lead assigned to you: ${lead.company}`,
        link: `/leads/${lead.id}`,
        ownerId: lead.ownerId,
      });
    }
    await audit({
      user: request.user, action: 'update', entity: 'Lead', entityId: id, summary: lead.company,
      changes: diff(existing as unknown as Record<string, unknown>, lead as unknown as Record<string, unknown>),
      undo: undoUpdate('lead', 'leads', id, existing as unknown as Record<string, unknown>,
        diff(existing as unknown as Record<string, unknown>, lead as unknown as Record<string, unknown>)),
      ip: clientIp(request),
    });
    return maskFields(request.user, 'leads', lead);
  });

  app.delete('/api/leads/:id', { preHandler: requirePermission('leads', 'delete') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.lead.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw notFound('Lead not found.');
    if (!(await ownerAllowed(request.user, 'leads', 'delete', existing.ownerId))) throw forbidden();
    await prisma.lead.update({ where: { id }, data: { deletedAt: new Date() } });
    const undoId = await audit({ user: request.user, action: 'delete', entity: 'Lead', entityId: id, summary: existing.company,
      undo: undoSoftDelete('lead', 'leads', id), ip: clientIp(request) });
    return { ok: true, undoId };
  });

  /**
   * Convert: lead -> account + contact + (optionally) deal, in one transaction.
   * Reuses an existing account when the domain already matches, which is how a
   * second lead from the same customer stops becoming a second account.
   */
  app.post('/api/leads/:id/convert', { preHandler: requirePermission('leads', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const schema = z.object({
      accountId: z.string().optional(),
      accountType: z.enum(['CUSTOMER', 'PARTNER', 'PROSPECT']).default('CUSTOMER'),
      createDeal: z.boolean().default(true),
      dealName: z.string().optional(),
      dealAmount: z.number().nonnegative().optional(),
      dealType: z.enum(['PRODUCT', 'SERVICE', 'MIXED']).default('PRODUCT'),
      pipelineId: z.string().optional(),
      stageId: z.string().optional(),
      closeDate: z.string().optional(),
      partnerAccountId: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);
    const input = parsed.data;

    const lead = await prisma.lead.findFirst({ where: { id, deletedAt: null } });
    if (!lead) throw notFound('Lead not found.');
    if (!(await ownerAllowed(request.user, 'leads', 'update', lead.ownerId))) throw forbidden();
    if (lead.status === 'CONVERTED') throw badRequest('This lead has already been converted.');

    // Pick the account: explicit choice, then domain match, then create a new one.
    let account = input.accountId
      ? await prisma.account.findFirst({ where: { id: input.accountId, deletedAt: null } })
      : lead.domain
        ? await prisma.account.findFirst({ where: { domain: lead.domain, deletedAt: null } })
        : null;

    if (!account) {
      account = await prisma.account.create({
        data: {
          name: lead.company,
          type: input.accountType,
          domain: lead.domain,
          industry: null,
          emirate: lead.emirate,
          country: lead.country,
          phone: lead.phone,
          email: lead.email,
          ownerId: lead.ownerId ?? request.user.id,
          lastActivityAt: new Date(),
        },
      });
    }

    const contact = await prisma.contact.create({
      data: {
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email,
        phone: lead.phone,
        jobTitle: lead.jobTitle,
        linkedinUrl: lead.linkedinUrl,
        accountId: account.id,
        ownerId: lead.ownerId ?? request.user.id,
        isPrimary: (await prisma.contact.count({ where: { accountId: account.id } })) === 0,
      },
    });

    let deal = null;
    if (input.createDeal) {
      const pipeline = input.pipelineId
        ? await prisma.pipeline.findUnique({ where: { id: input.pipelineId }, include: { stages: { orderBy: { order: 'asc' } } } })
        : await prisma.pipeline.findFirst({ where: { isDefault: true, isActive: true }, include: { stages: { orderBy: { order: 'asc' } } } });
      if (!pipeline || pipeline.stages.length === 0) throw badRequest('No pipeline with stages is configured yet.');

      const stage = input.stageId ? pipeline.stages.find((s) => s.id === input.stageId) : pipeline.stages[0];
      if (!stage) throw badRequest('That stage does not belong to the chosen pipeline.');

      const net = input.dealAmount ?? Number(lead.estimatedValue ?? 0);
      const rate = await vatRate();
      const { vatAmount, total } = applyVat(net, rate);

      deal = await prisma.deal.create({
        data: {
          reference: await nextReference('deal'),
          name: input.dealName ?? `${lead.company} — ${lead.interestArea ?? 'Opportunity'}`,
          accountId: account.id,
          partnerAccountId: input.partnerAccountId ?? lead.sourcePartnerId ?? null,
          primaryContactId: contact.id,
          pipelineId: pipeline.id,
          stageId: stage.id,
          type: input.dealType,
          amount: net,
          vatRate: rate,
          vatAmount,
          totalAmount: total,
          probability: stage.probability,
          closeDate: input.closeDate ? new Date(input.closeDate) : new Date(Date.now() + 30 * 86_400_000),
          source: lead.source,
          sourcePartnerId: lead.sourcePartnerId,
          ownerId: lead.ownerId ?? request.user.id,
          lastActivityAt: new Date(),
        },
      });

      await prisma.stageHistory.create({
        data: { dealId: deal.id, toStageId: stage.id, toStatus: 'OPEN', amount: net, changedById: request.user.id },
      });
    }

    await prisma.$transaction([
      prisma.lead.update({
        where: { id },
        data: {
          status: 'CONVERTED',
          convertedAt: new Date(),
          convertedAccountId: account.id,
          convertedContactId: contact.id,
          convertedDealId: deal?.id ?? null,
        },
      }),
      prisma.activity.updateMany({ where: { leadId: id }, data: { accountId: account.id, contactId: contact.id, dealId: deal?.id ?? null } }),
      prisma.attachment.updateMany({ where: { leadId: id }, data: { accountId: account.id, dealId: deal?.id ?? null } }),
    ]);

    if (deal) {
      await notify({
        event: 'deal_assigned',
        title: `Deal created from lead: ${deal.name}`,
        body: `${account.name} · ${formatAed(Number(deal.amount))} net`,
        link: `/deals/${deal.id}`,
        ownerId: deal.ownerId,
        facts: [
          { title: 'Customer', value: account.name },
          { title: 'Value', value: formatAed(Number(deal.amount)) },
          { title: 'Source', value: deal.source },
        ],
      });
    }

    await audit({
      user: request.user, action: 'convert', entity: 'Lead', entityId: id,
      summary: `Converted ${lead.company} → account ${account.name}${deal ? `, deal ${deal.reference}` : ''}`,
      ip: clientIp(request),
    });

    return { accountId: account.id, contactId: contact.id, dealId: deal?.id ?? null };
  });
}
