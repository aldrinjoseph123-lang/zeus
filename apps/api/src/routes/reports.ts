import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma, num } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, forbidden, listParams, notFound, requirePermission } from '../lib/http.js';
import { permissionFor, scopeWhere, teamMemberIds, type SessionUser } from '../auth/rbac.js';
import { tablePdf, type TableColumn } from '../services/pdf.js';
import { tableXlsx } from '../services/xlsx.js';
import { getSetting } from '../lib/settings.js';

/**
 * Report registry. Each entry declares its columns once; the JSON view, the Excel
 * export and the PDF export all read the same definition, so a new report is one
 * object rather than three code paths.
 */

interface ReportContext {
  user: SessionUser;
  filters: Record<string, string>;
  from: Date;
  to: Date;
  /** Scope clause already resolved for deals. */
  dealScope: Record<string, unknown>;
  /** The same, for the other modules reports are built on. */
  invoiceScope: Record<string, unknown>;
  quoteScope: Record<string, unknown>;
  /**
   * The deal scope as a SQL fragment against the alias `d`, for the reports that are
   * raw queries. Prisma.empty when the reader may see everything.
   */
  ownerSql: Prisma.Sql;
  /** The same for invoices, against the alias `i`. */
  invoiceSql: Prisma.Sql;
  /**
   * Whose records this reader may see, or null for everyone. The leaderboard filters
   * *people* rather than records, so it needs the list rather than a where clause.
   */
  visibleOwnerIds: string[] | null;
}

interface ReportResult {
  rows: Array<Record<string, unknown>>;
  summary?: Array<[string, string]>;
}

interface ReportDef {
  key: string;
  name: string;
  description: string;
  /** Which module permission gates it. */
  module: string;
  columns: TableColumn[];
  run: (ctx: ReportContext) => Promise<ReportResult>;
}

const aed = (v: number) => new Intl.NumberFormat('en-AE', { maximumFractionDigits: 0 }).format(v) + ' AED';

