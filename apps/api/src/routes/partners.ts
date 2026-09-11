import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit, diff } from '../lib/audit.js';
import { badRequest, clientIp, notFound, requirePermission } from '../lib/http.js';
import { ownerAllowed, scopeWhere } from '../auth/rbac.js';
import { getSetting } from '../lib/settings.js';
import { touch, touchContact } from '../lib/touch.js';

/**
 * The partner register.
 *
 * Zeus tracked what partners *transact* — deals, registrations, protection — and nothing
 * about the relationship behind it. There was no answer at all to "when did we last speak
 * to them", which is the question that decides a week once the roster grows past what one
 * person can hold in their head.
 *
 * Scoped on `channelManagerId` rather than `ownerId`: the person who looks after a partner
 * is often not the one on their deals, which is the whole reason the field exists.
 */

/** Contact types a person can log from the register. Not TASK — a task is not contact. */
const LOGGABLE = ['VISIT', 'CALL', 'MEETING', 'EMAIL', 'REQUEST', 'NOTE'] as const;

const patchSchema = z.object({
  channelManagerId: z.string().nullable().optional(),
  /** Null puts the partner back on the house rhythm rather than leaving it unchecked. */
  engagementCadenceDays: z.number().int().min(1).max(3650).nullable().optional(),
  isDormant: z.boolean().optional(),
});

const logSchema = z.object({
  type: z.enum(LOGGABLE),
  subject: z.string().min(1, 'Say what it was.'),
  description: z.string().optional(),
  /** Who you met. Optional, because a visit logged in a car park beats one never logged. */
  contactId: z.string().nullable().optional(),
  occurredAt: z.string().datetime().optional(),
  /** The next one, booked before you leave. Absent means you skipped it. */
  followUpAt: z.string().datetime().nullable().optional(),
  followUpOwnerId: z.string().nullable().optional(),
});

