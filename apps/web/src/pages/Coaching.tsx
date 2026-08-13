import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, date } from '../lib/format';
import { Badge, Card, CardHeader, EmptyState, Loading, PageHeader, ProgressBar, cx } from '../components/ui';
import { OwnerSelect } from '../components/pickers';

interface Coaching {
  rep: { id: string; name: string };
  quota: { period: string; target: number; won: number; wonCount: number; attainmentPct: number | null; weightedOpen: number; projectedPct: number | null };
  pipeline: Array<{ stage: { id: string; name: string; color: string }; count: number; net: number; weighted: number }>;
  openTotal: { count: number; net: number };
  escalations: Array<{ reference: string; name: string; amount: number; stage: string; closeDate: string; reasons: string[] }>;
  activity: { done: number; open: number };
  recentClosed: Array<{ reference: string; name: string; status: string; amount: number; lostReason: string | null; closedAt: string | null }>;
}

/** Rep-owned pipeline-review board for 1:1s — the rep drives it as the manager asks. */
export default function Coaching() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [repId, setRepId] = useState(user?.id ?? '');

  const { data, isLoading, error } = useQuery({
    queryKey: ['coaching', repId],
    queryFn: () => api.get<Coaching>(`/coaching/${repId}`),
    enabled: Boolean(repId),
    retry: false,
  });

  const denied = error instanceof ApiError && error.status === 403;

  return (
    <>
      <PageHeader
        title="Coaching"
        description="Walk the pipeline in a 1:1 — quota, stages, and the deals that need a manager."
        actions={<OwnerSelect value={repId} onChange={setRepId} includeUnassigned={false} className="w-[220px]" />}
      />

      {denied ? (
        <EmptyState title="Not your rep to view" message="You can review your own pipeline, or a rep who reports to you." />
      ) : isLoading || !data ? (
        <Loading />
      ) : (
        <div className="flex flex-col gap-3">
          {/* Quota */}
          <Card>
            <CardHeader title={`Quota — ${data.quota.period}`} subtitle={`${data.rep.name} · ${data.quota.wonCount} deal${data.quota.wonCount === 1 ? '' : 's'} won`} />
            <div className="px-4 py-4">
              {data.quota.target > 0 ? (
                <>
                  <div className="mb-1 flex items-baseline justify-between text-[13px]">
                    <span className="tabular font-semibold">{money(data.quota.won)} <span className="text-muted">of {money(data.quota.target)}</span></span>
                    <span className={cx('tabular font-semibold', (data.quota.attainmentPct ?? 0) >= 100 ? 'text-[#14653a]' : 'text-ink')}>{data.quota.attainmentPct}%</span>
                  </div>
                  <ProgressBar value={data.quota.attainmentPct ?? 0} tone={(data.quota.attainmentPct ?? 0) >= 100 ? 'secure' : (data.quota.attainmentPct ?? 0) >= 60 ? 'accent' : 'watch'} height={8} />
                  <p className="mt-2 text-[11px] text-muted">
                    Weighted open pipeline {money(data.quota.weightedOpen)} · projected attainment <strong>{data.quota.projectedPct}%</strong>
                  </p>
                </>
              ) : (
                <p className="text-[12px] text-muted">No quarterly target set for this rep. Set one in Settings → Targets.</p>
              )}
            </div>
          </Card>

          {/* Pipeline by stage */}
          <Card>
            <CardHeader title="Pipeline by stage" subtitle={`${data.openTotal.count} open · ${money(data.openTotal.net)} net`} />
            {data.pipeline.length === 0 ? (
              <EmptyState title="No open deals" message="Nothing in the pipeline for this rep right now." />
            ) : (
              <ul className="px-4 py-3">
                {(() => { const max = Math.max(...data.pipeline.map((p) => p.net), 1); return data.pipeline.map((p) => (
                  <li key={p.stage.id} className="py-1.5">
                    <div className="mb-1 flex items-baseline justify-between text-[12px]">
                      <span className="flex items-center gap-1.5"><span className="h-2 w-2 shrink-0" style={{ background: p.stage.color }} /> {p.stage.name} <span className="text-muted">· {p.count}</span></span>
                      <span className="tabular font-semibold">{money(p.net)}</span>
                    </div>
                    <div className="h-2 w-full bg-sunken"><div className="h-2 bg-ink/70" style={{ width: `${Math.round((p.net / max) * 100)}%`, background: p.stage.color }} /></div>
                  </li>
                )); })()}
              </ul>
            )}
          </Card>

          {/* Escalations */}
          <Card>
            <CardHeader title="Needs escalation" subtitle="Deals a manager should step into." actions={<Badge tone={data.escalations.length ? 'accent' : 'secure'}>{data.escalations.length}</Badge>} />
            {data.escalations.length === 0 ? (
              <EmptyState title="Nothing stalling" message="No stuck, slipping, high-value or below-margin deals." />
            ) : (
              <ul>
                {data.escalations.map((e) => (
                  <li key={e.reference} className="flex items-start gap-3 border-b border-line px-4 py-2.5 last:border-b-0 cursor-pointer hover:bg-accent-soft" onClick={() => navigate('/deals')}>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold">{e.name} <span className="text-[11px] font-normal text-muted">{e.reference} · {e.stage}</span></p>
                      <div className="mt-1 flex flex-wrap gap-1">{e.reasons.map((r) => <Badge key={r} tone="watch">{r}</Badge>)}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tabular text-[13px] font-semibold">{money(e.amount)}</p>
                      <p className="text-[10px] uppercase tracking-[0.08em] text-n400">close {date(e.closeDate)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* Activity + recent closed */}
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader title="Activity (30 days)" />
              <div className="grid grid-cols-2 gap-4 px-4 py-4">
                <div><p className="eyebrow mb-0.5">Completed</p><p className="tabular text-[18px] font-semibold">{data.activity.done}</p></div>
                <div><p className="eyebrow mb-0.5">Open tasks</p><p className="tabular text-[18px] font-semibold">{data.activity.open}</p></div>
              </div>
            </Card>
            <Card>
              <CardHeader title="Recently closed" />
              {data.recentClosed.length === 0 ? (
                <EmptyState title="No closed deals yet" />
              ) : (
                <ul className="max-h-[220px] overflow-y-auto">
                  {data.recentClosed.map((d) => (
                    <li key={d.reference} className="flex items-center gap-2 border-b border-line px-4 py-2 last:border-b-0 text-[12px]">
                      <Badge tone={d.status === 'WON' ? 'secure' : 'accent'}>{d.status}</Badge>
                      <span className="min-w-0 flex-1 truncate">{d.name}{d.status === 'LOST' && d.lostReason ? <span className="text-muted"> · {d.lostReason}</span> : null}</span>
                      <span className="tabular shrink-0 font-semibold">{money(d.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
