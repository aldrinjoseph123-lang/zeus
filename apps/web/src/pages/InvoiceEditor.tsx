import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Banknote, FileDown, Mail, Save, Trash2, Undo2 } from 'lucide-react';
import { api, ApiError, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateInput, money, percent } from '../lib/format';
import {
  Button, Card, CardHeader, Checkbox, ConfirmDialog, ErrorNote, Field, Input, Loading,
  Modal, PageHeader, Select, Textarea, cx, useToast,
} from '../components/ui';
import { AccountPicker, ContactPicker, ListSelect, Lookup } from '../components/pickers';
import { LineEditor, blankLine, previewTotals, type EditableLine } from '../components/lineEditor';
import { PaymentLedger, RecordPaymentModal, StatusPill, type PaymentRecord } from '../components/payments';
import { LifecycleRail, invoiceHint, invoiceTrack } from '../components/lifecycle';
import { ApprovalBar, type ApprovalState } from '../components/approvals';

interface InvoiceFull extends ApprovalState {
  id: string; number: string; type: 'TAX_INVOICE' | 'CREDIT_NOTE'; status: string;
  issueDate: string; supplyDate: string | null; dueDate: string | null;
  currency: string; exchangeRate: string | number | null;
  discountPct: string | number; vatRate: string | number;
  subtotal: string | number; discountAmt: string | number; vatAmount: string | number;
  total: string | number; amountPaid: string | number;
  placeOfSupply: string | null; reverseCharge: boolean;
  supplierName: string | null; supplierTrn: string | null;
  recipientName: string | null; recipientTrn: string | null;
  poNumber: string | null; terms: string | null; notes: string | null; creditReason: string | null;
  account: { id: string; name: string; trn: string | null };
  contact: { id: string; firstName: string; lastName: string; email: string | null } | null;
  deal: { id: string; reference: string; name: string } | null;
  quote: { id: string; number: string } | null;
  customerPo: { id: string; number: string } | null;
  originalInvoice: { id: string; number: string; total: string | number } | null;
  creditNotes: Array<{ id: string; number: string; total: string | number; status: string }>;
  lines: Array<{ id: string; productId: string | null; description: string; quantity: string | number; unit: string; unitPrice: string | number; unitCost: string | number; discountPct: string | number; taxable: boolean; vatRate: string | number; termMonths: number | null }>;
  payments: PaymentRecord[];
  complianceGaps?: Array<{ message: string; blocking: boolean }>;
}

const POSTED = new Set(['SENT', 'PARTIAL', 'PAID', 'OVERDUE']);

