import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock, BadgeCheck, Building2, CalendarClock, CircleDollarSign, Clock, Flame, Layers,
  ShieldCheck, TrendingUp, Users,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, daysBetween, money, moneyShort, number, percent, quarterOf, relative } from '../lib/format';
import { AgeingChart, ForecastChart, FunnelChart, RankedBars, SplitDonut } from '../components/charts';
import {
  Avatar, Badge, Button, Card, CardHeader, DataTable, EmptyState, Loading, PageHeader,
  ProgressBar, Select, StatTile, Tabs,
} from '../components/ui';

interface Overview {
  period: { from: string; to: string; quarter: string };
  kpis: {
    openPipelineNet: number; openDealCount: number; weightedForecast: number;
    wonQuarterNet: number; wonQuarterCount: number; lostQuarterNet: number; lostQuarterCount: number;
    winRate: number; avgDealSize: number; avgCycleDays: number | null;
    newLeadsThisQuarter: number; openLeads: number; staleAccounts: number; overdueTasks: number;
    overdueDeals: number; overdueDealValue: number;
  };
  target: { amount: number; achieved: number; attainment: number | null; gap: number; weightedCoverage: number | null };
  funnel: Array<{ stageId: string; name: string; count: number; value: number; weighted: number; color: string; probability: number }>;
  monthly: Array<{ month: string; won: number; lost: number; openWeighted: number; openNet: number }>;
  bySource: Array<{ source: string; deals: number; net: number; won: number; wonCount: number; winRate: number }>;
  byChannel: Array<{ channel: string; deals: number; net: number; won: number }>;
  byType: Array<{ type: string; count: number; net: number }>;
  leaderboard: Array<{ id: string; name: string; avatarColor: string; team: string | null; openCount: number; openNet: number; weighted: number; wonCount: number; wonNet: number; target: number; attainment: number | null }>;
  ageing: Array<{ label: string; count: number; value: number }>;
  topDeals: Array<{ id: string; reference: string; name: string; amount: number; probability: number; closeDate: string; account: { name: string }; stage: { name: string; color: string }; owner: { name: string } | null }>;
}

interface Attention {
  thresholds: { staleAccountDays: number; staleDealDays: number; registrationWarnDays: number };
  staleAccounts: Array<{ id: string; name: string; type: string; lastActivityAt: string | null; owner: { name: string } | null; _count: { deals: number } }>;
  stuckDeals: Array<{ id: string; reference: string; name: string; amount: number; stageChangedAt: string; closeDate: string; stage: { name: string; color: string }; account: { name: string }; owner: { name: string } | null }>;
  expiringRegistrations: Array<{
    id: string; side: 'VENDOR' | 'PARTNER'; expiresAt: string; regNumber: string | null;
    vendor: { name: string } | null; partner: { name: string } | null;
    deal: { id: string; reference: string; name: string; account: { name: string } };
  }>;
  overdueTasks: Array<{ id: string; subject: string; dueAt: string; priority: string; owner: { name: string } | null; deal: { id: string; reference: string } | null; account: { id: string; name: string } | null }>;
  overdueInvoices: Array<{ id: string; number: string; total: number; amountPaid: number; dueDate: string; account: { id: string; name: string } }>;
}

const PERIODS = [
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 6 months' },
  { value: '365', label: 'Last 12 months' },
  { value: '730', label: 'Last 24 months' },
];