export const REPORTS: ReportDef[] = [
  {
    key: 'pipeline',
    name: 'Open pipeline',
    description: 'Every open deal with stage, value, weighted value and expected close date.',
    module: 'deals',
    columns: [
      { key: 'reference', label: 'Ref', width: 70 },
      { key: 'name', label: 'Deal' },
      { key: 'account', label: 'Customer' },
      { key: 'partner', label: 'Partner' },
      { key: 'stage', label: 'Stage', width: 90 },
      { key: 'type', label: 'Type', width: 60 },
      { key: 'source', label: 'Source', width: 80 },
      { key: 'amount', label: 'Net (AED)', width: 80, align: 'right', format: 'money' },
      { key: 'probability', label: 'Prob %', width: 50, align: 'right' },
      { key: 'weighted', label: 'Weighted', width: 80, align: 'right', format: 'money' },
      { key: 'closeDate', label: 'Close', width: 70, format: 'date' },
      { key: 'ageDays', label: 'Age (d)', width: 50, align: 'right' },
      { key: 'owner', label: 'Owner', width: 90 },
    ],
    run: async (ctx) => {
      const deals = await prisma.deal.findMany({
        where: {
          deletedAt: null, status: 'OPEN', ...ctx.dealScope,
          ...(ctx.filters.ownerId ? { ownerId: ctx.filters.ownerId } : {}),
          ...(ctx.filters.pipelineId ? { pipelineId: ctx.filters.pipelineId } : {}),
        },
        include: { account: true, partnerAccount: true, stage: true, owner: true },
        orderBy: { amount: 'desc' },
      });
      const rows = deals.map((d) => ({
        reference: d.reference,
        name: d.name,
        account: d.account.name,
        partner: d.partnerAccount?.name ?? '',
        stage: d.stage.name,
        type: d.type,
        source: d.source,
        amount: num(d.amount),
        probability: d.probability,
        weighted: (num(d.amount) * d.probability) / 100,
        closeDate: d.closeDate,
        ageDays: Math.floor((Date.now() - d.createdAt.getTime()) / 86_400_000),
        owner: d.owner?.name ?? 'Unassigned',
      }));
      const net = rows.reduce((s, r) => s + r.amount, 0);
      const weighted = rows.reduce((s, r) => s + r.weighted, 0);
      return {
        rows,
        summary: [
          ['Open deals', String(rows.length)],
          ['Pipeline value', aed(net)],
          ['Weighted forecast', aed(weighted)],
          ['Average deal', aed(rows.length ? net / rows.length : 0)],
        ],
      };
    },
  },
  {
    key: 'won-lost',
    name: 'Won & lost',
    description: 'Closed deals in the period with win/loss reason and cycle length.',
    module: 'deals',
    columns: [
      { key: 'reference', label: 'Ref', width: 70 },
      { key: 'name', label: 'Deal' },
      { key: 'account', label: 'Customer' },
      { key: 'status', label: 'Result', width: 55 },
      { key: 'amount', label: 'Net (AED)', width: 85, align: 'right', format: 'money' },
      { key: 'source', label: 'Source', width: 85 },
      { key: 'channel', label: 'Channel', width: 90 },
      { key: 'lostReason', label: 'Lost reason', width: 110 },
      { key: 'competitor', label: 'Competitor', width: 90 },
      { key: 'closedAt', label: 'Closed', width: 70, format: 'date' },
      { key: 'cycleDays', label: 'Cycle (d)', width: 55, align: 'right' },
      { key: 'owner', label: 'Owner', width: 90 },
    ],
    run: async (ctx) => {
      const deals = await prisma.deal.findMany({
        where: { deletedAt: null, status: { in: ['WON', 'LOST'] }, closedAt: { gte: ctx.from, lte: ctx.to }, ...ctx.dealScope },
        include: { account: true, owner: true },
        orderBy: { closedAt: 'desc' },
      });
      const rows = deals.map((d) => ({
        reference: d.reference,
        name: d.name,
        account: d.account.name,
        status: d.status,
        amount: num(d.amount),
        source: d.source,
        channel: d.partnerAccountId ? 'Partner-sourced' : 'Direct',
        lostReason: d.lostReason ?? '',
        competitor: d.competitor ?? '',
        closedAt: d.closedAt,
        cycleDays: d.closedAt ? Math.floor((d.closedAt.getTime() - d.createdAt.getTime()) / 86_400_000) : null,
        owner: d.owner?.name ?? 'Unassigned',
      }));
      const won = rows.filter((r) => r.status === 'WON');
      const lost = rows.filter((r) => r.status === 'LOST');
      return {
        rows,
        summary: [
          ['Won', `${won.length} · ${aed(won.reduce((s, r) => s + r.amount, 0))}`],
          ['Lost', `${lost.length} · ${aed(lost.reduce((s, r) => s + r.amount, 0))}`],
          ['Win rate', rows.length ? `${((won.length / rows.length) * 100).toFixed(1)}%` : '—'],
          ['Avg cycle', won.length ? `${Math.round(won.reduce((s, r) => s + (r.cycleDays ?? 0), 0) / won.length)} days` : '—'],
        ],
      };
    },
  },
  {
    key: 'forecast',
    name: 'Forecast by month',
    description: 'Committed (won), weighted pipeline and gross pipeline per expected close month.',
    module: 'deals',
    columns: [
      { key: 'month', label: 'Month', width: 90 },
      { key: 'openCount', label: 'Open deals', width: 70, align: 'right' },
      { key: 'openNet', label: 'Pipeline (AED)', width: 100, align: 'right', format: 'money' },
      { key: 'weighted', label: 'Weighted (AED)', width: 100, align: 'right', format: 'money' },
      { key: 'wonCount', label: 'Won deals', width: 70, align: 'right' },
      { key: 'won', label: 'Won (AED)', width: 100, align: 'right', format: 'money' },
    ],
    run: async (ctx) => {
      const rows = await prisma.$queryRaw<Array<{ month: Date; open_count: bigint; open_net: number; weighted: number; won_count: bigint; won: number }>>`
        SELECT date_trunc('month', COALESCE(d."closedAt", d."closeDate"))::date AS month,
               COUNT(*) FILTER (WHERE d.status = 'OPEN')::bigint AS open_count,
               COALESCE(SUM(CASE WHEN d.status = 'OPEN' THEN d.amount ELSE 0 END), 0)::float8 AS open_net,
               COALESCE(SUM(CASE WHEN d.status = 'OPEN' THEN d.amount * d.probability / 100 ELSE 0 END), 0)::float8 AS weighted,
               COUNT(*) FILTER (WHERE d.status = 'WON')::bigint AS won_count,
               COALESCE(SUM(CASE WHEN d.status = 'WON' THEN d.amount ELSE 0 END), 0)::float8 AS won
        FROM "Deal" d
        WHERE d."deletedAt" IS NULL AND COALESCE(d."closedAt", d."closeDate") BETWEEN ${ctx.from} AND ${ctx.to}
          ${ctx.ownerSql}
          ${ctx.filters.ownerId ? Prisma.sql`AND d."ownerId" = ${ctx.filters.ownerId}` : Prisma.empty}
        GROUP BY 1 ORDER BY 1
      `;
      const mapped = rows.map((r) => ({
        month: new Date(r.month).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
        openCount: Number(r.open_count),
        openNet: Number(r.open_net),
        weighted: Number(r.weighted),
        wonCount: Number(r.won_count),
        won: Number(r.won),
      }));
      return {
        rows: mapped,
        summary: [
          ['Total pipeline', aed(mapped.reduce((s, r) => s + r.openNet, 0))],
          ['Total weighted', aed(mapped.reduce((s, r) => s + r.weighted, 0))],
          ['Total won', aed(mapped.reduce((s, r) => s + r.won, 0))],
        ],
      };
    },
  },
  {
    key: 'source-performance',
    name: 'Lead source performance',
    description: 'Which sources actually convert — deal count, value, win rate.',
    module: 'reports',
    columns: [
      { key: 'source', label: 'Source', width: 130 },
      { key: 'deals', label: 'Deals', width: 60, align: 'right' },
      { key: 'net', label: 'Value (AED)', width: 100, align: 'right', format: 'money' },
      { key: 'wonCount', label: 'Won', width: 60, align: 'right' },
      { key: 'won', label: 'Won (AED)', width: 100, align: 'right', format: 'money' },
      { key: 'winRate', label: 'Win rate', width: 70, align: 'right', format: 'percent' },
      { key: 'avgDeal', label: 'Avg deal', width: 90, align: 'right', format: 'money' },
    ],
    run: async (ctx) => {
      const rows = await prisma.$queryRaw<Array<{ source: string; deals: bigint; net: number; won_count: bigint; won: number }>>`
        SELECT d.source,
               COUNT(*)::bigint AS deals,
               COALESCE(SUM(d.amount), 0)::float8 AS net,
               COUNT(*) FILTER (WHERE d.status = 'WON')::bigint AS won_count,
               COALESCE(SUM(CASE WHEN d.status = 'WON' THEN d.amount ELSE 0 END), 0)::float8 AS won
        FROM "Deal" d
        WHERE d."deletedAt" IS NULL AND d."createdAt" BETWEEN ${ctx.from} AND ${ctx.to}
          ${ctx.ownerSql}
        GROUP BY 1 ORDER BY net DESC
      `;
      return {
        rows: rows.map((r) => ({
          source: r.source,
          deals: Number(r.deals),
          net: Number(r.net),
          wonCount: Number(r.won_count),
          won: Number(r.won),
          winRate: Number(r.deals) ? (Number(r.won_count) / Number(r.deals)) * 100 : 0,
          avgDeal: Number(r.deals) ? Number(r.net) / Number(r.deals) : 0,
        })),
      };
    },
  },
  {
    key: 'partner-performance',
    name: 'Partner performance',
    description: 'Deals introduced by each partner and how much of it closed.',
    module: 'reports',
    columns: [
      { key: 'partner', label: 'Partner', width: 160 },
      { key: 'deals', label: 'Deals', width: 60, align: 'right' },
      { key: 'net', label: 'Value (AED)', width: 100, align: 'right', format: 'money' },
      { key: 'openNet', label: 'Open (AED)', width: 100, align: 'right', format: 'money' },
      { key: 'wonCount', label: 'Won', width: 60, align: 'right' },
      { key: 'won', label: 'Won (AED)', width: 100, align: 'right', format: 'money' },
      { key: 'winRate', label: 'Win rate', width: 70, align: 'right', format: 'percent' },
    ],
    run: async (ctx) => {
      const rows = await prisma.$queryRaw<Array<{ partner: string; deals: bigint; net: number; open_net: number; won_count: bigint; won: number }>>`
        SELECT a.name AS partner,
               COUNT(*)::bigint AS deals,
               COALESCE(SUM(d.amount), 0)::float8 AS net,
               COALESCE(SUM(CASE WHEN d.status = 'OPEN' THEN d.amount ELSE 0 END), 0)::float8 AS open_net,
               COUNT(*) FILTER (WHERE d.status = 'WON')::bigint AS won_count,
               COALESCE(SUM(CASE WHEN d.status = 'WON' THEN d.amount ELSE 0 END), 0)::float8 AS won
        FROM "Deal" d
        JOIN "Account" a ON a.id = d."partnerAccountId"
        WHERE d."deletedAt" IS NULL AND d."createdAt" BETWEEN ${ctx.from} AND ${ctx.to}
          ${ctx.ownerSql}
        GROUP BY 1 ORDER BY net DESC
      `;
      return {
        rows: rows.map((r) => ({
          partner: r.partner,
          deals: Number(r.deals),
          net: Number(r.net),
          openNet: Number(r.open_net),
          wonCount: Number(r.won_count),
          won: Number(r.won),
          winRate: Number(r.deals) ? (Number(r.won_count) / Number(r.deals)) * 100 : 0,
        })),
      };
    },
  },
  {
    key: 'rep-performance',
    name: 'Sales team performance',
    description: 'Per-rep pipeline, closed revenue and target attainment for the quarter.',
    module: 'reports',
    columns: [
      { key: 'owner', label: 'Owner', width: 130 },
      { key: 'team', label: 'Team', width: 90 },
      { key: 'openCount', label: 'Open', width: 55, align: 'right' },
      { key: 'openNet', label: 'Pipeline', width: 95, align: 'right', format: 'money' },
      { key: 'weighted', label: 'Weighted', width: 95, align: 'right', format: 'money' },
      { key: 'wonCount', label: 'Won', width: 55, align: 'right' },
      { key: 'wonNet', label: 'Won (AED)', width: 95, align: 'right', format: 'money' },
      { key: 'target', label: 'Target', width: 95, align: 'right', format: 'money' },
      { key: 'attainment', label: 'Attainment', width: 80, align: 'right', format: 'percent' },
    ],
    run: async (ctx) => {
      const now = new Date();
      const quarter = Math.floor(now.getMonth() / 3) + 1;
      const qStart = new Date(Date.UTC(now.getFullYear(), (quarter - 1) * 3, 1));
      const qEnd = new Date(Date.UTC(now.getFullYear(), quarter * 3, 1));

      // The leaderboard is a list of people, so the scope filters people rather than
      // records: a reader who may only see their own deals sees only their own line.
      const users = await prisma.user.findMany({
        where: { isActive: true, ...(ctx.visibleOwnerIds ? { id: { in: ctx.visibleOwnerIds } } : {}) },
        include: { team: true },
      });
      const [open, won, targets] = await Promise.all([
        prisma.deal.findMany({ where: { deletedAt: null, status: 'OPEN', ...ctx.dealScope }, select: { ownerId: true, amount: true, probability: true } }),
        prisma.deal.groupBy({ by: ['ownerId'], where: { deletedAt: null, status: 'WON', closedAt: { gte: qStart, lt: qEnd }, ...ctx.dealScope }, _sum: { amount: true }, _count: true }),
        prisma.target.findMany({
          where: {
            year: now.getFullYear(), quarter,
            userId: ctx.visibleOwnerIds ? { in: ctx.visibleOwnerIds } : { not: null },
          },
        }),
      ]);

      const rows = users.map((u) => {
        const mine = open.filter((d) => d.ownerId === u.id);
        const w = won.find((x) => x.ownerId === u.id);
        const target = num(targets.find((t) => t.userId === u.id)?.amount);
        const wonNet = num(w?._sum.amount);
        return {
          owner: u.name,
          team: u.team?.name ?? '',
          openCount: mine.length,
          openNet: mine.reduce((s, d) => s + num(d.amount), 0),
          weighted: mine.reduce((s, d) => s + (num(d.amount) * d.probability) / 100, 0),
          wonCount: w?._count ?? 0,
          wonNet,
          target,
          attainment: target ? (wonNet / target) * 100 : 0,
        };
      }).filter((r) => r.openCount || r.wonCount || r.target);

      return {
        rows: rows.sort((a, b) => b.wonNet - a.wonNet),
        summary: [
          ['Quarter', `Q${quarter} ${now.getFullYear()}`],
          ['Team pipeline', aed(rows.reduce((s, r) => s + r.openNet, 0))],
          ['Team won', aed(rows.reduce((s, r) => s + r.wonNet, 0))],
          ['Team target', aed(rows.reduce((s, r) => s + r.target, 0))],
        ],
      };
    },
  },
  {
    key: 'leads',
    name: 'Lead register',
    description: 'All leads with source, status, rating and estimated value.',
    module: 'leads',
    columns: [
      { key: 'company', label: 'Company' },
      { key: 'name', label: 'Contact' },
      { key: 'email', label: 'Email', width: 140 },
      { key: 'phone', label: 'Phone', width: 100 },
      { key: 'source', label: 'Source', width: 90 },
      { key: 'status', label: 'Status', width: 80 },
      { key: 'rating', label: 'Rating', width: 55 },
      { key: 'interestArea', label: 'Interest', width: 110 },
      { key: 'estimatedValue', label: 'Est. value', width: 85, align: 'right', format: 'money' },
      { key: 'createdAt', label: 'Created', width: 70, format: 'date' },
      { key: 'owner', label: 'Owner', width: 90 },
    ],
    run: async (ctx) => {
      const scope = await scopeWhere(ctx.user, 'leads', 'read');
      const leads = await prisma.lead.findMany({
        where: {
          deletedAt: null, ...scope, createdAt: { gte: ctx.from, lte: ctx.to },
          ...(ctx.filters.status ? { status: ctx.filters.status as never } : {}),
          ...(ctx.filters.source ? { source: ctx.filters.source } : {}),
        },
        include: { owner: true },
        orderBy: { createdAt: 'desc' },
      });
      return {
        rows: leads.map((l) => ({
          company: l.company,
          name: `${l.firstName} ${l.lastName}`,
          email: l.email ?? '',
          phone: l.phone ?? '',
          source: l.source,
          status: l.status,
          rating: l.rating ?? '',
          interestArea: l.interestArea ?? '',
          estimatedValue: num(l.estimatedValue),
          createdAt: l.createdAt,
          owner: l.owner?.name ?? 'Unassigned',
        })),
        summary: [
          ['Leads', String(leads.length)],
          ['Converted', String(leads.filter((l) => l.status === 'CONVERTED').length)],
          ['Estimated value', aed(leads.reduce((s, l) => s + num(l.estimatedValue), 0))],
        ],
      };
    },
  },
  {
    key: 'accounts',
    name: 'Account register',
    description: 'Customers, partners and vendors with deal counts and last activity.',
    module: 'accounts',
    columns: [
      { key: 'name', label: 'Account' },
      { key: 'type', label: 'Type', width: 70 },
      { key: 'domain', label: 'Domain', width: 120 },
      { key: 'industry', label: 'Industry', width: 100 },
      { key: 'emirate', label: 'Emirate', width: 80 },
      { key: 'trn', label: 'TRN', width: 100 },
      { key: 'contacts', label: 'Contacts', width: 60, align: 'right' },
      { key: 'deals', label: 'Deals', width: 55, align: 'right' },
      { key: 'openValue', label: 'Open (AED)', width: 95, align: 'right', format: 'money' },
      { key: 'wonValue', label: 'Won (AED)', width: 95, align: 'right', format: 'money' },
      { key: 'lastActivityAt', label: 'Last activity', width: 80, format: 'date' },
      { key: 'owner', label: 'Owner', width: 90 },
    ],
    run: async (ctx) => {
      const scope = await scopeWhere(ctx.user, 'accounts', 'read');
      const accounts = await prisma.account.findMany({
        where: { deletedAt: null, ...scope, ...(ctx.filters.type ? { type: ctx.filters.type as never } : {}) },
        include: { owner: true, _count: { select: { contacts: true, deals: true } }, deals: { where: { deletedAt: null }, select: { status: true, amount: true } } },
        orderBy: { name: 'asc' },
      });
      return {
        rows: accounts.map((a) => ({
          name: a.name,
          type: a.type,
          domain: a.domain ?? '',
          industry: a.industry ?? '',
          emirate: a.emirate ?? '',
          trn: a.trn ?? '',
          contacts: a._count.contacts,
          deals: a._count.deals,
          openValue: a.deals.filter((d) => d.status === 'OPEN').reduce((s, d) => s + num(d.amount), 0),
          wonValue: a.deals.filter((d) => d.status === 'WON').reduce((s, d) => s + num(d.amount), 0),
          lastActivityAt: a.lastActivityAt,
          owner: a.owner?.name ?? 'Unassigned',
        })),
        summary: [['Accounts', String(accounts.length)]],
      };
    },
  },
  {
    key: 'stale-accounts',
    name: 'Stale accounts',
    description: 'Accounts with no logged activity inside the threshold.',
    module: 'accounts',
    columns: [
      { key: 'name', label: 'Account' },
      { key: 'type', label: 'Type', width: 70 },
      { key: 'daysSince', label: 'Days quiet', width: 70, align: 'right' },
      { key: 'openDeals', label: 'Open deals', width: 70, align: 'right' },
      { key: 'openValue', label: 'At risk (AED)', width: 100, align: 'right', format: 'money' },
      { key: 'lastActivityAt', label: 'Last activity', width: 85, format: 'date' },
      { key: 'owner', label: 'Owner', width: 100 },
    ],
    run: async (ctx) => {
      const days = Number(ctx.filters.days ?? (await getSetting<number>('pipeline.staleAccountDays', 7)));
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const scope = await scopeWhere(ctx.user, 'accounts', 'read');
      const accounts = await prisma.account.findMany({
        where: {
          deletedAt: null, ...scope, type: { in: ['CUSTOMER', 'PROSPECT', 'PARTNER'] },
          OR: [{ lastActivityAt: null }, { lastActivityAt: { lt: cutoff } }],
        },
        include: { owner: true, deals: { where: { deletedAt: null, status: 'OPEN' }, select: { amount: true } } },
        orderBy: { lastActivityAt: 'asc' },
      });
      return {
        rows: accounts.map((a) => ({
          name: a.name,
          type: a.type,
          daysSince: a.lastActivityAt ? Math.floor((Date.now() - a.lastActivityAt.getTime()) / 86_400_000) : null,
          openDeals: a.deals.length,
          openValue: a.deals.reduce((s, d) => s + num(d.amount), 0),
          lastActivityAt: a.lastActivityAt,
          owner: a.owner?.name ?? 'Unassigned',
        })),
        summary: [
          ['Threshold', `${days} days`],
          ['Stale accounts', String(accounts.length)],
          ['Value at risk', aed(accounts.reduce((s, a) => s + a.deals.reduce((x, d) => x + num(d.amount), 0), 0))],
        ],
      };
    },
  },
  {
    key: 'activities',
    name: 'Activity log',
    description: 'Calls, meetings, emails and tasks in the period.',
    module: 'activities',
    columns: [
      { key: 'type', label: 'Type', width: 60 },
      { key: 'subject', label: 'Subject' },
      { key: 'related', label: 'Related to' },
      { key: 'status', label: 'Status', width: 70 },
      { key: 'priority', label: 'Priority', width: 60 },
      { key: 'dueAt', label: 'Due', width: 75, format: 'date' },
      { key: 'completedAt', label: 'Completed', width: 75, format: 'date' },
      { key: 'owner', label: 'Owner', width: 100 },
    ],
    run: async (ctx) => {
      const scope = await scopeWhere(ctx.user, 'activities', 'read');
      const activities = await prisma.activity.findMany({
        where: { ...scope, createdAt: { gte: ctx.from, lte: ctx.to }, ...(ctx.filters.type ? { type: ctx.filters.type as never } : {}) },
        include: { owner: true, account: true, deal: true, lead: true },
        orderBy: { createdAt: 'desc' },
        take: 5000,
      });
      return {
        rows: activities.map((a) => ({
          type: a.type,
          subject: a.subject,
          related: a.deal ? `${a.deal.reference} ${a.deal.name}` : a.account?.name ?? a.lead?.company ?? '',
          status: a.status,
          priority: a.priority,
          dueAt: a.dueAt,
          completedAt: a.completedAt,
          owner: a.owner?.name ?? '',
        })),
        summary: [
          ['Activities', String(activities.length)],
          ['Completed', String(activities.filter((a) => a.status === 'Completed').length)],
          ['Open', String(activities.filter((a) => a.status === 'Open').length)],
        ],
      };
    },
  },
  {
    key: 'quotes',
    name: 'Quotations',
    description: 'Quotes issued with value, VAT and margin.',
    module: 'quotes',
    columns: [
      { key: 'number', label: 'Number', width: 85 },
      { key: 'account', label: 'Customer' },
      { key: 'deal', label: 'Deal', width: 80 },
      { key: 'status', label: 'Status', width: 70 },
      { key: 'issueDate', label: 'Issued', width: 75, format: 'date' },
      { key: 'validUntil', label: 'Valid to', width: 75, format: 'date' },
      { key: 'subtotal', label: 'Net (AED)', width: 90, align: 'right', format: 'money' },
      { key: 'vatAmount', label: 'VAT', width: 80, align: 'right', format: 'money' },
      { key: 'total', label: 'Total', width: 90, align: 'right', format: 'money' },
      { key: 'marginAmount', label: 'Margin', width: 85, align: 'right', format: 'money' },
      { key: 'marginPct', label: 'Margin %', width: 70, align: 'right', format: 'percent' },
      { key: 'preparedBy', label: 'Prepared by', width: 100 },
    ],
    run: async (ctx) => {
      const quotes = await prisma.quote.findMany({
        where: {
          issueDate: { gte: ctx.from, lte: ctx.to },
          ...ctx.quoteScope,
          ...(ctx.filters.status ? { status: ctx.filters.status as never } : {}),
        },
        include: { account: true, deal: true, preparedBy: true },
        orderBy: { issueDate: 'desc' },
      });
      // Cost and margin are commercially sensitive — drop the columns for roles that cannot see them.
      const hidden = permissionFor(ctx.user, 'quotes').fields ?? {};
      const hideMargin = hidden.marginAmount === 'hidden' || hidden.totalCost === 'hidden';
      return {
        rows: quotes.map((q) => ({
          number: q.number,
          account: q.account.name,
          deal: q.deal?.reference ?? '',
          status: q.status,
          issueDate: q.issueDate,
          validUntil: q.validUntil,
          subtotal: num(q.subtotal) - num(q.discountAmt),
          vatAmount: num(q.vatAmount),
          total: num(q.total),
          marginAmount: hideMargin ? null : num(q.marginAmount),
          marginPct: hideMargin ? null : num(q.subtotal) ? (num(q.marginAmount) / (num(q.subtotal) - num(q.discountAmt))) * 100 : 0,
          preparedBy: q.preparedBy?.name ?? '',
        })),
        summary: [
          ['Quotes', String(quotes.length)],
          ['Total quoted', aed(quotes.reduce((s, q) => s + num(q.total), 0))],
          ['Accepted', String(quotes.filter((q) => q.status === 'ACCEPTED').length)],
        ],
      };
    },
  },
  {
    key: 'vat-summary',
    name: 'VAT summary',
    description: 'Output VAT by month from issued invoices — the figures your FTA return needs.',
    module: 'invoices',
    columns: [
      { key: 'month', label: 'Month', width: 100 },
      { key: 'invoices', label: 'Invoices', width: 70, align: 'right' },
      { key: 'net', label: 'Net (AED)', width: 110, align: 'right', format: 'money' },
      { key: 'vat', label: 'Output VAT', width: 110, align: 'right', format: 'money' },
      { key: 'gross', label: 'Gross', width: 110, align: 'right', format: 'money' },
    ],
    run: async (ctx) => {
      const rows = await prisma.$queryRaw<Array<{ month: Date; invoices: bigint; net: number; vat: number; gross: number }>>`
        SELECT date_trunc('month', i."issueDate")::date AS month,
               COUNT(*)::bigint AS invoices,
               COALESCE(SUM(i.subtotal), 0)::float8 AS net,
               COALESCE(SUM(i."vatAmount"), 0)::float8 AS vat,
               COALESCE(SUM(i.total), 0)::float8 AS gross
        FROM "Invoice" i
        WHERE i.status NOT IN ('DRAFT', 'CANCELLED') AND i."issueDate" BETWEEN ${ctx.from} AND ${ctx.to}
          ${ctx.invoiceSql}
        GROUP BY 1 ORDER BY 1
      `;
      const mapped = rows.map((r) => ({
        month: new Date(r.month).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        invoices: Number(r.invoices),
        net: Number(r.net),
        vat: Number(r.vat),
        gross: Number(r.gross),
      }));
      return {
        rows: mapped,
        summary: [
          ['Net sales', aed(mapped.reduce((s, r) => s + r.net, 0))],
          ['Output VAT', aed(mapped.reduce((s, r) => s + r.vat, 0))],
          ['Gross', aed(mapped.reduce((s, r) => s + r.gross, 0))],
        ],
      };
    },
  },
  {
    key: 'receivables',
    name: 'Receivables ageing',
    description: 'Unpaid invoices bucketed by how overdue they are.',
    module: 'invoices',
    columns: [
      { key: 'number', label: 'Invoice', width: 90 },
      { key: 'account', label: 'Customer' },
      { key: 'issueDate', label: 'Issued', width: 75, format: 'date' },
      { key: 'dueDate', label: 'Due', width: 75, format: 'date' },
      { key: 'bucket', label: 'Ageing', width: 80 },
      { key: 'total', label: 'Total (AED)', width: 95, align: 'right', format: 'money' },
      { key: 'amountPaid', label: 'Paid', width: 90, align: 'right', format: 'money' },
      { key: 'outstanding', label: 'Outstanding', width: 100, align: 'right', format: 'money' },
    ],
    run: async (ctx) => {
      const invoices = await prisma.invoice.findMany({
        where: { status: { in: ['SENT', 'PARTIAL', 'OVERDUE'] }, ...ctx.invoiceScope },
        include: { account: true },
        orderBy: { dueDate: 'asc' },
      });
      const bucketFor = (due: Date | null): string => {
        if (!due) return 'No due date';
        const days = Math.floor((Date.now() - due.getTime()) / 86_400_000);
        if (days < 0) return 'Not due';
        if (days <= 30) return '1-30 days';
        if (days <= 60) return '31-60 days';
        if (days <= 90) return '61-90 days';
        return '90+ days';
      };
      const rows = invoices.map((i) => ({
        number: i.number,
        account: i.account.name,
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        bucket: bucketFor(i.dueDate),
        total: num(i.total),
        amountPaid: num(i.amountPaid),
        outstanding: num(i.total) - num(i.amountPaid),
      }));
      return {
        rows,
        summary: [
          ['Open invoices', String(rows.length)],
          ['Outstanding', aed(rows.reduce((s, r) => s + r.outstanding, 0))],
          ['Overdue', aed(rows.filter((r) => r.bucket !== 'Not due' && r.bucket !== 'No due date').reduce((s, r) => s + r.outstanding, 0))],
        ],
      };
    },
  },
  {
    key: 'registrations',
    name: 'Deal registrations',
    description: 'Vendor and partner registrations with approval status and expiry.',
    module: 'deals',
    columns: [
      { key: 'side', label: 'Side', width: 60 },
      { key: 'vendor', label: 'Registered with', width: 120 },
      { key: 'deal', label: 'Deal' },
      { key: 'account', label: 'Customer' },
      { key: 'regNumber', label: 'Reg number', width: 100 },
      { key: 'status', label: 'Status', width: 80 },
      { key: 'approvedDiscount', label: 'Discount %', width: 75, align: 'right' },
      { key: 'submittedAt', label: 'Submitted', width: 80, format: 'date' },
      { key: 'expiresAt', label: 'Expires', width: 80, format: 'date' },
      { key: 'daysLeft', label: 'Days left', width: 65, align: 'right' },
      { key: 'amount', label: 'Deal value', width: 95, align: 'right', format: 'money' },
    ],
    run: async (ctx) => {
      const registrations = await prisma.dealRegistration.findMany({
        // A registration has no owner of its own; it belongs to whoever owns the deal.
        where: { deal: ctx.dealScope },
        include: { vendor: true, partner: true, deal: { include: { account: true } } },
        orderBy: { expiresAt: 'asc' },
      });
      return {
        rows: registrations.map((r) => ({
          side: r.side === 'PARTNER' ? 'Partner' : 'Vendor',
          vendor: r.vendor?.name ?? r.partner?.name ?? '—',
          deal: `${r.deal.reference} ${r.deal.name}`,
          account: r.deal.account.name,
          regNumber: r.regNumber ?? '',
          status: r.status,
          approvedDiscount: r.approvedDiscount ? num(r.approvedDiscount) : null,
          submittedAt: r.submittedAt,
          expiresAt: r.expiresAt,
          daysLeft: r.expiresAt ? Math.ceil((r.expiresAt.getTime() - Date.now()) / 86_400_000) : null,
          amount: num(r.deal.amount),
        })),
        summary: [
          ['Registrations', String(registrations.length)],
          ['Approved', String(registrations.filter((r) => r.status === 'APPROVED').length)],
          ['Expiring in 30d', String(registrations.filter((r) => r.expiresAt && r.expiresAt.getTime() - Date.now() < 30 * 86_400_000 && r.expiresAt.getTime() > Date.now()).length)],
        ],
      };
    },
  },
  {
    key: 'renewals',
    name: 'Renewals pipeline',
    description: 'What is under cover, when it expires, and whether anyone is working it.',
    module: 'deals',
    columns: [
      { key: 'reference', label: 'Ref', width: 95 },
      { key: 'account', label: 'Customer' },
      { key: 'description', label: 'Entitlement' },
      { key: 'vendor', label: 'Vendor', width: 100 },
      { key: 'quantity', label: 'Qty', width: 55, align: 'right' },
      { key: 'endDate', label: 'Expires', width: 85, format: 'date' },
      { key: 'daysLeft', label: 'Days', width: 55, align: 'right' },
      { key: 'termValue', label: 'Term value', width: 100, align: 'right', format: 'money' },
      { key: 'status', label: 'Status', width: 80 },
      { key: 'renewal', label: 'Renewal deal', width: 110 },
      { key: 'owner', label: 'Owner', width: 110 },
    ],
    run: async (ctx) => {
      const subs = await prisma.subscription.findMany({
        where: {
          deletedAt: null, status: { not: 'CANCELLED' },
          ...(ctx.visibleOwnerIds ? { ownerId: { in: ctx.visibleOwnerIds } } : {}),
        },
        include: { account: true, vendor: true, owner: true, renewalDeal: { select: { reference: true, status: true } } },
        orderBy: { endDate: 'asc' },
      });
      const live = subs.filter((s) => s.status === 'ACTIVE' || s.status === 'EXPIRING');
      const soon = live.filter((s) => {
        const left = s.endDate.getTime() - Date.now();
        return left > 0 && left < 90 * 86_400_000;
      });
      return {
        rows: subs.map((s) => ({
          reference: s.reference,
          account: s.account.name,
          description: s.description,
          vendor: s.vendor?.name ?? '',
          quantity: num(s.quantity),
          endDate: s.endDate,
          daysLeft: Math.ceil((s.endDate.getTime() - Date.now()) / 86_400_000),
          termValue: num(s.termValue),
          status: s.status,
          renewal: s.renewalDeal ? `${s.renewalDeal.reference} (${s.renewalDeal.status})` : 'not opened',
          owner: s.owner?.name ?? '',
        })),
        summary: [
          ['Under cover', String(live.length)],
          ['Annual value', aed(live.reduce((sum, s) => sum + num(s.termValue), 0))],
          ['Expiring in 90d', aed(soon.reduce((sum, s) => sum + num(s.termValue), 0))],
          ['Unworked', String(soon.filter((s) => !s.renewalDealId).length)],
        ],
      };
    },
  },
  {
    key: 'price-book',
    name: 'Vendor price book',
    description: 'Buy prices by SKU and vendor, with quantity breaks and what is about to expire.',
    module: 'products',
    columns: [
      { key: 'sku', label: 'SKU', width: 110 },
      { key: 'product', label: 'Item' },
      { key: 'vendor', label: 'Vendor', width: 110 },
      { key: 'vendorSku', label: 'Their part no.', width: 110 },
      { key: 'minQuantity', label: 'From qty', width: 60, align: 'right' },
      { key: 'cost', label: 'Buy price', width: 95, align: 'right', format: 'money' },
      { key: 'listPrice', label: 'Their list', width: 95, align: 'right', format: 'money' },
      { key: 'discountPct', label: 'Off list %', width: 70, align: 'right' },
      { key: 'scope', label: 'Applies to', width: 120 },
      { key: 'validTo', label: 'Valid to', width: 80, format: 'date' },
    ],
    run: async () => {
      const entries = await prisma.priceEntry.findMany({
        where: { isActive: true },
        include: { product: true, vendor: true, deal: { select: { reference: true } } },
        orderBy: [{ product: { sku: 'asc' } }, { minQuantity: 'asc' }],
      });
      const expiring = entries.filter((e) => {
        if (!e.validTo) return false;
        const left = e.validTo.getTime() - Date.now();
        return left > 0 && left < 30 * 86_400_000;
      });
      const expired = entries.filter((e) => e.validTo && e.validTo.getTime() < Date.now());
      return {
        rows: entries.map((e) => {
          const list = e.listPrice === null ? null : num(e.listPrice);
          return {
            sku: e.product.sku,
            product: e.product.name,
            vendor: e.vendor?.name ?? '',
            vendorSku: e.vendorSku ?? '',
            minQuantity: num(e.minQuantity),
            cost: num(e.cost),
            listPrice: list,
            discountPct: list && list > 0 ? Number((((list - num(e.cost)) / list) * 100).toFixed(1)) : null,
            scope: e.deal ? `Special · ${e.deal.reference}` : 'All deals',
            validTo: e.validTo,
          };
        }),
        summary: [
          ['Prices on file', String(entries.length)],
          ['SKUs covered', String(new Set(entries.map((e) => e.productId)).size)],
          ['Expiring in 30d', String(expiring.length)],
          ['Already expired', String(expired.length)],
        ],
      };
    },
  },
];

