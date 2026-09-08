import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The partner's list: every registered deal, the protection with us and the lock with
 * each vendor side by side, soonest expiry first. The countdown is the point — a
 * partner's quiet fear is protection lapsing without anyone saying so.
 */
type Side = { status: 'SUBMITTED' | 'APPROVED' | 'EXPIRED'; submittedAt: string | null; approvedAt: string | null; expiresAt: string | null; daysLeft: number | null; regNumber?: string | null };
type Row = { id: string; deal: { reference: string; endCustomer: string; stage?: string; value?: number; quoted?: number }; ours: Side; vendors: Array<Side & { vendor: string }> };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : null);
const aed = (n: number) => new Intl.NumberFormat('en-AE', { style: 'currency', currency: 'AED', maximumFractionDigits: 0 }).format(n);

function Status({ side }: { side: Side }) {
  const tone = side.status === 'APPROVED' ? 'text-[var(--secure)] border-[var(--secure)]' : side.status === 'EXPIRED' ? 'text-[var(--red)] border-[var(--red)]' : 'text-[var(--muted)] border-[var(--line)]';
  const label = side.status === 'APPROVED' ? 'Approved' : side.status === 'EXPIRED' ? 'Expired' : 'With the vendor';
  return <span className={`inline-block border px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] ${tone}`}>{label}</span>;
}

function Countdown({ side }: { side: Side }) {
  if (side.daysLeft === null) return <span className="text-[13px] text-[var(--muted)]">Expiry pending</span>;
  if (side.daysLeft < 0) return <span className="text-[13px] text-[var(--red)]">Lapsed {fmt(side.expiresAt)}</span>;
  const urgent = side.daysLeft <= 14;
  return (
    <span className={`text-[13px] ${urgent ? 'text-[var(--red)]' : ''}`}>
      Protected until <b>{fmt(side.expiresAt)}</b> · {side.daysLeft === 0 ? 'today' : `${side.daysLeft} day${side.daysLeft === 1 ? '' : 's'} left`}
    </span>
  );
}

export default function PartnerHome() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Row[]>('GET', '/registrations').then(setRows).catch(() => setError('Could not load your registrations. Try again in a moment.'));
  }, []);

  if (error) return <p className="mt-10 text-[13px] text-[var(--red)]">{error}</p>;
  if (!rows) return <p className="mt-10 text-[13px] text-[var(--muted)]">Loading…</p>;
  if (rows.length === 0) {
    return (
      <section className="mt-10 border border-dashed border-[var(--line)] px-6 py-12 text-center">
        <p className="text-[13px] uppercase tracking-[0.2em] text-[var(--muted)]">No registered deals yet</p>
        <p className="mx-auto mt-3 max-w-[48ch] text-[14px] leading-relaxed text-[var(--muted)]">When an opportunity you bring us is registered, it appears here with its protection dates — ours and the vendor's.</p>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{rows.length} registered deal{rows.length === 1 ? '' : 's'} · soonest expiry first</p>
      <ul className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">
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
    </section>
  );
}