export default function Dashboard() {
  const { user, can, sees } = useAuth();
  const [period, setPeriod] = useState('365');
  const [ownerId, setOwnerId] = useState('');
  const [attentionTab, setAttentionTab] = useState('stale');

  const from = new Date(Date.now() - Number(period) * 86_400_000).toISOString();
  const to = new Date(Date.now() + 365 * 86_400_000).toISOString();

  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard', period, ownerId],
    queryFn: () => api.get<Overview>(`/dashboard/overview${qs({ from, to, ownerId })}`),
  });

  const { data: attention } = useQuery({
    queryKey: ['dashboard-attention'],
    queryFn: () => api.get<Attention>('/dashboard/attention'),
  });

  // Sitting on this user's desk. Managers see a queue; a rep sees an empty one.
  const { data: approvals } = useQuery({
    queryKey: ['pending-approvals'],
    queryFn: () => api.get<Array<{
      entity: 'deals' | 'purchase-orders' | 'invoices'; id: string; reference: string; title: string;
      account: string; value: number; requestedAt: string | null; requestedBy: string | null;
      marginPct?: number; marginBelowFloor?: boolean;
    }>>('/approvals/pending'),
    enabled: can('deals', 'approve') || can('invoices', 'approve'),
  });

  const { data: owners } = useQuery({
    queryKey: ['users-lookup'],
    queryFn: () => api.get<Array<{ id: string; name: string }>>('/users/lookup'),
  });

  if (isLoading) return <Loading label="Building your dashboard" />;
  if (error || !data) return <EmptyState title="Dashboard unavailable" message={(error as Error)?.message} />;

  const k = data.kpis;
  const quarter = quarterOf();
  const attainment = data.target.attainment ?? 0;
  const coverage = data.target.weightedCoverage ?? 0;

  const attentionTabs = [
    ...(approvals?.length ? [{ key: 'approvals', label: 'Waiting on you', count: approvals.length }] : []),
    { key: 'stale', label: 'Stale accounts', count: attention?.staleAccounts.length },
    { key: 'stuck', label: 'Stuck deals', count: attention?.stuckDeals.length },
    { key: 'registrations', label: 'Registrations', count: attention?.expiringRegistrations.length },
    { key: 'tasks', label: 'Overdue tasks', count: attention?.overdueTasks.length },
    { key: 'invoices', label: 'Overdue invoices', count: attention?.overdueInvoices.length },
  ];

  return (
    <>
      <PageHeader
        title="Command centre"
        description={`${user?.name?.split(' ')[0] ?? 'Welcome'} — ${quarter.label} performance, live from the pipeline.`}
        actions={
          <>
            <Select
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              options={PERIODS}
              className="w-[150px]"
              aria-label="Reporting period"
            />
            {can('reports', 'read') && owners ? (
              <Select
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                placeholder="Whole team"
                options={owners.map((o) => ({ value: o.id, label: o.name }))}
                className="w-[170px]"
                aria-label="Filter by owner"
              />
            ) : null}
          </>
        }
      />

      {/* ── headline numbers ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <StatTile label="Open pipeline" value={moneyShort(k.openPipelineNet)} sub={`${k.openDealCount} open deal${k.openDealCount === 1 ? '' : 's'}`} icon={<Layers size={15} />} />
        <StatTile label="Weighted forecast" value={moneyShort(k.weightedForecast)} sub="Probability-adjusted" tone="accent" icon={<TrendingUp size={15} />} />
        <StatTile label={`Won ${quarter.label}`} value={moneyShort(k.wonQuarterNet)} sub={`${k.wonQuarterCount} deal${k.wonQuarterCount === 1 ? '' : 's'} closed`} tone="secure" icon={<BadgeCheck size={15} />} />
        <StatTile label="Win rate" value={percent(k.winRate, 1)} sub={`${k.wonQuarterCount} won · ${k.lostQuarterCount} lost`} icon={<CircleDollarSign size={15} />} />
        <StatTile label="Average deal" value={moneyShort(k.avgDealSize)} sub={k.avgCycleDays ? `${Math.round(k.avgCycleDays)} day cycle` : 'No closed deals yet'} icon={<Clock size={15} />} />
        <StatTile
          label="Needs attention"
          value={number(k.staleAccounts + k.overdueTasks + k.overdueDeals)}
          sub={`${k.staleAccounts} stale · ${k.overdueTasks} tasks · ${k.overdueDeals} past close`}
          tone="watch"
          icon={<Flame size={15} />}
        />
      </div>

      {/* ── target ───────────────────────────────────────────────────────── */}
      <Card className="mt-3">
        <div className="grid gap-5 px-4 py-4 lg:grid-cols-[1.4fr_1fr]">
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="eyebrow">{quarter.label} target attainment</span>
              {data.target.amount > 0 ? (
                <span className="tabular text-[13px] text-muted">
                  <span className="text-[17px] font-bold text-ink">{money(data.target.achieved)}</span> of {money(data.target.amount)}
                </span>
              ) : null}
            </div>

            {data.target.amount > 0 ? (
              <>
                <div className="mt-3 space-y-2">
                  <div>
                    <div className="mb-1 flex justify-between text-[11px]">
                      <span className="text-muted">Closed won</span>
                      <span className="tabular font-semibold">{percent(attainment)}</span>
                    </div>
                    <ProgressBar value={attainment} tone={attainment >= 100 ? 'secure' : 'accent'} height={10} />
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-[11px]">
                      <span className="text-muted">Won + weighted pipeline</span>
                      <span className="tabular font-semibold">{percent(coverage)}</span>
                    </div>
                    <ProgressBar value={coverage} tone={coverage >= 100 ? 'secure' : coverage >= 70 ? 'watch' : 'accent'} height={6} />
                  </div>
                </div>
                <p className="mt-3 text-[12px] text-muted">
                  {data.target.gap > 0
                    ? <>Gap to target: <strong className="text-ink">{money(data.target.gap)}</strong>. Weighted pipeline covers {percent(coverage)} of the quarter.</>
                    : <>Target met for {quarter.label}. Everything beyond this is upside.</>}
                </p>
              </>
            ) : (
              <EmptyState
                title="No target set"
                message={`Set a ${quarter.label} target to track attainment on this dashboard.`}
                action={can('settings', 'update') ? <Link to="/settings/targets"><Button variant="accent" size="sm">Set targets</Button></Link> : undefined}
              />
            )}
          </div>

          <div className="border-t border-line pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <span className="eyebrow">Pipeline by expected close</span>
            <div className="mt-1">
              <ForecastChart data={data.monthly.map((m) => ({ ...m, month: new Date(m.month).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }) }))} />
            </div>
          </div>
        </div>
      </Card>

      {/* ── funnel + splits ──────────────────────────────────────────────── */}
      <div className="mt-3 grid gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Pipeline funnel"
            subtitle="Open deals by stage, with default win probability"
            actions={<Link to="/deals"><Button size="sm" variant="ghost">Open board</Button></Link>}
          />
          <FunnelChart data={data.funnel} />
        </Card>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Direct vs partner" subtitle="Total deal value by channel" />
            <div className="px-4 py-3">
              <SplitDonut data={data.byChannel.map((c) => ({ name: c.channel, value: c.net }))} height={150} />
            </div>
          </Card>
          <Card>
            <CardHeader title="Product vs service" subtitle="Reselling against managed services" />
            <div className="px-4 py-3">
              <SplitDonut data={data.byType.map((t) => ({ name: t.type === 'PRODUCT' ? 'Reselling' : t.type === 'SERVICE' ? 'Managed service' : 'Mixed', value: t.net }))} height={150} />
            </div>
          </Card>
        </div>
      </div>

      {/* ── source + ageing ──────────────────────────────────────────────── */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader title="Where deals come from" subtitle="Total value by source, with win rate" />
          <div className="px-2 py-3">
            <RankedBars data={data.bySource.slice(0, 8).map((s) => ({ name: s.source, value: s.net }))} height={230} />
          </div>
          <div className="border-t border-line px-4 py-2.5">
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {data.bySource.slice(0, 5).map((s) => (
                <span key={s.source} className="text-[11px] text-muted">
                  {s.source} <strong className="tabular text-ink">{percent(s.winRate)}</strong> win
                </span>
              ))}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader title="Deal ageing" subtitle="Open value by how long the deal has existed" />
          <div className="px-2 py-3">
            <AgeingChart data={data.ageing} />
          </div>
          {k.overdueDeals > 0 ? (
            <div className="border-t border-line bg-accent-soft px-4 py-2.5 text-[12px] text-[var(--red-700)]">
              <strong>{k.overdueDeals}</strong> open deal{k.overdueDeals === 1 ? '' : 's'} worth <strong>{money(k.overdueDealValue)}</strong> are past their close date.
            </div>
          ) : null}
        </Card>
      </div>

      {/* ── leaderboard ──────────────────────────────────────────────────── */}
      {can('reports', 'read') && data.leaderboard.length > 0 ? (
        <Card className="mt-3">
          <CardHeader title="Team performance" subtitle={`${quarter.label} closed revenue and attainment`} actions={<Link to="/reports"><Button size="sm" variant="ghost">All reports</Button></Link>} />
          <DataTable
            rows={data.leaderboard}
            rowKey={(row) => row.id}
            columns={[
              {
                key: 'name',
                header: 'Owner',
                render: (row) => (
                  <span className="flex items-center gap-2">
                    <Avatar name={row.name} color={row.avatarColor} size={24} />
                    <span>
                      <span className="block font-semibold">{row.name}</span>
                      {row.team ? <span className="block text-[11px] text-muted">{row.team}</span> : null}
                    </span>
                  </span>
                ),
              },
              { key: 'openCount', header: 'Open', align: 'right', render: (row) => <span className="tabular">{row.openCount}</span> },
              { key: 'openNet', header: 'Pipeline', align: 'right', render: (row) => <span className="tabular">{moneyShort(row.openNet)}</span> },
              { key: 'weighted', header: 'Weighted', align: 'right', render: (row) => <span className="tabular text-muted">{moneyShort(row.weighted)}</span> },
              { key: 'wonNet', header: `Won ${quarter.label}`, align: 'right', render: (row) => <span className="tabular font-semibold">{moneyShort(row.wonNet)}</span> },
              {
                key: 'attainment',
                header: 'Attainment',
                width: '190px',
                render: (row) =>
                  row.target > 0 ? (
                    <div className="flex items-center gap-2">
                      <div className="w-24"><ProgressBar value={row.attainment ?? 0} tone={(row.attainment ?? 0) >= 100 ? 'secure' : 'accent'} /></div>
                      <span className="tabular text-[11px] font-semibold">{percent(row.attainment ?? 0)}</span>
                      <span className="text-[10px] text-n400">of {moneyShort(row.target)}</span>
                    </div>
                  ) : (
                    <span className="text-[11px] text-n400">No target</span>
                  ),
              },
            ]}
          />
        </Card>
      ) : null}

      {/* ── attention + top deals ────────────────────────────────────────── */}
      <div className="mt-3 grid gap-3 xl:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader title="Needs attention" subtitle={attention ? `Stale after ${attention.thresholds.staleAccountDays} days · stuck after ${attention.thresholds.staleDealDays} days` : undefined} />
          <Tabs tabs={attentionTabs} active={attentionTab} onChange={setAttentionTab} />
          <div className="max-h-[340px] overflow-y-auto">
            {!attention ? (
              <Loading label="Checking" />
            ) : attentionTab === 'stale' ? (
              attention.staleAccounts.length === 0 ? (
                <EmptyState title="Every account is warm" message="No account has gone quiet past the threshold." icon={<Building2 size={22} />} />
              ) : (
                attention.staleAccounts.map((a) => (
                  <Link key={a.id} to={`/accounts/${a.id}`} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 transition-colors hover:bg-sunken">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{a.name}</span>
                      <span className="block text-[11px] text-muted">{a.type} · {a._count.deals} deal{a._count.deals === 1 ? '' : 's'} · {a.owner?.name ?? 'Unassigned'}</span>
                    </span>
                    <Badge tone={(daysBetween(a.lastActivityAt) ?? 999) > 30 ? 'accent' : 'watch'}>
                      {a.lastActivityAt ? `${daysBetween(a.lastActivityAt)}d quiet` : 'never touched'}
                    </Badge>
                  </Link>
                ))
              )
            ) : attentionTab === 'stuck' ? (
              attention.stuckDeals.length === 0 ? (
                <EmptyState title="Nothing is stuck" message="Every open deal has moved recently." icon={<Layers size={22} />} />
              ) : (
                attention.stuckDeals.map((d) => (
                  <Link key={d.id} to={`/deals/${d.id}`} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 transition-colors hover:bg-sunken">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{d.reference} · {d.name}</span>
                      <span className="block text-[11px] text-muted">{d.account.name} · {d.stage.name} · {d.owner?.name ?? 'Unassigned'}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="tabular block text-[13px] font-semibold">{moneyShort(d.amount)}</span>
                      <span className="block text-[10px] uppercase tracking-[0.08em] text-n400">{daysBetween(d.stageChangedAt)}d in stage</span>
                    </span>
                  </Link>
                ))
              )
            ) : attentionTab === 'approvals' ? (
              !approvals?.length ? (
                <EmptyState title="Nothing to approve" message="No deals, orders or invoices are waiting on your signature." icon={<ShieldCheck size={22} />} />
              ) : (
                approvals.map((a) => (
                  <Link
                    key={`${a.entity}-${a.id}`}
                    to={a.entity === 'deals' ? `/deals/${a.id}` : a.entity === 'invoices' ? `/invoices/${a.id}` : `/purchase-orders/${a.id}`}
                    className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 transition-colors hover:bg-sunken"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{a.reference} · {a.account}</span>
                      <span className="block text-[11px] text-muted">
                        {a.entity === 'deals' ? a.title : a.title} · {a.requestedBy ? `from ${a.requestedBy}` : 'submitted'} {a.requestedAt ? relative(a.requestedAt) : ''}
                      </span>
                      {/* What is being signed off, not just how much. */}
                      {a.marginBelowFloor ? (
                        <span className="block text-[11px] font-semibold text-accent">
                          {(a.marginPct ?? 0) < 0
                            ? `Sells below cost · ${percent(a.marginPct ?? 0, 1)} margin`
                            : `Thin margin · ${percent(a.marginPct ?? 0, 1)}`}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="tabular text-[13px] font-semibold">{money(a.value)}</span>
                      <Badge tone={a.marginBelowFloor ? 'accent' : 'watch'}>Approve</Badge>
                    </span>
                  </Link>
                ))
              )
            ) : attentionTab === 'registrations' ? (
              attention.expiringRegistrations.length === 0 ? (
                <EmptyState title="No registrations expiring" message="Nothing lapses inside the warning window." icon={<CalendarClock size={22} />} />
              ) : (
                attention.expiringRegistrations.map((r) => (
                  <Link key={r.id} to={`/deals/${r.deal.id}`} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 transition-colors hover:bg-sunken">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">
                        {r.vendor?.name ?? r.partner?.name ?? '—'}{r.regNumber ? ` · ${r.regNumber}` : ''}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {r.side === 'PARTNER' ? 'Partner protection' : 'Vendor registration'} · {r.deal.reference} · {r.deal.account.name}
                      </span>
                    </span>
                    <Badge tone={(daysBetween(r.expiresAt) ?? 0) > -7 ? 'accent' : 'watch'}>expires {relative(r.expiresAt)}</Badge>
                  </Link>
                ))
              )
            ) : attentionTab === 'tasks' ? (
              attention.overdueTasks.length === 0 ? (
                <EmptyState title="No overdue tasks" message="Your follow-ups are current." icon={<AlarmClock size={22} />} />
              ) : (
                attention.overdueTasks.map((t) => (
                  <Link key={t.id} to={t.deal ? `/deals/${t.deal.id}` : t.account ? `/accounts/${t.account.id}` : '/activities'} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 transition-colors hover:bg-sunken">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold">{t.subject}</span>
                      <span className="block text-[11px] text-muted">{t.account?.name ?? t.deal?.reference ?? '—'} · {t.owner?.name ?? 'Unassigned'}</span>
                    </span>
                    <Badge tone={t.priority === 'Urgent' || t.priority === 'High' ? 'accent' : 'watch'}>due {relative(t.dueAt)}</Badge>
                  </Link>
                ))
              )
            ) : attention.overdueInvoices.length === 0 ? (
              <EmptyState title="Nothing overdue" message="Every issued invoice is inside terms." icon={<CircleDollarSign size={22} />} />
            ) : (
              attention.overdueInvoices.map((i) => (
                <Link key={i.id} to="/invoices" className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 transition-colors hover:bg-sunken">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold">{i.number}</span>
                    <span className="block text-[11px] text-muted">{i.account.name} · due {date(i.dueDate)}</span>
                  </span>
                  <span className="tabular shrink-0 text-[13px] font-semibold">{money(i.total - i.amountPaid)}</span>
                </Link>
              ))
            )}
          </div>
        </Card>

        <Card>
          <CardHeader title="Biggest open deals" subtitle="Top 10 by net value" />
          {data.topDeals.length === 0 ? (
            <EmptyState title="No open deals" message="Deals you create will be ranked here." icon={<Users size={22} />} />
          ) : (
            <div className="max-h-[340px] overflow-y-auto">
              {data.topDeals.map((d) => (
                <Link key={d.id} to={`/deals/${d.id}`} className="flex items-center gap-3 border-b border-line px-4 py-2.5 transition-colors hover:bg-sunken">
                  <span className="h-8 w-[3px] shrink-0" style={{ background: d.stage.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">{d.name}</span>
                    <span className="block truncate text-[11px] text-muted">{d.account.name} · {d.stage.name} · closes {date(d.closeDate)}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="tabular block text-[13px] font-semibold">{moneyShort(d.amount)}</span>
                    <span className="block text-[10px] text-n400">{d.probability}% likely</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
          {sees('deals', 'cost') ? null : (
            <p className="border-t border-line px-4 py-2 text-[11px] text-n400">Cost and margin are hidden for your role.</p>
          )}
        </Card>
      </div>
    </>
  );
}
