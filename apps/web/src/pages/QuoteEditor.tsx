import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, FileDown, Mail, Plus, Save } from 'lucide-react';
import { api, ApiError, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateInput, money, percent } from '../lib/format';
import { LineEditor, blankLine, previewTotals, type EditableLine } from '../components/lineEditor';
import {
  Button, Card, CardHeader, ErrorNote, Field, Input, Loading, Modal,
  PageHeader, Textarea, cx, useToast,
} from '../components/ui';
import { AccountPicker, ContactPicker, Lookup } from '../components/pickers';
import { LifecycleRail, quoteHint, quoteTrack } from '../components/lifecycle';

interface QuoteFull {
  id: string; number: string; version: number; status: string; issueDate: string; validUntil: string | null;
  discountPct: string | number; vatRate: string | number; terms: string | null; notes: string | null;
  account: { id: string; name: string }; contact: { id: string; firstName: string; lastName: string; email: string | null } | null;
  deal: { id: string; reference: string; name: string } | null;
  preparedBy: { id: string; name: string } | null;
  lines: Array<{ id: string; productId: string | null; description: string; quantity: string | number; unit: string; unitPrice: string | number; unitCost: string | number; discountPct: string | number; taxable: boolean; termMonths: number | null }>;
}

export default function QuoteEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can, sees } = useAuth();

  const isNew = !id;
  const showCost = sees('quotes', 'unitCost');

  const [accountId, setAccountId] = useState(params.get('accountId') ?? '');
  const [accountLabel, setAccountLabel] = useState<string | null>(null);
  const [dealId, setDealId] = useState(params.get('dealId') ?? '');
  const [contactId, setContactId] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [discountPct, setDiscountPct] = useState(0);
  const [vatRate, setVatRate] = useState(5);
  const [terms, setTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<EditableLine[]>([blankLine()]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const { data: quote, isLoading } = useQuery({
    queryKey: ['quote', id],
    enabled: !isNew,
    queryFn: () => api.get<QuoteFull>(`/quotes/${id}`),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.get<Record<string, unknown>>('/settings/public'),
    staleTime: 300_000,
  });

  // Hydrate the form once the quote (or the defaults) arrive.
  useEffect(() => {
    if (quote) {
      setAccountId(quote.account.id);
      setAccountLabel(quote.account.name);
      setDealId(quote.deal?.id ?? '');
      setContactId(quote.contact?.id ?? '');
      setValidUntil(dateInput(quote.validUntil));
      setDiscountPct(Number(quote.discountPct));
      setVatRate(Number(quote.vatRate));
      setTerms(quote.terms ?? '');
      setNotes(quote.notes ?? '');
      setLines(
        quote.lines.length
          ? quote.lines.map((line) => ({
              key: line.id, productId: line.productId, description: line.description,
              quantity: Number(line.quantity), unit: line.unit, unitPrice: Number(line.unitPrice),
              unitCost: Number(line.unitCost), discountPct: Number(line.discountPct),
              taxable: line.taxable, vatRate: Number(quote.vatRate), termMonths: line.termMonths,
            }))
          : [blankLine(vatRate)],
      );
    } else if (isNew && settings) {
      setVatRate(Number(settings['finance.vatRate'] ?? 5));
      const days = Number(settings['finance.quoteValidDays'] ?? 30);
      setValidUntil(dateInput(new Date(Date.now() + days * 86_400_000)));
    }
  }, [quote, isNew, settings]);

  const totals = useMemo(() => previewTotals(lines, discountPct), [lines, discountPct]);
  const locked = quote?.status === 'ACCEPTED';

  const payload = () => ({
    accountId,
    dealId: dealId || null,
    contactId: contactId || null,
    validUntil: validUntil || null,
    discountPct,
    vatRate,
    terms: terms || null,
    notes: notes || null,
    lines: lines
      .filter((line) => line.description.trim())
      .map((line) => ({
        productId: line.productId,
        description: line.description.trim(),
        quantity: Number(line.quantity) || 0,
        unit: line.unit,
        unitPrice: Number(line.unitPrice) || 0,
        unitCost: Number(line.unitCost) || 0,
        discountPct: Number(line.discountPct) || 0,
        taxable: line.taxable !== false,
        termMonths: line.termMonths,
      })),
  });

  const save = useMutation({
    mutationFn: () => (isNew ? api.post<QuoteFull>('/quotes', payload()) : api.patch<QuoteFull>(`/quotes/${id}`, payload())),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['quotes'] });
      void queryClient.invalidateQueries({ queryKey: ['quote', saved.id] });
      void queryClient.invalidateQueries({ queryKey: ['deal'] });
      toast.push(isNew ? `Quote ${saved.number} created.` : 'Quote saved.');
      if (isNew) navigate(`/quotes/${saved.id}`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save the quote.'),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post(`/quotes/${id}/status`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['quote', id] });
      void queryClient.invalidateQueries({ queryKey: ['quotes'] });
      toast.push('Status updated.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not update status.', 'error'),
  });

  const makeInvoice = useMutation({
    mutationFn: () => api.post<{ number: string }>(`/quotes/${id}/invoice`, {}),
    onSuccess: (invoice) => { toast.push(`Invoice ${invoice.number} raised.`); navigate('/invoices'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not raise the invoice.', 'error'),
  });

  const revise = useMutation({
    mutationFn: () => api.post<QuoteFull>(`/quotes/${id}/revise`, {}),
    onSuccess: (copy) => { toast.push('New version created.'); navigate(`/quotes/${copy.id}`); },
  });

  if (!isNew && isLoading) return <Loading />;

  return (
    <>
      <Link to="/quotes" className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted transition-colors hover:text-ink">
        <ArrowLeft size={13} /> All quotes
      </Link>

      <PageHeader
        title={isNew ? 'New quotation' : quote?.number ?? 'Quotation'}
        description={
          isNew
            ? 'VAT is applied only to taxable lines. Totals update as you type; the server recalculates on save.'
            : `${quote?.status} · issued ${date(quote?.issueDate)}${quote?.deal ? ` · ${quote.deal.reference}` : ''}`
        }
        actions={
          <>
            {!isNew ? (
              <>
                <Button icon={<FileDown size={14} />} onClick={() => download(`/quotes/${id}/pdf`, `${quote?.number}.pdf`).catch((err) => toast.push(err.message, 'error'))}>PDF</Button>
                {can('quotes', 'update') ? <Button icon={<Mail size={14} />} onClick={() => setSending(true)}>Email</Button> : null}
                {can('quotes', 'create') ? <Button icon={<Copy size={14} />} onClick={() => revise.mutate()}>New version</Button> : null}
              </>
            ) : null}
            {can('quotes', locked ? 'create' : 'update') && !locked ? (
              <Button variant="accent" icon={<Save size={14} />} loading={save.isPending} disabled={!accountId} onClick={() => save.mutate()}>
                {isNew ? 'Create quote' : 'Save'}
              </Button>
            ) : null}
          </>
        }
      />

      {!isNew && quote ? (
        <Card className="mb-3">
          <LifecycleRail
            track={quoteTrack(quote.status)}
            disabled={setStatus.isPending}
            onStep={can('quotes', 'update') && !locked ? (key) => setStatus.mutate(key) : undefined}
            hint={{
              ...quoteHint(quote),
              cta:
                quote.status === 'ACCEPTED' && can('invoices', 'create')
                  ? { label: 'Raise invoice', loading: makeInvoice.isPending, onClick: () => makeInvoice.mutate() }
                  : quote.status === 'DRAFT' && can('quotes', 'update')
                    ? { label: 'Email it', onClick: () => setSending(true) }
                    : (quote.status === 'REJECTED' || quote.status === 'EXPIRED') && can('quotes', 'create')
                      ? { label: 'New version', loading: revise.isPending, onClick: () => revise.mutate() }
                      : undefined,
            }}
            meta={
              can('quotes', 'update') && !locked && quote.status !== 'REJECTED' ? (
                <button
                  onClick={() => setStatus.mutate('REJECTED')}
                  className="text-[11px] font-semibold uppercase tracking-[0.06em] text-n400 underline decoration-dotted underline-offset-2 transition-colors hover:text-accent"
                >
                  Rejected
                </button>
              ) : null
            }
          />
          {locked ? (
            <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
              Accepted quotes are locked so the invoice can never disagree with what the customer signed. Create a new version to re-price.
            </p>
          ) : null}
        </Card>
      ) : null}

      {error ? <div className="mb-3"><ErrorNote error={error} /></div> : null}

      <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Customer" />
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
              <Field label="Bill to" required>
                <AccountPicker
                  value={accountId || null}
                  selectedLabel={accountLabel}
                  onChange={(id, row) => { setAccountId(id ?? ''); setAccountLabel(row?.name ?? null); setContactId(''); }}
                />
              </Field>
              <Field label="Attention of">
                <ContactPicker
                  value={contactId || null}
                  accountId={accountId || null}
                  selectedLabel={quote?.contact ? `${quote.contact.firstName} ${quote.contact.lastName}` : null}
                  onChange={(id) => setContactId(id ?? '')}
                />
              </Field>
              <Field label="Valid until">
                <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} disabled={locked} />
              </Field>
              <Field label="Linked deal">
                {quote?.deal ? (
                  <Link to={`/deals/${quote.deal.id}`} className="block truncate rounded-sharp border border-line bg-sunken px-3 py-2 text-[13px] underline decoration-dotted underline-offset-2">
                    {quote.deal.reference} · {quote.deal.name}
                  </Link>
                ) : (
                  <Lookup<{ id: string; reference: string; name: string; account: { name: string } }>
                    value={dealId || null}
                    onChange={(id) => setDealId(id ?? '')}
                    endpoint="/deals"
                    placeholder="Search deals…"
                    render={(row) => ({ primary: `${row.reference} · ${row.name}`, secondary: row.account.name })}
                  />
                )}
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Line items"
              subtitle="Pick from the catalog or type a one-off line"
              actions={!locked ? <Button size="sm" icon={<Plus size={13} />} onClick={() => setLines([...lines, blankLine()])}>Add line</Button> : undefined}
            />

            <LineEditor
              lines={lines}
              onChange={setLines}
              locked={locked}
              showCost={showCost}
              defaultVat={vatRate}
              showVat={false}
              headerDiscountPct={discountPct}
              dealId={dealId || quote?.deal?.id || null}
              currency={String(settings?.['finance.currency'] ?? 'AED')}
            />
          </Card>

          <Card>
            <CardHeader title="Terms & notes" />
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
              <Field label="Terms & conditions" hint="Defaults come from Settings → Finance.">
                <Textarea rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} disabled={locked} placeholder={String(settings?.['finance.quoteTerms'] ?? '')} />
              </Field>
              <Field label="Notes for the customer">
                <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked} />
              </Field>
            </div>
          </Card>
        </div>

        {/* sticky totals */}
        <div className="xl:sticky xl:top-4 xl:self-start">
          <Card>
            <CardHeader title="Totals" subtitle="AED" />
            <div className="space-y-2 px-4 py-4 text-[13px]">
              <Row label="Subtotal" value={money(totals.subtotal, true)} />

              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-muted">
                  Discount
                  <Input
                    className="w-16 px-1.5 py-0.5 text-right text-[12px]"
                    type="number" min="0" max="100" step="0.5"
                    value={discountPct}
                    disabled={locked}
                    onChange={(e) => setDiscountPct(Number(e.target.value))}
                  />
                  %
                </span>
                <span className="tabular">− {money(totals.discountAmt, true)}</span>
              </div>

              <Row label="Net" value={money(totals.netAfterDiscount, true)} strong />

              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-muted">
                  VAT
                  <Input
                    className="w-16 px-1.5 py-0.5 text-right text-[12px]"
                    type="number" min="0" max="100" step="0.5"
                    value={vatRate}
                    disabled={locked}
                    onChange={(e) => setVatRate(Number(e.target.value))}
                  />
                  %
                </span>
                <span className="tabular">{money(totals.vatAmount, true)}</span>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2 bg-n950 px-3 py-2.5 text-white">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em]">Total</span>
                <span className="tabular text-[17px] font-bold">{money(totals.total, true)}</span>
              </div>

              {showCost ? (
                <div className="mt-3 border-t border-line pt-3">
                  <Row label="Cost" value={money(totals.totalCost, true)} muted />
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-muted">Margin</span>
                    <span className={cx('tabular font-semibold', totals.marginPct < 10 ? 'text-accent' : totals.marginPct < 20 ? 'text-watch' : 'text-secure')}>
                      {money(totals.marginAmount, true)} · {percent(totals.marginPct, 1)}
                    </span>
                  </div>
                  {totals.marginPct < 10 && totals.netAfterDiscount > 0 ? (
                    <p className="mt-2 text-[11px] text-accent">Margin is under 10% — check the vendor discount before sending.</p>
                  ) : null}
                </div>
              ) : null}

            </div>
          </Card>
        </div>
      </div>

      {sending && quote ? <SendModal quote={quote} onClose={() => setSending(false)} /> : null}
    </>
  );
}

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-muted' : 'text-muted'}>{label}</span>
      <span className={cx('tabular', strong && 'font-semibold')}>{value}</span>
    </div>
  );
}

function SendModal({ quote, onClose }: { quote: QuoteFull; onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [to, setTo] = useState(quote.contact?.email ?? '');
  const [cc, setCc] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () =>
      api.post(`/quotes/${quote.id}/send`, {
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
        message: message || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['quote', quote.id] });
      toast.push('Quotation emailed.');
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not send.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Email ${quote.number}`}
      subtitle="Sent from the shared mailbox configured in Settings → Integrations, with the PDF attached."
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!to.trim()} loading={send.isPending} onClick={() => send.mutate()}>Send</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        <Field label="To" required hint="Comma-separated for more than one recipient.">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@customer.ae" />
        </Field>
        <Field label="CC">
          <Input value={cc} onChange={(e) => setCc(e.target.value)} />
        </Field>
        <Field label="Message">
          <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Leave blank for the standard covering note." />
        </Field>
      </div>
    </Modal>
  );
}
