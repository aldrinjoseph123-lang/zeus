import type { FastifyInstance } from 'fastify';
import { prisma, num } from '../db.js';
import { forbidden, notFound, requirePermission } from '../lib/http.js';
import { teamMemberIds, permissionFor } from '../auth/rbac.js';
import { getSetting } from '../lib/settings.js';

/**
 * Coaching data for one rep — the numbers a manager and rep walk through in a 1:1:
 * pipeline by stage, quota progress, the deals that need escalation, and activity /
 * win-loss. Rep sees their own; a manager sees their team; an admin (deals:read=all)
 * sees anyone.
 */

function quarterBounds(now = new Date()): { year: number; quarter: number; start: Date; end: Date } {
  const year = now.getUTCFullYear();
  const quarter = Math.floor(now.getUTCMonth() / 3) + 1;
  const start = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const end = new Date(Date.UTC(year, quarter * 3, 1));
  return { year, quarter, start, end };
}

export default async function coachingRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/coaching/:userId', { preHandler: requirePermission('deals', 'read') }, async (request) => {
    const { userId } = request.params as { userId: string };

    // Access: self, a direct report, or a role that sees every deal.
    const seesAll = permissionFor(request.user, 'deals').read === 'all';
    const team = await teamMemberIds(request.user);
    if (userId !== request.user.id && !team.includes(userId) && !seesAll) throw forbidden();

    const rep = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true, avatarColor: true } });
    if (!rep) throw notFound('User not found.');

    const { year, quarter, start, end } = quarterBounds();
    const [openDeals, target, companyTarget, wonAgg, activities, recentClosed, highValue, minMargin] = await Promise.all([
      prisma.deal.findMany({
        where: { deletedAt: null, status: 'OPEN', ownerId: userId },
        select: { id: true, reference: true, name: true, amount: true, cost: true, probability: true, closeDate: true, stageChangedAt: true, stage: { select: { id: true, name: true, order: true, color: true, rotDays: true } } },
      }),
      prisma.target.findFirst({ where: { userId, year, quarter } }),
      prisma.target.findFirst({ where: { userId: null, year, quarter } }),
      prisma.deal.aggregate({ where: { deletedAt: null, status: 'WON', ownerId: userId, closedAt: { gte: start, lt: end } }, _sum: { amount: true }, _count: true }),
      prisma.activity.groupBy({ by: ['status'], where: { ownerId: userId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } }, _count: true }),
      prisma.deal.findMany({ where: { deletedAt: null, status: { in: ['WON', 'LOST'] }, ownerId: userId }, orderBy: { closedAt: 'desc' }, take: 8, select: { reference: true, name: true, status: true, amount: true, lostReason: true, closedAt: true } }),
      getSetting<number>('coaching.highValueAmount', 50000),
      getSetting<number>('approvals.dealMinMarginPct', 0),
    ]);

    // Pipeline by stage.
    const stageMap = new Map<string, { stage: { id: string; name: string; order: number; color: string }; count: number; net: number; weighted: number }>();
    for (const d of openDeals) {
      const g = stageMap.get(d.stage.id) ?? { stage: { id: d.stage.id, name: d.stage.name, order: d.stage.order, color: d.stage.color }, count: 0, net: 0, weighted: 0 };
      g.count += 1;
      g.net += num(d.amount);
      g.weighted += (num(d.amount) * d.probability) / 100;
      stageMap.set(d.stage.id, g);
    }
    const pipeline = [...stageMap.values()].sort((a, b) => a.stage.order - b.stage.order);

    // Escalation list.
    const now = Date.now();
    const hv = Number(highValue), mm = Number(minMargin);
    const escalations = openDeals.flatMap((d) => {
      const amount = num(d.amount);
      const stuckDays = Math.floor((now - d.stageChangedAt.getTime()) / 86_400_000);
      const stuck = d.stage.rotDays > 0 && stuckDays > d.stage.rotDays;
      const closePast = d.closeDate.getTime() < now;
      const marginPct = d.cost !== null && amount > 0 ? ((amount - num(d.cost)) / amount) * 100 : null;
      const belowMargin = mm > 0 && marginPct !== null && marginPct < mm;
      const reasons: string[] = [];
      if (stuck) reasons.push(`Stuck ${stuckDays}d in ${d.stage.name}`);
      if (closePast) reasons.push('Close date passed');
      if (belowMargin) reasons.push(`Margin ${marginPct!.toFixed(1)}% below ${mm}%`);
      if (amount >= hv && (stuck || closePast)) reasons.push('High value & slipping');
      return reasons.length ? [{ reference: d.reference, name: d.name, amount, stage: d.stage.name, closeDate: d.closeDate, reasons }] : [];
    }).sort((a, b) => b.amount - a.amount);

    const quotaTarget = num((target ?? companyTarget)?.amount ?? 0);
    const won = num(wonAgg._sum.amount);
    const weightedOpen = pipeline.reduce((s, p) => s + p.weighted, 0);

    return {
      rep,
      quota: {
        period: `Q${quarter} ${year}`,
        target: quotaTarget,
        won,
        wonCount: wonAgg._count,
        attainmentPct: quotaTarget > 0 ? Math.round((won / quotaTarget) * 1000) / 10 : null,
        weightedOpen,
        projectedPct: quotaTarget > 0 ? Math.round(((won + weightedOpen) / quotaTarget) * 1000) / 10 : null,
      },
      pipeline,
      openTotal: { count: openDeals.length, net: pipeline.reduce((s, p) => s + p.net, 0) },
      escalations,
      activity: {
        done: activities.find((a) => a.status === 'DONE')?._count ?? 0,
        open: activities.filter((a) => a.status !== 'DONE').reduce((s, a) => s + a._count, 0),
      },
      recentClosed: recentClosed.map((d) => ({ ...d, amount: num(d.amount) })),
    };
  });
}