export default function InvoiceEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can, sees } = useAuth();

  const isNew = !id;
  const showCost = sees('quotes', 'unitCost');

  const [form, setForm] = useState({
    accountId: params.get('accountId') ?? '',
    accountLabel: null as string | null,
    contactId: '',
    dealId: params.get('dealId') ?? '',
    customerPoId: '',
    issueDate: dateInput(new Date()),
    supplyDate: '',
    dueDate: '',
    currency: 'AED',
    exchangeRate: '',
    discountPct: 0,
    placeOfSupply: '',
    reverseCharge: false,
    poNumber: '',
    terms: '',
    notes: '',
  });
  const [lines, setLines] = useState<EditableLine[]>([blankLine()]);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false);
  const [crediting, setCrediting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: invoice, isLoading } = useQuery({
    queryKey: ['invoice', id],
    enabled: !isNew,
    queryFn: () => api.get<InvoiceFull>(`/invoices/${id}`),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.get<Record<string, unknown>>('/settings/public'),
    staleTime: 300_000,
  });
  const defaultVat = Number(settings?.['finance.vatRate'] ?? 5);

  useEffect(() => {
    if (invoice) {
      setForm({
        accountId: invoice.account.id,
        accountLabel: invoice.account.name,
        contactId: invoice.contact?.id ?? '',
        dealId: invoice.deal?.id ?? '',
        customerPoId: invoice.customerPo?.id ?? '',
        issueDate: dateInput(invoice.issueDate),
        supplyDate: dateInput(invoice.supplyDate),
        dueDate: dateInput(invoice.dueDate),
        currency: invoice.currency,
        exchangeRate: invoice.exchangeRate ? String(invoice.exchangeRate) : '',
        discountPct: Number(invoice.discountPct),
        placeOfSupply: invoice.placeOfSupply ?? '',
        reverseCharge: invoice.reverseCharge,
        poNumber: invoice.poNumber ?? '',
        terms: invoice.terms ?? '',
        notes: invoice.notes ?? '',
      });
      setLines(
        invoice.lines.length
          ? invoice.lines.map((l) => ({
              key: l.id, productId: l.productId, description: l.description,
              quantity: Number(l.quantity), unit: l.unit, unitPrice: Number(l.unitPrice),
              unitCost: Number(l.unitCost), discountPct: Number(l.discountPct),
              taxable: l.taxable, vatRate: Number(l.vatRate), termMonths: l.termMonths,
            }))
          : [blankLine(defaultVat)],
      );
    } else if (isNew && settings) {
      const days = Number(settings['finance.paymentTermsDays'] ?? 30);
      setForm((f) => ({
        ...f,
        dueDate: dateInput(new Date(Date.now() + days * 86_400_000)),
        placeOfSupply: String(settings['company.placeOfSupply'] ?? ''),
      }));
    }
  }, [invoice, isNew, settings, defaultVat]);

  const totals = useMemo(() => previewTotals(lines, form.discountPct), [lines, form.discountPct]);
  const isCredit = invoice?.type === 'CREDIT_NOTE';
  const posted = invoice ? POSTED.has(invoice.status) : false;
  const locked = posted || invoice?.status === 'CANCELLED';
  const outstanding = invoice ? Number(invoice.total) - Number(invoice.amountPaid) : 0;
  const label = isCredit ? 'Tax credit note' : 'Tax invoice';

  const payload = () => ({
    accountId: form.accountId,
    contactId: form.contactId || null,
    dealId: form.dealId || null,
    customerPoId: form.customerPoId || null,
    issueDate: form.issueDate,
    supplyDate: form.supplyDate || null,
    dueDate: form.dueDate || null,
    currency: form.currency,
    exchangeRate: form.exchangeRate ? Number(form.exchangeRate) : null,
    discountPct: form.discountPct,
    placeOfSupply: form.placeOfSupply || null,
    reverseCharge: form.reverseCharge,
    poNumber: form.poNumber || null,
    terms: form.terms || null,
    notes: form.notes || null,
    lines: lines.filter((l) => l.description.trim()).map((l) => ({
      productId: l.productId, description: l.description.trim(), quantity: l.quantity,
      unit: l.unit, unitPrice: l.unitPrice, unitCost: l.unitCost ?? 0,
      discountPct: l.discountPct, taxable: l.taxable, vatRate: l.taxable ? l.vatRate : 0,
      termMonths: l.termMonths ?? null,
    })),
  });

  const save = useMutation({
    mutationFn: () => (isNew ? api.post<InvoiceFull>('/invoices', payload()) : api.patch<InvoiceFull>(`/invoices/${id}`, payload())),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['invoice', saved.id] });
      toast.push(isNew ? `${saved.number} created.` : 'Invoice saved.');
      if (isNew) navigate(`/invoices/${saved.id}`, { replace: true });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post(`/invoices/${id}/status`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', id] });
      void queryClient.invalidateQueries({ queryKey: ['cash-position'] });
      toast.push('Status updated.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not update.', 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/invoices/${id}`),
    onSuccess: () => { toast.push('Draft deleted.'); navigate('/invoices'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not delete.', 'error'),
  });

  if (!isNew && isLoading) return <Loading />;

  return (
    <>
      <Link to="/invoices" className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted transition-colors hover:text-ink">
        <ArrowLeft size={13} /> All invoices
      </Link>

      <PageHeader
        title={isNew ? 'New tax invoice' : invoice?.number ?? 'Invoice'}
        description={
          isNew
            ? 'Carries every field the UAE FTA requires on a tax invoice. VAT is charged per line.'
            : `${label} · ${invoice?.account.name} · issued ${date(invoice?.issueDate)}`
        }
        actions={
          <>
            {!isNew ? (
              <>
                <Button icon={<FileDown size={14} />} onClick={() => download(`/invoices/${id}/pdf`, `${invoice?.number}.pdf`).catch((err) => toast.push(err.message, 'error'))}>PDF</Button>
                {can('invoices', 'update') ? <Button icon={<Mail size={14} />} onClick={() => setSending(true)}>Email</Button> : null}
              </>
            ) : null}
            {!isNew && !isCredit && posted && can('invoices', 'update') ? (
              <Button icon={<Banknote size={14} />} onClick={() => setPaying(true)}>Record receipt</Button>
            ) : null}
            {!isNew && !isCredit && posted && can('invoices', 'create') ? (
              <Button icon={<Undo2 size={14} />} onClick={() => setCrediting(true)}>Credit note</Button>
            ) : null}
            {!locked && can('invoices', isNew ? 'create' : 'update') ? (
              <Button variant="accent" icon={<Save size={14} />} loading={save.isPending} disabled={!form.accountId} onClick={() => save.mutate()}>
                {isNew ? 'Create draft' : 'Save'}
              </Button>
            ) : null}
            {!isNew && invoice?.status === 'DRAFT' && can('invoices', 'delete') ? (
              <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Delete</Button>
            ) : null}
          </>
        }
      />

      {error ? <div className="mb-3"><ErrorNote error={error} /></div> : null}

      {invoice?.complianceGaps?.length ? (
        <Card className="mb-3 border-[var(--red-300)] bg-accent-soft">
          <div className="flex items-start gap-2 px-4 py-3">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-accent" />
            <div>
              <p className="text-[13px] font-semibold text-[var(--red-700)]">Before you send this</p>
              <ul className="mt-1 space-y-0.5 text-[12px] text-[var(--red-700)]">
                {invoice.complianceGaps.map((gap) => <li key={gap.message}>· {gap.message}{gap.blocking ? ' (must be fixed before issuing)' : ''}</li>)}
              </ul>
            </div>
          </div>
        </Card>
      ) : null}

      {invoice ? (
        <Card className="mb-3">
          <LifecycleRail
            track={invoiceTrack(invoice.status)}
            disabled={setStatus.isPending}
            onStep={
              can('invoices', 'update')
                ? (key) =>
                    // Part paid and paid are consequences of a receipt, never a manual flip.
                    key === 'DRAFT' || key === 'SENT'
                      ? setStatus.mutate(key)
                      : toast.push('Record the receipt — Zeus moves the invoice there itself.')
                : undefined
            }
            hint={{
              ...invoiceHint(invoice),
              cta:
                invoice.status === 'DRAFT' && can('invoices', 'update')
                  ? { label: 'Issue it', loading: setStatus.isPending, onClick: () => setStatus.mutate('SENT') }
                  : !isCredit && posted && outstanding > 0 && can('invoices', 'update')
                    ? { label: 'Record receipt', onClick: () => setPaying(true) }
                    : undefined,
            }}
            meta={
              <>
                <StatusPill status={invoice.status} />
                {!isCredit && outstanding > 0 && posted ? (
                  <span className="text-[12px] text-muted">
                    Outstanding <strong className="tabular text-[13px] text-accent">{money(outstanding)}</strong>
                  </span>
                ) : null}
                {can('invoices', 'update') && invoice.status !== 'CANCELLED' && !posted ? (
                  <button
                    onClick={() => setStatus.mutate('CANCELLED')}
                    className="text-[11px] font-semibold uppercase tracking-[0.06em] text-n400 underline decoration-dotted underline-offset-2 transition-colors hover:text-accent"
                  >
                    Cancel
                  </button>
                ) : null}
              </>
            }
          />
          {posted ? (
            <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
              Figures are locked now that the document is issued — raise a credit note to correct it.
            </p>
          ) : null}
          {!isCredit && invoice.status === 'DRAFT' ? (
            <ApprovalBar
              entity="invoices"
              id={invoice.id}
              module="invoices"
              record={invoice}
              onChanged={() => void queryClient.invalidateQueries({ queryKey: ['invoice', id] })}
            />
          ) : null}

          {invoice.originalInvoice ? (
            <div className="border-t border-line bg-sunken px-4 py-2.5 text-[12px]">
              Credits <Link to={`/invoices/${invoice.originalInvoice.id}`} className="font-semibold underline decoration-dotted underline-offset-2">{invoice.originalInvoice.number}</Link>
              {invoice.creditReason ? <> — {invoice.creditReason}</> : null}
            </div>
          ) : null}
          {invoice.creditNotes.length > 0 ? (
            <div className="border-t border-line bg-sunken px-4 py-2.5 text-[12px]">
              Credited by{' '}
              {invoice.creditNotes.map((note, i) => (
                <span key={note.id}>
                  {i > 0 ? ', ' : ''}
                  <Link to={`/invoices/${note.id}`} className="font-semibold underline decoration-dotted underline-offset-2">{note.number}</Link> ({money(note.total)})
                </span>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Parties & dates" subtitle={posted ? 'Frozen at issue — this is what appears on the filed document' : 'Both TRNs are printed on the tax invoice'} />
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
              <Field label="Bill to" required hint={invoice?.recipientTrn ? `TRN ${invoice.recipientTrn}` : invoice?.account.trn ? `TRN ${invoice.account.trn}` : 'No TRN on this account.'}>
                <AccountPicker
                  value={form.accountId || null}
                  selectedLabel={form.accountLabel}
                  onChange={(id, row) => setForm({ ...form, accountId: id ?? '', accountLabel: row?.name ?? null, contactId: '' })}
                />
              </Field>
              <Field label="Attention of">
                <ContactPicker
                  value={form.contactId || null}
                  accountId={form.accountId || null}
                  selectedLabel={invoice?.contact ? `${invoice.contact.firstName} ${invoice.contact.lastName}` : null}
                  onChange={(id) => setForm({ ...form, contactId: id ?? '' })}
                />
              </Field>

              <Field label="Invoice date" required>
                <Input type="date" value={form.issueDate} disabled={locked} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} />
              </Field>
              <Field label="Date of supply" hint="Only printed when it differs from the invoice date.">
                <Input type="date" value={form.supplyDate} disabled={locked} onChange={(e) => setForm({ ...form, supplyDate: e.target.value })} />
              </Field>

              {!isCredit ? (
                <Field label="Payment due">
                  <Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
                </Field>
              ) : null}
              <Field label="Place of supply" hint="The emirate in which the supply took place.">
                <ListSelect listKey="lists.emirates" value={form.placeOfSupply} onChange={(v) => setForm({ ...form, placeOfSupply: v })} placeholder="—" />
              </Field>

              <Field label="Customer PO">
                {invoice?.customerPo ? (
                  <Link to={`/purchase-orders/${invoice.customerPo.id}`} className="block truncate rounded-sharp border border-line bg-sunken px-3 py-2 text-[13px] underline decoration-dotted underline-offset-2">
                    {invoice.customerPo.number}
                  </Link>
                ) : (
                  <Lookup<{ id: string; number: string; account: { name: string } }>
                    value={form.customerPoId || null}
                    onChange={(id) => setForm({ ...form, customerPoId: id ?? '' })}
                    endpoint="/purchase-orders"
                    extraParams={{ direction: 'CUSTOMER' }}
                    placeholder="Link their PO…"
                    render={(row) => ({ primary: row.number, secondary: row.account.name })}
                  />
                )}
              </Field>
              <Field label="Their reference" hint="Free text, if there is no PO record.">
                <Input value={form.poNumber} onChange={(e) => setForm({ ...form, poNumber: e.target.value })} />
              </Field>

              <Field label="Currency">
                <Select
                  value={form.currency}
                  disabled={locked}
                  onChange={(e) => setForm({ ...form, currency: e.target.value })}
                  options={['AED', 'USD', 'EUR', 'GBP', 'SAR'].map((c) => ({ value: c, label: c }))}
                />
              </Field>
              {form.currency !== 'AED' ? (
                <Field label="Exchange rate to AED" required hint="Central Bank rate. AED equivalents are printed on the invoice.">
                  <Input type="number" step="0.0001" value={form.exchangeRate} disabled={locked} onChange={(e) => setForm({ ...form, exchangeRate: e.target.value })} />
                </Field>
              ) : null}

              <div className="sm:col-span-2">
                <Checkbox
                  label="Reverse charge — the recipient accounts for the VAT"
                  checked={form.reverseCharge}
                  disabled={locked}
                  onChange={(checked) => setForm({ ...form, reverseCharge: checked })}
                />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Line items" subtitle="Each line carries its own VAT rate, as the FTA requires" />
            <LineEditor lines={lines} onChange={setLines} locked={locked} showCost={showCost} defaultVat={defaultVat} headerDiscountPct={form.discountPct} dealId={form.dealId || null} currency={form.currency} />
          </Card>

          <Card>
            <CardHeader title="Terms & notes" />
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
              <Field label="Terms"><Textarea rows={4} value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} /></Field>
              <Field label="Notes"><Textarea rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-3 xl:sticky xl:top-4 xl:self-start">
          <Card>
            <CardHeader title="Totals" subtitle={form.currency} />
            <div className="space-y-2 px-4 py-4 text-[13px]">
              <Row label="Subtotal" value={money(totals.subtotal, true)} />
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-muted">
                  Discount
                  <Input className="w-16 px-1.5 py-0.5 text-right text-[12px]" type="number" min="0" max="100" step="0.5"
                    value={form.discountPct} disabled={locked} onChange={(e) => setForm({ ...form, discountPct: Number(e.target.value) })} />
                  %
                </span>
                <span className="tabular">− {money(totals.discountAmt, true)}</span>
              </div>
              <Row label="Taxable amount" value={money(totals.netAfterDiscount, true)} strong />
              <Row label="Total VAT" value={money(totals.vatAmount, true)} />

              <div className="mt-2 flex items-center justify-between gap-2 bg-n950 px-3 py-2.5 text-white">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em]">{isCredit ? 'Total credited' : 'Total payable'}</span>
                <span className="tabular text-[17px] font-bold">{money(totals.total, true)}</span>
              </div>

              {showCost ? (
                <div className="mt-3 border-t border-line pt-3">
                  <Row label="Cost" value={money(totals.totalCost, true)} />
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-muted">Margin</span>
                    <span className={cx('tabular font-semibold', totals.marginPct < 10 ? 'text-accent' : totals.marginPct < 20 ? 'text-watch' : 'text-secure')}>
                      {money(totals.marginAmount, true)} · {percent(totals.marginPct, 1)}
                    </span>
                  </div>
                </div>
              ) : null}

              {form.currency !== 'AED' && form.exchangeRate ? (
                <p className="mt-3 border-t border-line pt-3 text-[11px] text-muted">
                  AED equivalent: <strong className="text-ink">{money(totals.total * Number(form.exchangeRate), true)}</strong> at {Number(form.exchangeRate).toFixed(4)}
                </p>
              ) : null}
            </div>
          </Card>

          {invoice && !isCredit ? (
            <Card>
              <CardHeader
                title="Receipts"
                subtitle={`${money(Number(invoice.amountPaid))} of ${money(Number(invoice.total))}`}
                actions={can('invoices', 'update') && posted ? <Button size="sm" onClick={() => setPaying(true)}>Add</Button> : undefined}
              />
              <PaymentLedger payments={invoice.payments} currency={invoice.currency} onDeleted={() => queryClient.invalidateQueries({ queryKey: ['invoice', id] })} />
            </Card>
          ) : null}
        </div>
      </div>

      {paying && invoice ? (
        <RecordPaymentModal
          direction="INCOMING"
          invoiceId={invoice.id}
          documentNumber={invoice.number}
          outstanding={outstanding}
          onClose={() => setPaying(false)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['invoice', id] })}
        />
      ) : null}

      {crediting && invoice ? <CreditNoteModal invoice={invoice} onClose={() => setCrediting(false)} /> : null}
      {sending && invoice ? <SendInvoiceModal invoice={invoice} label={label} onClose={() => setSending(false)} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete this draft?"
        confirmLabel="Delete draft"
        message="Only a draft can be deleted. Once issued, the number stays in the sequence and you cancel or credit instead."
      />
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className={cx('tabular', strong && 'font-semibold')}>{value}</span>
    </div>
  );
}

function CreditNoteModal({ invoice, onClose }: { invoice: InvoiceFull; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [full, setFull] = useState(true);
  const [lines, setLines] = useState<EditableLine[]>(
    invoice.lines.map((l) => ({
      key: l.id, productId: l.productId, description: l.description,
      quantity: Number(l.quantity), unit: l.unit, unitPrice: Number(l.unitPrice),
      unitCost: Number(l.unitCost), discountPct: Number(l.discountPct),
      taxable: l.taxable, vatRate: Number(l.vatRate),
    })),
  );
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => previewTotals(lines, Number(invoice.discountPct)), [lines, invoice.discountPct]);

  const create = useMutation({
    mutationFn: () =>
      api.post<InvoiceFull>(`/invoices/${invoice.id}/credit-note`, {
        reason,
        lines: full
          ? undefined
          : lines.filter((l) => l.description.trim() && l.quantity > 0).map((l) => ({
              productId: l.productId, description: l.description.trim(), quantity: l.quantity,
              unit: l.unit, unitPrice: l.unitPrice, unitCost: l.unitCost ?? 0,
              discountPct: l.discountPct, taxable: l.taxable, vatRate: l.taxable ? l.vatRate : 0,
            })),
      }),
    onSuccess: (note) => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      toast.push(`${note.number} raised.`);
      navigate(`/invoices/${note.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not raise the credit note.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Raise a tax credit note"
      subtitle={`Against ${invoice.number} · ${money(Number(invoice.total))}`}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!reason.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Raise credit note
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}

        <p className="text-[13px] leading-relaxed text-n600">
          The FTA requires a credit note to reduce the value of an issued tax invoice — a return, a
          cancellation or a post-invoice discount. It gets its own number and references {invoice.number}.
        </p>

        <Field label="Reason" required hint="Printed on the document.">
          <Input value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="e.g. 200 endpoints returned unused" />
        </Field>

        <div className="flex gap-2">
          <button
            onClick={() => setFull(true)}
            className={cx('flex-1 rounded-sharp border px-3 py-2 text-left text-[12px] transition-colors', full ? 'border-n950 bg-n950 text-white' : 'border-line bg-white hover:border-n900')}
          >
            <span className="block font-semibold">Full reversal</span>
            <span className={cx('block text-[11px]', full ? 'text-white/70' : 'text-muted')}>Credits the whole {money(Number(invoice.total))}</span>
          </button>
          <button
            onClick={() => setFull(false)}
            className={cx('flex-1 rounded-sharp border px-3 py-2 text-left text-[12px] transition-colors', !full ? 'border-n950 bg-n950 text-white' : 'border-line bg-white hover:border-n900')}
          >
            <span className="block font-semibold">Partial credit</span>
            <span className={cx('block text-[11px]', !full ? 'text-white/70' : 'text-muted')}>Edit the lines below</span>
          </button>
        </div>

        {!full ? (
          <div className="border border-line">
            <LineEditor lines={lines} onChange={setLines} defaultVat={Number(invoice.vatRate)} />
            <div className="flex items-center justify-between border-t border-line bg-sunken px-4 py-2.5">
              <span className="text-[12px] text-muted">Credit total</span>
              <span className="tabular text-[15px] font-bold">{money(totals.total, true)}</span>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function SendInvoiceModal({ invoice, label, onClose }: { invoice: InvoiceFull; label: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [to, setTo] = useState(invoice.contact?.email ?? '');
  const [cc, setCc] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () =>
      api.post(`/invoices/${invoice.id}/send`, {
        to: to.split(',').map((s) => s.trim()).filter(Boolean),
        cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
        message: message || undefined,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', invoice.id] });
      toast.push(`${label} sent.`);
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not send it.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Email ${invoice.number}`}
      subtitle="Sent from the shared mailbox with the PDF attached."
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
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="accounts@customer.ae" />
        </Field>
        <Field label="CC"><Input value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
        <Field label="Message">
          <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Leave blank for the standard covering note." />
        </Field>
      </div>
    </Modal>
  );
}
