import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The customer's list: the services they own, soonest renewal first. What they have,
 * how much of it, and when it renews — the answer to "what are we paying for and when
 * does it come up again". No prices here; renewals are a conversation, not a checkout.
 */
type Row = { reference: string; description: string; product: string | null; quantity: number; unit: string; startDate: string; endDate: string; daysLeft: number; status: 'ACTIVE' | 'EXPIRING' | 'LAPSED' };

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
        {rows.map((r) => (
          <li key={r.reference} className="grid gap-2 py-5 md:grid-cols-[1.4fr_0.8fr_1fr] md:items-baseline">
            <div>
              <p className="text-[17px] font-semibold leading-tight">{r.description}</p>
              {r.product && r.product !== r.description ? <p className="mt-0.5 text-[13px] text-[var(--muted)]">{r.product}</p> : null}
            </div>
            <p className="text-[13px] text-[var(--muted)]">{r.quantity} {r.unit}{r.quantity === 1 ? '' : 's'}</p>
            <Renewal row={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}
