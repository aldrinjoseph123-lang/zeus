import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useMe } from '../me';

/**
 * The partner's list: every registered deal they may see, the protection with us and the
 * lock with each vendor side by side, soonest expiry first. The countdown is the point —
 * a partner's quiet fear is protection lapsing without anyone saying so.
 *
 * At hundreds of rows a list needs filters. They live in the URL, so "CrowdStrike,
 * expiring in 30 days" is a link somebody can keep. What the filters offer comes from
 * this person's own rows: a filter narrows what they may already see, never widens it.
 */
type Side = { status: 'SUBMITTED' | 'APPROVED' | 'EXPIRED' | 'REJECTED'; submittedAt: string | null; approvedAt: string | null; expiresAt: string | null; daysLeft: number | null; regNumber?: string | null };
type Row = { id: string; deal: { reference: string; endCustomer: string; stage?: string; value?: number; quoted?: number }; ours: Side; vendors: Array<Side & { vendor: string }> };
type Page = { data: Row[]; total: number; page: number; pageSize: number; facets: { vendors: string[]; stages: string[]; statuses: string[] }; scope: 'all' | 'mine' };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null);
const aed = (n: number) => new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', maximumFractionDigits: 0 }).format(n);
const STATUS_LABEL: Record<Side['status'], string> = { APPROVED: 'Approved', SUBMITTED: 'With the vendor', EXPIRED: 'Expired', REJECTED: 'Not approved' };

function Status({ side }: { side: Side }) {
  const tone = side.status === 'APPROVED' ? 'text-[var(--secure)] border-[var(--secure)]'
    : side.status === 'EXPIRED' || side.status === 'REJECTED' ? 'text-[var(--red)] border-[var(--red)]'
      : 'text-[var(--muted)] border-[var(--line)]';
  return <span className={`inline-block border px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] ${tone}`}>{STATUS_LABEL[side.status]}</span>;
}

function Countdown({ side }: { side: Side }) {
  if (side.status === 'REJECTED') return <span className="text-[13px] text-[var(--muted)]">Ask your Protect24x7 contact why.</span>;
  if (side.daysLeft === null) return <span className="text-[13px] text-[var(--muted)]">Expiry pending</span>;
  if (side.daysLeft < 0) return <span className="text-[13px] text-[var(--red)]">Lapsed {fmt(side.expiresAt)}</span>;
  const urgent = side.daysLeft <= 14;
  return (
    <span className={`text-[13px] ${urgent ? 'text-[var(--red)]' : ''}`}>
      Protected until <b>{fmt(side.expiresAt)}</b> · {side.daysLeft === 0 ? 'today' : `${side.daysLeft} day${side.daysLeft === 1 ? '' : 's'} left`}
    </span>
  );
}

const field = 'border border-[var(--line)] bg-transparent px-2.5 py-2 text-[13px] text-[var(--ink)] outline-none focus:border-[var(--red)]';