export default async function partnerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * One row per partner, most overdue first — a plan for the week rather than an A–Z
   * list to scroll. The rhythm is per-partner with a house fallback, so the due date is
   * computed per row rather than in SQL; at a roster of tens that is cheaper to read and
   * no slower to run than the query that would avoid it.
   */
  app.get('/api/partners', { preHandler: requirePermission('partners', 'read') }, async (request) => {
    const query = request.query as { includeDormant?: string };
    const includeDormant = query.includeDormant === 'true';
    const [scope, houseCadence] = await Promise.all([
      scopeWhere(request.user, 'partners', 'read', 'channelManagerId'),
      getSetting<number>('partners.contactCadenceDays', 30),
    ]);

    const partners = await prisma.account.findMany({
      where: {
        type: 'PARTNER',
        deletedAt: null,
        ...(includeDormant ? {} : { isDormant: false }),
        ...scope,
      },
      select: {
        id: true, name: true, isDormant: true, lastContactAt: true, engagementCadenceDays: true,
        channelManager: { select: { id: true, name: true } },
        owner: { select: { id: true, name: true } },
        _count: { select: { partnerDeals: { where: { deletedAt: null, status: 'OPEN' } } } },
      },
    });

    const now = Date.now();
    const rows = partners.map((p) => {
      const cadence = p.engagementCadenceDays ?? Number(houseCadence);
      const dueAt = p.lastContactAt ? new Date(p.lastContactAt.getTime() + cadence * 86_400_000) : null;
      return {
        id: p.id,
        name: p.name,
        isDormant: p.isDormant,
        channelManager: p.channelManager,
        owner: p.owner,
        openDeals: p._count.partnerDeals,
        cadenceDays: cadence,
        /** True when this partner sets its own rhythm, so the screen can say so. */
        cadenceIsOwn: p.engagementCadenceDays !== null,
        lastContactAt: p.lastContactAt,
        dueAt,
        /**
         * Never contacted reads as overdue, not as fine. A partner with no history is
         * exactly the one nobody has got to — which is the point of the list.
         */
        overdueDays: p.lastContactAt
          ? Math.max(0, Math.floor((now - (dueAt as Date).getTime()) / 86_400_000))
          : null,
      };
    });

    // Never contacted first, then longest overdue. Everything in hand sorts below, by name.
    rows.sort((a, b) => {
      const rank = (r: typeof a) => (r.lastContactAt === null ? 2 : (r.overdueDays ?? 0) > 0 ? 1 : 0);
      if (rank(a) !== rank(b)) return rank(b) - rank(a);
      if (rank(a) === 1) return (b.overdueDays ?? 0) - (a.overdueDays ?? 0);
      return a.name.localeCompare(b.name);
    });

    return {
      rows,
      houseCadenceDays: Number(houseCadence),
      /** Counted here so the page does not have to re-derive what the sort already knows. */
      overdue: rows.filter((r) => r.lastContactAt === null || (r.overdueDays ?? 0) > 0).length,
      unmanaged: rows.filter((r) => !r.channelManager).length,
    };
  });

  app.patch('/api/partners/:id', { preHandler: requirePermission('partners', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = await prisma.account.findFirst({ where: { id, type: 'PARTNER', deletedAt: null } });
    if (!existing) throw notFound('Partner not found.');
    if (!(await ownerAllowed(request.user, 'partners', 'update', existing.channelManagerId))) {
      throw badRequest('You can only change partners you manage.');
    }

    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);

    const updated = await prisma.account.update({ where: { id }, data: parsed.data });
    await audit({
      user: request.user, action: 'update', entity: 'Account', entityId: id,
      summary: updated.name, changes: diff(existing, updated), ip: clientIp(request),
    });
    return updated;
  });

  /**
   * The ten-second log.
   *
   * One request records what happened and books the next one, because the realistic
   * failure of this whole register is not a wrong design — it is an empty register in
   * three months. A visit gets logged in a car park or it never gets logged, and every
   * extra round trip is another chance for that to happen.
   */
  app.post('/api/partners/:id/log', { preHandler: requirePermission('partners', 'update') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const partner = await prisma.account.findFirst({ where: { id, type: 'PARTNER', deletedAt: null } });
    if (!partner) throw notFound('Partner not found.');
    if (!(await ownerAllowed(request.user, 'partners', 'update', partner.channelManagerId))) {
      throw badRequest('You can only log against partners you manage.');
    }

    const parsed = logSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message, parsed.error.issues);
    const body = parsed.data;

    // A request from a partner is the one thing here that stays open — it is waiting on
    // us, and its age is the number. Everything else is a record of something done.
    const isOpenRequest = body.type === 'REQUEST';
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();

    const logged = await prisma.activity.create({
      data: {
        type: body.type,
        subject: body.subject,
        description: body.description ?? null,
        status: isOpenRequest ? 'Open' : 'Completed',
        completedAt: isOpenRequest ? null : occurredAt,
        accountId: id,
        contactId: body.contactId ?? null,
        ownerId: request.user.id,
        createdById: request.user.id,
      },
    });

    // The follow-up defaults to the channel manager rather than whoever typed the note,
    // so a colleague covering a visit does not silently inherit the relationship.
    const followUp = body.followUpAt
      ? await prisma.activity.create({
          data: {
            type: 'TASK',
            subject: `Follow up with ${partner.name}`,
            status: 'Open',
            dueAt: new Date(body.followUpAt),
            accountId: id,
            ownerId: body.followUpOwnerId ?? partner.channelManagerId ?? request.user.id,
            createdById: request.user.id,
          },
        })
      : null;

    await touch({ accountId: id });
    await touchContact({ accountId: id, type: logged.type, status: logged.status, at: occurredAt });
    await audit({
      user: request.user, action: 'create', entity: 'Activity', entityId: logged.id,
      summary: `${body.type.toLowerCase()} · ${partner.name}`, ip: clientIp(request),
    });
    return reply.status(201).send({ logged, followUp });
  });

  /** Everything logged against this partner, newest first — the Engagement tab. */
  app.get('/api/partners/:id/engagement', { preHandler: requirePermission('partners', 'read') }, async (request) => {
    const { id } = request.params as { id: string };
    const partner = await prisma.account.findFirst({
      where: { id, type: 'PARTNER', deletedAt: null },
      select: {
        id: true, name: true, isDormant: true, lastContactAt: true, engagementCadenceDays: true,
        channelManager: { select: { id: true, name: true } },
      },
    });
    if (!partner) throw notFound('Partner not found.');

    const activities = await prisma.activity.findMany({
      where: { accountId: id, type: { in: [...LOGGABLE, 'TASK'] } },
      orderBy: [{ completedAt: 'desc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      select: {
        id: true, type: true, subject: true, description: true, status: true,
        dueAt: true, completedAt: true, createdAt: true,
        owner: { select: { id: true, name: true } },
        contact: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    const houseCadence = await getSetting<number>('partners.contactCadenceDays', 30);
    return {
      partner: { ...partner, cadenceDays: partner.engagementCadenceDays ?? Number(houseCadence) },
      activities,
      /** Requests still waiting on us, oldest first — the partner's side of the relationship. */
      openRequests: activities.filter((a) => a.type === 'REQUEST' && a.status === 'Open').length,
    };
  });
}
