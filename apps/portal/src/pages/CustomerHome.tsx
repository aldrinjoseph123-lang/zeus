import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The customer's list: the services they own, soonest renewal first. What they have,
 * how much of it, and when it renews — the answer to "what are we paying for and when
 * does it come up again". No prices here; renewals are a conversation, not a checkout.
 */
type Entitlement = { label: string; unit: string; included: number; used: number; remaining: number; validTo: string; deliveries: Array<{ status: 'SCHEDULED' | 'DELIVERED'; scheduledFor: string | null; deliveredAt: string | null; quantity: number; reference: string | null }> };
type Row = { id: string; reference: string; description: string; product: string | null; quantity: number; unit: string; startDate: string; endDate: string; daysLeft: number; status: 'ACTIVE' | 'EXPIRING' | 'LAPSED' };

const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function Renewal({ row }: { row: Row }) {
  if (row.status === 'LAPSED') return <span className="text-[13px] text-[var(--red)]">Lapsed {fmt(row.endDate)}</span>;
  const urgent = row.daysLeft <= 30;
  return <span className={`text-[13px] ${urgent ? 'text-[var(--red)]' : ''}`}>Renews <b>{fmt(row.endDate)}</b> · {row.daysLeft <= 0 ? 'due now' : `${row.daysLeft} day${row.daysLeft === 1 ? '' : 's'}`}</span>;
}

export default function CustomerHome() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Row[]>('GET', '/subscriptions').then(setRows).catch(() => setError('Could not load your services. Try again in a moment.')); }, []);

  if (error) return <p className="mt-10 text-[13px] text-[var(--red)]">{error}</p>;
  if (!rows) return <p className="mt-10 text-[13px] text-[var(--muted)]">Loading…</p>;
  if (rows.length === 0) {
    return (
      <section className="mt-10 border border-dashed border-[var(--line)] px-6 py-12 text-center">
        <p className="text-[13px] uppercase tracking-[0.2em] text-[var(--muted)]">No active services</p>
        <p className="mx-auto mt-3 max-w-[48ch] text-[14px] leading-relaxed text-[var(--muted)]">Your services with us and their renewal dates will appear here.</p>
      </section>
    );
  }
  return (
    <section className="mt-8">
      <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{rows.length} service{rows.length === 1 ? '' : 's'} · soonest renewal first</p>
      <ul className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">
        {rows.map((r) => <ServiceRow key={r.reference} row={r} />)}
      </ul>
    </section>
  );
}

function ServiceRow({ row }: { row: Row }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-5">
      <button onClick={() => setOpen((v) => !v)} className="grid w-full gap-2 text-left md:grid-cols-[1.4fr_0.8fr_1fr_auto] md:items-baseline">
        <span>
          <span className="block text-[17px] font-semibold leading-tight">{row.description}</span>
          {row.product && row.product !== row.description ? <span className="mt-0.5 block text-[13px] text-[var(--muted)]">{row.product}</span> : null}
        </span>
        <span className="text-[13px] text-[var(--muted)]">{row.quantity} {row.unit}{row.quantity === 1 ? '' : 's'}</span>
        <Renewal row={row} />
        <span className="text-[11px] uppercase tracking-[0.12em] text-[var(--muted)]">{open ? 'Hide' : 'What\'s included'}</span>
      </button>
      {open ? <Deliverables subscriptionId={row.id} /> : null}
    </li>
  );
}

/** Lazy-loaded when a service is expanded: what it includes and how much is left. */
function Deliverables({ subscriptionId }: { subscriptionId: string }) {
  const [rows, setRows] = useState<Entitlement[] | null>(null);
  useEffect(() => { api<Entitlement[]>('GET', `/subscriptions/${subscriptionId}/entitlements`).then(setRows).catch(() => setRows([])); }, [subscriptionId]);
  if (!rows) return <p className="mt-2 text-[12px] text-[var(--muted)]">Loading…</p>;
  if (rows.length === 0) return <p className="mt-2 text-[12px] text-[var(--muted)]">Nothing itemised for this service.</p>;
  return (
    <div className="mt-3 flex flex-col gap-3">
      {rows.map((e, i) => (
        <div key={i} className="border border-[var(--line)] px-3 py-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[14px] font-semibold">{e.label}</span>
            <span className="text-[13px]"><b className={e.remaining > 0 ? 'text-[var(--secure)]' : 'text-[var(--muted)]'}>{e.remaining}</b> of {e.included} {e.unit}{e.included === 1 ? '' : 's'} remaining · valid to {fmt(e.validTo)}</span>
          </div>
          {e.deliveries.length ? (
            <ul className="mt-2 flex flex-col gap-1 text-[12px] text-[var(--muted)]">
              {e.deliveries.map((d, j) => (
                <li key={j}>{d.status === 'DELIVERED' ? `Delivered ${d.deliveredAt ? fmt(d.deliveredAt) : ''}` : `Scheduled ${d.scheduledFor ? 'for ' + fmt(d.scheduledFor) : ''}`}{d.reference ? ` · ${d.reference}` : ''}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}