export default function PartnerHome() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const filters = useMemo(() => ({
    q: params.get('q') ?? '', vendor: params.get('vendor') ?? '', status: params.get('status') ?? '',
    stage: params.get('stage') ?? '', expiring: params.get('expiring') ?? '', sort: params.get('sort') ?? '',
  }), [params]);
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };
  const query = (page: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
    qs.set('page', String(page));
    return `/registrations?${qs}`;
  };

  useEffect(() => {
    setLoading(true); setError(null);
    api<Page>('GET', query(1)).then((p) => { setPages([p]); setLoading(false); }).catch(() => { setError('Could not load your registrations. Try again in a moment.'); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);
  const more = () => {
    const next = (pages.at(-1)?.page ?? 0) + 1;
    api<Page>('GET', query(next)).then((p) => setPages((ps) => [...ps, p])).catch(() => setError('Could not load more.'));
  };

  const first = pages[0];
  const rows = pages.flatMap((p) => p.data);
  const active = Object.values(filters).some(Boolean);

  if (error) return <p className="mt-10 text-[13px] text-[var(--red)]">{error}</p>;
  if (!first && loading) return <p className="mt-10 text-[13px] text-[var(--muted)]">Loading…</p>;
  if (!first) return null;

  return (
    <section className="mt-8">
      <p className="text-[12px] text-[var(--muted)]">
        {first.scope === 'all' ? `You see every deal registered under ${me.account.name}.` : 'You see the deals registered under your name.'}
      </p>

      {(first.total > 0 || active) ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
          <input value={filters.q} onChange={(e) => set('q', e.target.value)} placeholder="Customer or reference…" className={`${field} lg:col-span-2`} aria-label="Search" />
          <select value={filters.status} onChange={(e) => set('status', e.target.value)} className={field} aria-label="Status">
            <option value="">Any status</option>
            {first.facets.statuses.map((s) => <option key={s} value={s}>{STATUS_LABEL[s as Side['status']] ?? s}</option>)}
          </select>
          <select value={filters.vendor} onChange={(e) => set('vendor', e.target.value)} className={field} aria-label="Vendor">
            <option value="">Any vendor</option>
            {first.facets.vendors.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
          {first.facets.stages.length ? (
            <select value={filters.stage} onChange={(e) => set('stage', e.target.value)} className={field} aria-label="Stage">
              <option value="">Any stage</option>
              {first.facets.stages.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          ) : null}
          <select value={filters.expiring} onChange={(e) => set('expiring', e.target.value)} className={field} aria-label="Expiry">
            <option value="">Any expiry</option>
            <option value="30">Next 30 days</option>
            <option value="60">Next 60 days</option>
            <option value="90">Next 90 days</option>
            <option value="lapsed">Already lapsed</option>
          </select>
          <select value={filters.sort} onChange={(e) => set('sort', e.target.value)} className={field} aria-label="Sort">
            <option value="">Soonest expiry first</option>
            <option value="newest">Newest first</option>
            {rows.some((r) => r.deal.value !== undefined) ? <option value="value">Highest value first</option> : null}
          </select>
        </div>
      ) : null}

      {first.total === 0 ? (
        <div className="mt-8 border border-dashed border-[var(--line)] px-6 py-12 text-center">
          <p className="text-[13px] uppercase tracking-[0.2em] text-[var(--muted)]">{active ? 'Nothing matches' : 'No registered deals yet'}</p>
          <p className="mx-auto mt-3 max-w-[48ch] text-[14px] leading-relaxed text-[var(--muted)]">
            {active ? 'Clear a filter or two.' : 'When an opportunity you bring us is registered, it appears here with its protection dates — ours and the vendor\'s.'}
          </p>
          {active ? <button onClick={() => setParams({}, { replace: true })} className="mt-4 text-[12px] uppercase tracking-[0.15em] underline underline-offset-4">Clear filters</button> : null}
        </div>
      ) : (
        <>
          <p className="mt-5 text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">
            {rows.length < first.total ? `${rows.length} of ${first.total}` : first.total} registered deal{first.total === 1 ? '' : 's'}
            {active ? <> · <button onClick={() => setParams({}, { replace: true })} className="underline underline-offset-4">clear filters</button></> : null}
          </p>
          <ul className={`mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)] ${loading ? 'opacity-60' : ''}`}>
            {rows.map((r) => (
              <li key={r.id} className="grid gap-4 py-5 md:grid-cols-[1.2fr_1fr_1fr]">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">{r.deal.reference}</p>
                  <p className="mt-1 text-[17px] font-semibold leading-tight">{r.deal.endCustomer}</p>
                  {r.deal.stage ? (
                    <p className="mt-1.5">
                      <span className={`inline-block border px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] ${r.deal.stage === 'Won' ? 'border-[var(--secure)] text-[var(--secure)]' : r.deal.stage === 'Lost' ? 'border-[var(--line)] text-[var(--muted)]' : 'border-[var(--line)] text-[var(--ink)]'}`}>
                        {r.deal.stage}
                      </span>
                    </p>
                  ) : null}
                  {r.deal.quoted !== undefined ? <p className="mt-1.5 text-[13px]">Quoted <b>{aed(r.deal.quoted)}</b></p> : null}
                  {r.deal.value !== undefined && r.deal.quoted === undefined ? <p className="mt-1 text-[13px] text-[var(--muted)]">{aed(r.deal.value)}</p> : null}
                  {r.deal.value !== undefined && r.deal.quoted !== undefined ? <p className="mt-0.5 text-[12px] text-[var(--muted)]">Deal value {aed(r.deal.value)}</p> : null}
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">Your protection with us</p>
                  <Status side={r.ours} />
                  <Countdown side={r.ours} />
                  {r.ours.regNumber ? <p className="text-[12px] text-[var(--muted)]">Ref {r.ours.regNumber}</p> : null}
                </div>
                <div className="flex flex-col gap-3">
                  <p className="text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">Our registration with the vendor</p>
                  {r.vendors.length === 0 ? <p className="text-[13px] text-[var(--muted)]">Not registered yet</p> : r.vendors.map((v, i) => (
                    <div key={i} className="flex flex-col gap-1.5">
                      <p className="text-[13px] font-semibold">{v.vendor}</p>
                      <Status side={v} />
                      <Countdown side={v} />
                      {v.regNumber ? <p className="text-[12px] text-[var(--muted)]">Ref {v.regNumber}</p> : null}
                    </div>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {rows.length < first.total ? (
            <button onClick={more} className="mt-4 w-full border border-[var(--line)] py-3 text-[12px] uppercase tracking-[0.15em] hover:border-[var(--red)]">
              Show more · {first.total - rows.length} left
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