async function buildContext(request: FastifyRequest): Promise<ReportContext> {
  const params = listParams(request.query as Record<string, unknown>);
  const f = params.filters;

  /**
   * A report is another way to ask a question the screens already answer, so it has to
   * answer it for the same audience. Every scope is resolved once here rather than
   * per report, because several reports query more than one module.
   */
  const [dealScope, quoteScope] = await Promise.all([
    scopeWhere(request.user, 'deals', 'read'),
    scopeWhere(request.user, 'quotes', 'read'),
  ]);

  const dealRead = permissionFor(request.user, 'deals').read;
  const visibleOwnerIds =
    dealRead === 'all' ? null
      : dealRead === 'own' ? [request.user.id]
      : dealRead === 'team' ? await teamMemberIds(request.user)
      : [];

  /**
   * An invoice has no owner column — it belongs to whoever owns the deal behind it, and
   * failing that to whoever raised it. `scopeWhere` cannot express that, and asking it to
   * would produce a `where: { ownerId }` Prisma rejects on this model.
   */
  const invoiceRead = permissionFor(request.user, 'invoices').read;
  const invoiceOwners =
    invoiceRead === 'all' ? null
      : invoiceRead === 'own' ? [request.user.id]
      : invoiceRead === 'team' ? await teamMemberIds(request.user)
      : [];
  const invoiceScope: Record<string, unknown> =
    invoiceOwners === null ? {}
      : invoiceOwners.length === 0 ? { id: '__no_access__' }
      : { OR: [{ deal: { ownerId: { in: invoiceOwners } } }, { createdById: { in: invoiceOwners } }] };

  return {
    user: request.user,
    filters: f,
    from: f.from ? new Date(f.from) : new Date(Date.now() - 365 * 86_400_000),
    to: f.to ? new Date(f.to) : new Date(Date.now() + 365 * 86_400_000),
    dealScope,
    invoiceScope,
    quoteScope,
    // `AND FALSE` rather than an empty IN (), which Postgres will not parse.
    ownerSql:
      visibleOwnerIds === null ? Prisma.empty
        : visibleOwnerIds.length === 0 ? Prisma.sql`AND FALSE`
        : Prisma.sql`AND d."ownerId" IN (${Prisma.join(visibleOwnerIds)})`,
    invoiceSql:
      invoiceOwners === null ? Prisma.empty
        : invoiceOwners.length === 0 ? Prisma.sql`AND FALSE`
        : Prisma.sql`AND (
            i."createdById" IN (${Prisma.join(invoiceOwners)})
            OR EXISTS (SELECT 1 FROM "Deal" dd WHERE dd.id = i."dealId" AND dd."ownerId" IN (${Prisma.join(invoiceOwners)}))
          )`,
    visibleOwnerIds,
  };
}

