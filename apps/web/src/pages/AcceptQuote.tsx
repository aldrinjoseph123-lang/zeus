import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, FileDown } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { date, money } from '../lib/format';
import { Button, Field, Input } from '../components/ui';

/**
 * The page a customer lands on from the quotation email. No sign-in: the link is the key.
 * It shows the sell side of the quote and, while the quote is open, one button.
 */
interface PublicQuote {
  company: string; number: string; status: string; issueDate: string; validUntil: string | null; currency: string;
  customer: string; attention: string | null;
  preparedBy: { name: string; email: string | null; phone: string | null } | null;
  lines: Array<{ description: string; quantity: number; unit: string; unitPrice: number; discountPct: number; taxable: boolean; lineTotal: number }>;
  subtotal: number; discountPct: number; discountAmt: number; vatRate: number; vatAmount: number; total: number;
  terms: string | null; notes: string | null;
  acceptedAt: string | null; acceptedByName: string | null; linkExpired: boolean;
}

export default function AcceptQuote() {
  const { token = '' } = useParams();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['public-quote', token],
    queryFn: () => api.get<PublicQuote>(`/public/quotes/${token}`),
    retry: false,
  });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const accept = useMutation({
    mutationFn: () => api.post<{ ok: true; acceptedAt: string }>(`/public/quotes/${token}/accept`, { name: name.trim(), email: email.trim() }),
    onSuccess: () => void refetch(),
  });

  return (
    <div className="min-h-full bg-canvas px-4 py-8 sm:py-14">
      <div className="mx-auto w-full max-w-3xl">
        {isLoading ? <p className="text-center text-[13px] text-muted">Opening your quotation…</p> : null}
        {error ? (
          <Panel>
            <h1 className="text-[18px] font-bold uppercase tracking-[0.1em]">This link is not valid</h1>
            <p className="mt-2 text-[14px] text-muted">
              {error instanceof ApiError && error.status === 404
                ? 'It may have been copied incompletely. Please use the link exactly as it appears in the email, or ask us to send it again.'
                : 'Something went wrong opening it. Please try again in a moment.'}
            </p>
          </Panel>
        ) : null}
        {data ? <Quote q={data} name={name} email={email} setName={setName} setEmail={setEmail} accept={accept} token={token} /> : null}
      </div>
    </div>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="border border-line bg-card px-6 py-6 sm:px-8">{children}</div>;
}

function Quote({ q, name, email, setName, setEmail, accept, token }: {
  q: PublicQuote; name: string; email: string; setName: (v: string) => void; setEmail: (v: string) => void;
  accept: { mutate: () => void; isPending: boolean; error: unknown }; token: string;
}) {
  const open = q.status === 'SENT' || q.status === 'DRAFT';
  const state = q.status === 'ACCEPTED'
    ? { tone: 'text-secure', text: `Accepted${q.acceptedByName ? ` by ${q.acceptedByName}` : ''} on ${date(q.acceptedAt)}` }
    : q.linkExpired ? { tone: 'text-watch-ink', text: 'This link has expired. Please ask us for a fresh quotation.' }
      : !open ? { tone: 'text-muted', text: `This quotation is ${q.status.toLowerCase()} and can no longer be accepted.` }
        : null;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow">{q.company} · Quotation</p>
          <h1 className="text-[24px] font-bold tracking-[0.02em]">{q.number}</h1>
          <p className="mt-1 text-[13px] text-muted">
            For {q.customer}{q.attention ? `, attention ${q.attention}` : ''} · issued {date(q.issueDate)}{q.validUntil ? ` · valid until ${date(q.validUntil)}` : ''}
          </p>
        </div>
        <a href={`/api/public/quotes/${token}/pdf`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 border border-line bg-card px-3 py-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] hover:bg-sunken">
          <FileDown size={13} /> PDF
        </a>
      </header>

      <Panel>
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="eyebrow py-2 pr-3 font-semibold">Description</th>
                <th className="eyebrow py-2 pr-3 text-right font-semibold">Qty</th>
                <th className="eyebrow py-2 pr-3 text-right font-semibold">Unit price</th>
                <th className="eyebrow py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {q.lines.map((l, i) => (
                <tr key={i} className="border-b border-hair align-top">
                  <td className="py-2.5 pr-3">{l.description}{l.taxable ? '' : <span className="ml-1 text-[11px] text-muted">(no VAT)</span>}</td>
                  <td className="tabular py-2.5 pr-3 text-right">{l.quantity} {l.unit}</td>
                  <td className="tabular py-2.5 pr-3 text-right">{money(l.unitPrice, true)}{l.discountPct ? <span className="ml-1 text-[11px] text-muted">−{l.discountPct}%</span> : null}</td>
                  <td className="tabular py-2.5 text-right">{money(l.lineTotal, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="ml-auto mt-4 grid max-w-xs grid-cols-2 gap-y-1 text-[13px]">
          <dt className="text-muted">Subtotal</dt><dd className="tabular text-right">{money(q.subtotal, true)}</dd>
          {q.discountAmt ? <><dt className="text-muted">Discount {q.discountPct}%</dt><dd className="tabular text-right">− {money(q.discountAmt, true)}</dd></> : null}
          <dt className="text-muted">VAT {q.vatRate}%</dt><dd className="tabular text-right">{money(q.vatAmount, true)}</dd>
          <dt className="font-bold">Total ({q.currency})</dt><dd className="tabular text-right font-bold">{money(q.total, true)}</dd>
        </dl>
        {q.terms ? <p className="mt-5 border-t border-line pt-4 text-[12px] leading-relaxed text-muted">{q.terms}</p> : null}
        {q.notes ? <p className="mt-2 text-[12px] leading-relaxed text-muted">{q.notes}</p> : null}
      </Panel>

      <Panel>
        {state ? (
          <p className={`flex items-center gap-2 text-[14px] font-semibold ${state.tone}`}>{q.status === 'ACCEPTED' ? <Check size={16} /> : null}{state.text}</p>
        ) : (
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); accept.mutate(); }}>
            <div className="sm:col-span-2">
              <h2 className="text-[15px] font-bold uppercase tracking-[0.1em]">Accept this quotation</h2>
              <p className="mt-1 text-[13px] text-muted">Your name and email are recorded with the acceptance, on behalf of {q.customer}.</p>
            </div>
            <Field label="Your name" required><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required /></Field>
            <Field label="Your email" required><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></Field>
            {accept.error ? <p className="text-[13px] text-accent-ink sm:col-span-2">{accept.error instanceof ApiError ? accept.error.message : 'That did not go through. Please try again.'}</p> : null}
            <div className="sm:col-span-2">
              <Button type="submit" variant="accent" icon={<Check size={14} />} loading={accept.isPending} disabled={name.trim().length < 2 || !email.includes('@')}>
                Accept quotation {q.number}
              </Button>
            </div>
          </form>
        )}
      </Panel>

      {q.preparedBy ? (
        <p className="text-center text-[12px] text-muted">
          Questions? {q.preparedBy.name}{q.preparedBy.email ? ` · ${q.preparedBy.email}` : ''}{q.preparedBy.phone ? ` · ${q.preparedBy.phone}` : ''}
        </p>
      ) : null}
    </div>
  );
}
