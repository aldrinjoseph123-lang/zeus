import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma, num } from '../db.js';
import { listParams, requirePermission } from '../lib/http.js';
import { scopeWhere, permissionFor } from '../auth/rbac.js';
import { getSetting } from '../lib/settings.js';

/**
 * Dashboard aggregates. Every figure is derived from the same scope filter the
 * list views use, so a rep's dashboard shows a rep's numbers and a manager's
 * shows the whole desk — without a second permission model.
 */

function quarterBounds(date = new Date()): { start: Date; end: Date; year: number; quarter: number } {
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  const start = new Date(Date.UTC(date.getFullYear(), (quarter - 1) * 3, 1));
  const end = new Date(Date.UTC(date.getFullYear(), quarter * 3, 1));
  return { start, end, year: date.getFullYear(), quarter };
}

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/dashboard/overview', { preHandler: requirePermission('dashboard', 'read') }, async (request) => {
    const params = listParams(request.query as Record<string, unknown>);
    const f = params.filters;

    // A rep whose dashboard scope is "own" only ever sees their own numbers.
    const dashScope = permissionFor(request.user, 'dashboard').read;
    const dealScope =
      dashScope === 'own' ? { ownerId: request.user.id } : await scopeWhere(request.user, 'deals', 'read');

    const from = f.from ? new Date(f.from) : new Date(Date.now() - 365 * 86_400_000);
    const to = f.to ? new Date(f.to) : new Date(Date.now() + 365 * 86_400_000);
    const q = quarterBounds();

    const base: Prisma.DealWhereInput = {
      deletedAt: null,
      ...(dealScope as Prisma.DealWhereInput),
      ...(f.ownerId ? { ownerId: f.ownerId } : {}),
      ...(f.pipelineId ? { pipelineId: f.pipelineId } : {}),
      ...(f.type ? { type: f.type as 'PRODUCT' | 'SERVICE' | 'MIXED' } : {}),
    };

    const openWhere: Prisma.DealWhereInput = { ...base, status: 'OPEN' };
    const closedWindow: Prisma.DealWhereInput = { ...base, status: { in: ['WON', 'LOST'] }, closedAt: { gte: from, lte: to } };

    const [
      openDeals,
      wonQuarter,
      lostQuarter,
      wonWindow,
      lostWindow,
      newLeads,
      openLeads,
      staleAccounts,
      overdueTasks,
    ] = await Promise.all([
      prisma.deal.findMany({ where: openWhere, select: { id: true, amount: true, probability: true, closeDate: true, stageChangedAt: true, createdAt: true } }),
      prisma.deal.aggregate({ where: { ...base, status: 'WON', closedAt: { gte: q.start, lt: q.end } }, _sum: { amount: true }, _count: true }),
      prisma.deal.aggregate({ where: { ...base, status: 'LOST', closedAt: { gte: q.start, lt: q.end } }, _sum: { amount: true }, _count: true }),
      prisma.deal.aggregate({ where: { ...closedWindow, status: 'WON' }, _sum: { amount: true }, _count: true, _avg: { amount: true } }),
      prisma.deal.aggregate({ where: { ...closedWindow, status: 'LOST' }, _sum: { amount: true }, _count: true }),
      prisma.lead.count({ where: { deletedAt: null, createdAt: { gte: q.start }, ...(f.ownerId ? { ownerId: f.ownerId } : {}) } }),
      prisma.lead.count({ where: { deletedAt: null, status: { notIn: ['CONVERTED', 'DISQUALIFIED'] }, ...(f.ownerId ? { ownerId: f.ownerId } : {}) } }),
      (async () => {
        const days = Number(await getSetting<number>('pipeline.staleAccountDays', 7));
        return prisma.account.count({
          where: {
            deletedAt: null,
            type: { in: ['CUSTOMER', 'PROSPECT', 'PARTNER'] },
            OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: new Date(Date.now() - days * 86_400_000) } }],
          },
        });
      })(),
      prisma.activity.count({ where: { status: 'Open', dueAt: { lt: new Date() }, ...(dashScope === 'own' ? { ownerId: request.user.id } : {}) } }),
    ]);

    const openNet = openDeals.reduce((s, d) => s + num(d.amount), 0);
    const weighted = openDeals.reduce((s, d) => s + (num(d.amount) * d.probability) / 100, 0);
    const wonCount = wonWindow._count;
    const lostCount = lostWindow._count;
    const winRate = wonCount + lostCount === 0 ? 0 : (wonCount / (wonCount + lostCount)) * 100;

    // ── target attainment ─────────────────────────────────────────────────────
    const targetWhere = f.ownerId ? { userId: f.ownerId } : dashScope === 'own' ? { userId: request.user.id } : { userId: null };
    const target = await prisma.target.findFirst({ where: { ...targetWhere, year: q.year, quarter: q.quarter } });
    const targetAmount = num(target?.amount);
    const wonQuarterNet = num(wonQuarter._sum.amount);

    // ── funnel by stage ───────────────────────────────────────────────────────
    const stageGroups = await prisma.deal.groupBy({
      by: ['stageId'],
      where: openWhere,
      _sum: { amount: true },
      _count: true,
    });
    const stages = await prisma.stage.findMany({
      where: { id: { in: stageGroups.map((g) => g.stageId) } },
      select: { id: true, name: true, order: true, color: true, probability: true, pipeline: { select: { name: true, kind: true } } },
    });
    const funnel = stages
      .map((stage) => {
        const g = stageGroups.find((x) => x.stageId === stage.id);
        return {
          stageId: stage.id,
          name: stage.name,
          order: stage.order,
          color: stage.color,
          probability: stage.probability,
          pipeline: stage.pipeline.name,
          count: g?._count ?? 0,
          value: num(g?._sum.amount),
          weighted: (num(g?._sum.amount) * stage.probability) / 100,
        };
      })
      .sort((a, b) => a.order - b.order);

    // ── monthly series: won revenue vs weighted pipeline by expected close ─────
    const monthly = await prisma.$queryRaw<Array<{ month: Date; won: number; lost: number; open_weighted: number; open_net: number }>>`
      SELECT date_trunc('month', COALESCE(d."closedAt", d."closeDate"))::date AS month,
             COALESCE(SUM(CASE WHEN d.status = 'WON'  THEN d.amount ELSE 0 END), 0)::float8 AS won,
             COALESCE(SUM(CASE WHEN d.status = 'LOST' THEN d.amount ELSE 0 END), 0)::float8 AS lost,
             COALESCE(SUM(CASE WHEN d.status = 'OPEN' THEN d.amount * d.probability / 100 ELSE 0 END), 0)::float8 AS open_weighted,
             COALESCE(SUM(CASE WHEN d.status = 'OPEN' THEN d.amount ELSE 0 END), 0)::float8 AS open_net
      FROM "Deal" d
      WHERE d."deletedAt" IS NULL
        AND COALESCE(d."closedAt", d."closeDate") BETWEEN ${from} AND ${to}
        ${f.ownerId ? Prisma.sql`AND d."ownerId" = ${f.ownerId}` : Prisma.empty}
        ${dashScope === 'own' ? Prisma.sql`AND d."ownerId" = ${request.user.id}` : Prisma.empty}
        ${f.pipelineId ? Prisma.sql`AND d."pipelineId" = ${f.pipelineId}` : Prisma.empty}
      GROUP BY 1 ORDER BY 1
    `;

    // ── source attribution ────────────────────────────────────────────────────
    const sourceRows = await prisma.$queryRaw<Array<{ source: string; deals: bigint; net: number; won: number; won_count: bigint }>>`
      SELECT d.source,
             COUNT(*)::bigint AS deals,
             COALESCE(SUM(d.amount), 0)::float8 AS net,
             COALESCE(SUM(CASE WHEN d.status = 'WON' THEN d.amount ELSE 0 END), 0)::float8 AS won,
             COUNT(*) FILTER (WHERE d.status = 'WON')::bigint AS won_count
      FROM "Deal" d
      WHERE d."deletedAt" IS NULL
        ${dashScope === 'own' ? Prisma.sql`AND d."ownerId" = ${request.user.id}` : Prisma.empty}
        ${f.ownerId ? Prisma.sql`AND d."ownerId" = ${f.ownerId}` : Prisma.empty}
      GROUP BY 1 ORDER BY net DESC
    `;

    // ── direct vs partner-sourced, product vs service ─────────────────────────
    const [partnerSplit, typeSplit] = await Promise.all([
      prisma.$queryRaw<Array<{ channel: string; deals: bigint; net: number; won: number }>>`
        SELECT CASE WHEN d."partnerAccountId" IS NULL THEN 'Direct' ELSE 'Partner-sourced' END AS channel,
               COUNT(*)::bigint AS deals,
               COALESCE(SUM(d.amount), 0)::float8 AS net,
               COALESCE(SUM(CASE WHEN d.status = 'WON' THEN d.amount ELSE 0 END), 0)::float8 AS won
        FROM "Deal" d
        WHERE d."deletedAt" IS NULL
          ${dashScope === 'own' ? Prisma.sql`AND d."ownerId" = ${request.user.id}` : Prisma.empty}
        GROUP BY 1
      `,
      prisma.deal.groupBy({ by: ['type'], where: base, _sum: { amount: true }, _count: true }),
    ]);

    // ── rep leaderboard ───────────────────────────────────────────────────────
    const owners = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, avatarColor: true, team: { select: { name: true } } },
    });
    const [openByOwner, wonByOwner, targets] = await Promise.all([
      prisma.deal.groupBy({ by: ['ownerId'], where: openWhere, _sum: { amount: true }, _count: true }),
      prisma.deal.groupBy({ by: ['ownerId'], where: { ...base, status: 'WON', closedAt: { gte: q.start, lt: q.end } }, _sum: { amount: true }, _count: true }),
      prisma.target.findMany({ where: { year: q.year, quarter: q.quarter, userId: { not: null } } }),
    ]);
    const weightedByOwner = new Map<string, number>();
    for (const d of await prisma.deal.findMany({ where: openWhere, select: { ownerId: true, amount: true, probability: true } })) {
      if (!d.ownerId) continue;
      weightedByOwner.set(d.ownerId, (weightedByOwner.get(d.ownerId) ?? 0) + (num(d.amount) * d.probability) / 100);
    }

    const leaderboard = owners
      .map((owner) => {
        const open = openByOwner.find((x) => x.ownerId === owner.id);
        const won = wonByOwner.find((x) => x.ownerId === owner.id);
        const ownerTarget = num(targets.find((t) => t.userId === owner.id)?.amount);
        const wonNet = num(won?._sum.amount);
        return {
          id: owner.id,
          name: owner.name,
          avatarColor: owner.avatarColor,
          team: owner.team?.name ?? null,
          openCount: open?._count ?? 0,
          openNet: num(open?._sum.amount),
          weighted: weightedByOwner.get(owner.id) ?? 0,
          wonCount: won?._count ?? 0,
          wonNet,
          target: ownerTarget,
          attainment: ownerTarget ? (wonNet / ownerTarget) * 100 : null,
        };
      })
      .filter((row) => row.openCount > 0 || row.wonCount > 0 || row.target > 0)
      .sort((a, b) => b.wonNet - a.wonNet);

    // ── ageing buckets on open deals ──────────────────────────────────────────
    const now = Date.now();
    const buckets = [
      { label: '0-14 days', min: 0, max: 14 },
      { label: '15-30 days', min: 15, max: 30 },
      { label: '31-60 days', min: 31, max: 60 },
      { label: '61-90 days', min: 61, max: 90 },
      { label: '90+ days', min: 91, max: Infinity },
    ].map((b) => ({ ...b, count: 0, value: 0 }));
    let overdueCount = 0;
    let overdueValue = 0;
    for (const d of openDeals) {
      const age = Math.floor((now - d.createdAt.getTime()) / 86_400_000);
      const bucket = buckets.find((b) => age >= b.min && age <= b.max);
      if (bucket) { bucket.count += 1; bucket.value += num(d.amount); }
      if (d.closeDate.getTime() < now) { overdueCount += 1; overdueValue += num(d.amount); }
    }

    // ── average sales cycle from won deals in the window ───────────────────────
    const cycle = await prisma.$queryRaw<Array<{ avg_days: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM (d."closedAt" - d."createdAt")) / 86400)::float8 AS avg_days
      FROM "Deal" d
      WHERE d."deletedAt" IS NULL AND d.status = 'WON' AND d."closedAt" BETWEEN ${from} AND ${to}
        ${dashScope === 'own' ? Prisma.sql`AND d."ownerId" = ${request.user.id}` : Prisma.empty}
    `;

    const topDeals = await prisma.deal.findMany({
      where: openWhere,
      select: {
        id: true, reference: true, name: true, amount: true, probability: true, closeDate: true,
        account: { select: { name: true } }, stage: { select: { name: true, color: true } }, owner: { select: { name: true } },
      },
      orderBy: { amount: 'desc' },
      take: 10,
    });

    return {
      period: { from, to, quarter: `Q${q.quarter} ${q.year}` },
      kpis: {
        openPipelineNet: openNet,
        openDealCount: openDeals.length,
        weightedForecast: weighted,
        wonQuarterNet,
        wonQuarterCount: wonQuarter._count,
        lostQuarterNet: num(lostQuarter._sum.amount),
        lostQuarterCount: lostQuarter._count,
        winRate,
        avgDealSize: num(wonWindow._avg.amount),
        avgCycleDays: cycle[0]?.avg_days ?? null,
        newLeadsThisQuarter: newLeads,
        openLeads: openLeads,
        staleAccounts,
        overdueTasks,
        overdueDeals: overdueCount,
        overdueDealValue: overdueValue,
      },
      target: {
        amount: targetAmount,
        achieved: wonQuarterNet,
        attainment: targetAmount ? (wonQuarterNet / targetAmount) * 100 : null,
        gap: Math.max(0, targetAmount - wonQuarterNet),
        weightedCoverage: targetAmount ? ((wonQuarterNet + weighted) / targetAmount) * 100 : null,
      },
      funnel,
      monthly: monthly.map((m) => ({
        month: m.month,
        won: Number(m.won),
        lost: Number(m.lost),
        openWeighted: Number(m.open_weighted),
        openNet: Number(m.open_net),
      })),
      bySource: sourceRows.map((r) => ({
        source: r.source,
        deals: Number(r.deals),
        net: Number(r.net),
        won: Number(r.won),
        wonCount: Number(r.won_count),
        winRate: Number(r.deals) ? (Number(r.won_count) / Number(r.deals)) * 100 : 0,
      })),
      byChannel: partnerSplit.map((r) => ({ channel: r.channel, deals: Number(r.deals), net: Number(r.net), won: Number(r.won) })),
      byType: typeSplit.map((r) => ({ type: r.type, count: r._count, net: num(r._sum.amount) })),
      leaderboard,
      ageing: buckets.map(({ label, count, value }) => ({ label, count, value })),
      topDeals: topDeals.map((d) => ({ ...d, amount: num(d.amount) })),
    };
  });

  /** Everything the "needs attention" strip renders. */
  app.get('/api/dashboard/attention', { preHandler: requirePermission('dashboard', 'read') }, async (request) => {
    const dashScope = permissionFor(request.user, 'dashboard').read;
    const mine = dashScope === 'own' ? { ownerId: request.user.id } : {};

    const [staleDays, staleDealDays, regDays] = await Promise.all([
      getSetting<number>('pipeline.staleAccountDays', 7),
      getSetting<number>('pipeline.staleDealDays', 14),
      getSetting<number>('pipeline.registrationExpiryWarnDays', 30),
    ]);

    const [staleAccounts, stuckDeals, expiringRegistrations, overdueTasks, overdueInvoices] = await Promise.all([
      prisma.account.findMany({
        where: {
          deletedAt: null,
          type: { in: ['CUSTOMER', 'PROSPECT', 'PARTNER'] },
          ...mine,
          OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: new Date(Date.now() - Number(staleDays) * 86_400_000) } }],
        },
        select: { id: true, name: true, type: true, lastActivityAt: true, owner: { select: { name: true } }, _count: { select: { deals: true } } },
        orderBy: { lastActivityAt: 'asc' },
        take: 25,
      }),
      prisma.deal.findMany({
        where: { deletedAt: null, status: 'OPEN', ...mine, stageChangedAt: { lt: new Date(Date.now() - Number(staleDealDays) * 86_400_000) } },
        select: {
          id: true, reference: true, name: true, amount: true, stageChangedAt: true, closeDate: true,
          stage: { select: { name: true, color: true } }, account: { select: { name: true } }, owner: { select: { name: true } },
        },
        orderBy: { stageChangedAt: 'asc' },
        take: 25,
      }),
      prisma.dealRegistration.findMany({
        where: {
          status: { in: ['SUBMITTED', 'APPROVED'] },
          expiresAt: { not: null, lte: new Date(Date.now() + Number(regDays) * 86_400_000) },
          deal: { deletedAt: null, status: 'OPEN', ...mine },
        },
        include: {
          vendor: { select: { name: true } },
          partner: { select: { name: true } },
          deal: { select: { id: true, reference: true, name: true, account: { select: { name: true } } } },
        },
        orderBy: { expiresAt: 'asc' },
        take: 25,
      }),
      prisma.activity.findMany({
        where: { status: 'Open', dueAt: { lt: new Date() }, ...(dashScope === 'own' ? { ownerId: request.user.id } : {}) },
        include: { owner: { select: { name: true } }, deal: { select: { id: true, reference: true } }, account: { select: { id: true, name: true } } },
        orderBy: { dueAt: 'asc' },
        take: 25,
      }),
      prisma.invoice.findMany({
        where: { status: { in: ['SENT', 'PARTIAL'] }, dueDate: { lt: new Date() } },
        include: { account: { select: { id: true, name: true } } },
        orderBy: { dueDate: 'asc' },
        take: 25,
      }),
    ]);

    return {
      thresholds: { staleAccountDays: Number(staleDays), staleDealDays: Number(staleDealDays), registrationWarnDays: Number(regDays) },
      staleAccounts,
      stuckDeals: stuckDeals.map((d) => ({ ...d, amount: num(d.amount) })),
      expiringRegistrations,
      overdueTasks,
      overdueInvoices: overdueInvoices.map((i) => ({ ...i, total: num(i.total), amountPaid: num(i.amountPaid) })),
    };
  });
}