export default async function reportRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Some reports exist only to show a field the role may not see. Module permission is
   * not enough for those: a Sales Executive may read `products`, but `cost` is masked on
   * it — and the price book *screen* returns 403 for exactly that reason. Without this,
   * the report handed them every vendor buy price the screen had just refused.
   */
  const REQUIRED_FIELD: Record<string, { module: string; field: string; what: string }> = {
    'price-book': { module: 'products', field: 'cost', what: 'buy prices' },
  };

  app.get('/api/reports', { preHandler: requirePermission('reports', 'read') }, async (request) =>
    REPORTS
      .filter((r) => {
        const gate = REQUIRED_FIELD[r.key];
        return !gate || (permissionFor(request.user, gate.module).fields ?? {})[gate.field] !== 'hidden';
      })
      .map(({ key, name, description, module, columns }) => ({ key, name, description, module, columns })),
  );

  app.get('/api/reports/:key', { preHandler: requirePermission('reports', 'read') }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const format = String((request.query as Record<string, string>).format ?? 'json').toLowerCase();

    const def = REPORTS.find((r) => r.key === key);
    if (!def) throw notFound(`No report named "${key}".`);

    const gate = REQUIRED_FIELD[def.key];
    if (gate && (permissionFor(request.user, gate.module).fields ?? {})[gate.field] === 'hidden') {
      throw forbidden(`Your role cannot see ${gate.what}, so this report is not available to it.`);
    }

    const perm = permissionFor(request.user, def.module);
    if (perm.read === 'none') throw badRequest(`Your role cannot see ${def.module}.`);
    if (format !== 'json' && !perm.export) throw badRequest(`Your role cannot export ${def.module}.`);

    const ctx = await buildContext(request);
    const result = await def.run(ctx);

    if (format === 'json') return { key: def.key, name: def.name, columns: def.columns, ...result };

    const subtitle = `${def.name} · ${ctx.from.toLocaleDateString('en-GB')} – ${ctx.to.toLocaleDateString('en-GB')} · generated ${new Date().toLocaleString('en-GB')}`;
    const stamp = new Date().toISOString().slice(0, 10);

    await audit({ user: request.user, action: 'export', entity: 'Report', entityId: def.key, summary: `${def.name} as ${format}`, ip: clientIp(request) });

    if (format === 'xlsx') {
      const buffer = await tableXlsx({ title: def.name, columns: def.columns, rows: result.rows, summary: result.summary });
      return reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="zeus-${def.key}-${stamp}.xlsx"`)
        .send(buffer);
    }

    if (format === 'pdf') {
      const buffer = await tablePdf({ title: def.name, subtitle, columns: def.columns, rows: result.rows, summary: result.summary });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="zeus-${def.key}-${stamp}.pdf"`)
        .send(buffer);
    }

    throw badRequest('Format must be json, xlsx or pdf.');
  });
}
