import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, FileDown, Mail, PackageCheck, Save, Trash2 } from 'lucide-react';
import { api, ApiError, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateInput, money } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, ErrorNote, Field, Input, Loading,
  Modal, PageHeader, Select, Textarea, cx, useToast,
} from '../components/ui';
import { AccountPicker, ContactPicker, Lookup } from '../components/pickers';
import { LineEditor, blankLine, previewTotals, type EditableLine } from '../components/lineEditor';
import { PaymentLedger, RecordPaymentModal, type PaymentRecord } from '../components/payments';
import { AttachmentPanel } from '../components/attachments';
import { LifecycleRail, poHint, poTrack } from '../components/lifecycle';
import { ApprovalBar, type ApprovalState } from '../components/approvals';

interface PoFull extends ApprovalState {
  id: string; number: string; direction: 'CUSTOMER' | 'SUPPLIER'; status: string;
  orderDate: string; expectedDate: string | null; paymentDueDate: string | null; paymentTermsDays: number | null;
  currency: string; discountPct: string | number; vatRate: string | number;
  subtotal: string | number; discountAmt: string | number; vatAmount: string | number;
  total: string | number; amountPaid: string | number;
  supplierInvoiceNumber: string | null; supplierInvoiceDate: string | null;
  shipToAddress: string | null; terms: string | null; notes: string | null; issuedAt: string | null;
  account: { id: string; name: string };
  contact: { id: string; firstName: string; lastName: string } | null;
  deal: { id: string; reference: string; name: string } | null;
  quote: { id: string; number: string } | null;
  owner: { id: string; name: string } | null;
  lines: Array<{ id: string; productId: string | null; description: string; quantity: string | number; quantityReceived: string | number; unit: string; unitPrice: string | number; discountPct: string | number; taxable: boolean; vatRate: string | number }>;
  payments: PaymentRecord[];
}


export default function PurchaseOrderEditor() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();

  const isNew = !id;
  const [direction, setDirection] = useState<'CUSTOMER' | 'SUPPLIER'>((params.get('direction') as 'CUSTOMER' | 'SUPPLIER') ?? 'SUPPLIER');

  const [form, setForm] = useState({
    number: '',
    accountId: params.get('accountId') ?? '',
    accountLabel: null as string | null,
    contactId: '',
    dealId: params.get('dealId') ?? '',
    orderDate: dateInput(new Date()),
    expectedDate: '',
    paymentTermsDays: '30',
    paymentDueDate: '',
    discountPct: 0,
    supplierInvoiceNumber: '',
    supplierInvoiceDate: '',
    shipToAddress: '',
    terms: '',
    notes: '',
  });
  const [lines, setLines] = useState<EditableLine[]>([blankLine()]);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [sending, setSending] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: po, isLoading } = useQuery({
    queryKey: ['purchase-order', id],
    enabled: !isNew,
    queryFn: () => api.get<PoFull>(`/purchase-orders/${id}`),
  });

  const { data: settings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.get<Record<string, unknown>>('/settings/public'),
    staleTime: 300_000,
  });
  const defaultVat = Number(settings?.['finance.vatRate'] ?? 5);

  useEffect(() => {
    if (!po) return;
    setDirection(po.direction);
    setForm({
      number: po.number,
      accountId: po.account.id,
      accountLabel: po.account.name,
      contactId: po.contact?.id ?? '',
      dealId: po.deal?.id ?? '',
      orderDate: dateInput(po.orderDate),
      expectedDate: dateInput(po.expectedDate),
      paymentTermsDays: po.paymentTermsDays !== null ? String(po.paymentTermsDays) : '',
      paymentDueDate: dateInput(po.paymentDueDate),
      discountPct: Number(po.discountPct),
      supplierInvoiceNumber: po.supplierInvoiceNumber ?? '',
      supplierInvoiceDate: dateInput(po.supplierInvoiceDate),
      shipToAddress: po.shipToAddress ?? '',
      terms: po.terms ?? '',
      notes: po.notes ?? '',
    });
    setLines(
      po.lines.length
        ? po.lines.map((l) => ({
            key: l.id, productId: l.productId, description: l.description,
            quantity: Number(l.quantity), unit: l.unit, unitPrice: Number(l.unitPrice),
            discountPct: Number(l.discountPct), taxable: l.taxable, vatRate: Number(l.vatRate),
          }))
        : [blankLine(defaultVat)],
    );
  }, [po, defaultVat]);

  const totals = useMemo(() => previewTotals(lines, form.discountPct), [lines, form.discountPct]);
  const isSupplier = direction === 'SUPPLIER';
  const locked = po ? ['CANCELLED', 'CLOSED'].includes(po.status) : false;
  const outstanding = po ? Number(po.total) - Number(po.amountPaid) : 0;

  const payload = () => ({
    direction,
    ...(direction === 'CUSTOMER' ? { number: form.number.trim() } : {}),
    accountId: form.accountId,
    contactId: form.contactId || null,
    dealId: form.dealId || null,
    orderDate: form.orderDate,
    expectedDate: form.expectedDate || null,
    paymentTermsDays: form.paymentTermsDays === '' ? null : Number(form.paymentTermsDays),
    paymentDueDate: form.paymentDueDate || null,
    discountPct: form.discountPct,
    supplierInvoiceNumber: form.supplierInvoiceNumber || null,
    supplierInvoiceDate: form.supplierInvoiceDate || null,
    shipToAddress: form.shipToAddress || null,
    terms: form.terms || null,
    notes: form.notes || null,
    lines: lines.filter((l) => l.description.trim()).map((l) => ({
      productId: l.productId, description: l.description.trim(), quantity: l.quantity,
      unit: l.unit, unitPrice: l.unitPrice, discountPct: l.discountPct,
      taxable: l.taxable, vatRate: l.taxable ? l.vatRate : 0,
    })),
  });

  const save = useMutation({
    mutationFn: () => (isNew ? api.post<PoFull>('/purchase-orders', payload()) : api.patch<PoFull>(`/purchase-orders/${id}`, payload())),
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      void queryClient.invalidateQueries({ queryKey: ['purchase-order', saved.id] });
      toast.push(isNew ? `${saved.number} saved.` : 'Purchase order saved.');
      if (isNew) navigate(`/purchase-orders/${saved.id}`, { replace: true });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => api.post(`/purchase-orders/${id}/status`, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-order', id] });
      void queryClient.invalidateQueries({ queryKey: ['cash-position'] });
      toast.push('Status updated.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not update.', 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/purchase-orders/${id}`),
    onSuccess: () => { toast.push('Purchase order removed.'); navigate('/purchase-orders'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not remove it.', 'error'),
  });

  if (!isNew && isLoading) return <Loading />;

  return (
    <>
      <Link to="/purchase-orders" className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted transition-colors hover:text-ink">
        <ArrowLeft size={13} /> All purchase orders
      </Link>

      <PageHeader
        title={isNew ? (isSupplier ? 'New supplier purchase order' : 'Record a customer purchase order') : po?.number ?? 'Purchase order'}
        description={
          isNew
            ? isSupplier
              ? 'What you are buying from the vendor. The payment terms here create the payable Zeus reminds you about.'
              : "Their document, their number. Attach the scan so the order is evidenced against the deal."
            : `${po?.account.name} · ordered ${date(po?.orderDate)}${po?.deal ? ` · ${po.deal.reference}` : ''}`
        }
        actions={
          <>
            {!isNew && isSupplier ? (
              <>
                <Button icon={<FileDown size={14} />} onClick={() => download(`/purchase-orders/${id}/pdf`, `${po?.number}.pdf`).catch((err) => toast.push(err.message, 'error'))}>PDF</Button>
                {can('invoices', 'update') ? <Button icon={<Mail size={14} />} onClick={() => setSending(true)}>Email</Button> : null}
              </>
            ) : null}
            {!isNew && isSupplier && can('invoices', 'update') && po?.status !== 'DRAFT' ? (
              <Button icon={<Banknote size={14} />} onClick={() => setPaying(true)}>Record payment</Button>
            ) : null}
            {!isNew && isSupplier && can('invoices', 'update') ? (
              <Button icon={<PackageCheck size={14} />} onClick={() => setReceiving(true)}>Receive goods</Button>
            ) : null}
            {can('invoices', locked ? 'create' : 'update') && !locked ? (
              <Button variant="accent" icon={<Save size={14} />} loading={save.isPending} disabled={!form.accountId || (direction === 'CUSTOMER' && !form.number.trim())} onClick={() => save.mutate()}>
                {isNew ? 'Create' : 'Save'}
              </Button>
            ) : null}
            {!isNew && can('invoices', 'delete') ? <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Delete</Button> : null}
          </>
        }
      />

      {error ? <div className="mb-3"><ErrorNote error={error} /></div> : null}

      {po ? (
        <Card className="mb-3">
          <LifecycleRail
            title={isSupplier ? 'Order lifecycle' : "Customer's order"}
            track={poTrack(po.status)}
            disabled={setStatus.isPending}
            onStep={can('invoices', 'update') ? (key) => setStatus.mutate(key) : undefined}
            hint={{
              ...poHint(po),
              cta: !can('invoices', 'update')
                ? undefined
                : po.status === 'DRAFT'
                  ? { label: isSupplier ? 'Issue it' : 'Mark issued', loading: setStatus.isPending, onClick: () => setStatus.mutate('ISSUED') }
                  : isSupplier && outstanding > 0 && (po.status === 'RECEIVED' || po.status === 'PARTIALLY_RECEIVED')
                    ? { label: 'Record payment', onClick: () => setPaying(true) }
                    : isSupplier && (po.status === 'ISSUED' || po.status === 'ACKNOWLEDGED')
                      ? { label: 'Receive goods', onClick: () => setReceiving(true) }
                      : !isSupplier && po.deal
                        ? { label: 'Raise invoice', to: `/invoices/new?accountId=${po.account.id}&dealId=${po.deal.id}` }
                        : undefined,
            }}
            meta={
              <>
                {outstanding > 0 && po.status !== 'DRAFT' ? (
                  <span className="text-[12px] text-muted">
                    Outstanding <strong className="tabular text-[13px] text-accent">{money(outstanding)}</strong>
                    {po.paymentDueDate ? <span className="ml-2">due {date(po.paymentDueDate)}</span> : null}
                  </span>
                ) : po.status !== 'DRAFT' ? (
                  <Badge tone="secure">Settled</Badge>
                ) : null}
                {can('invoices', 'update') && !locked ? (
                  <button
                    onClick={() => setStatus.mutate('CANCELLED')}
                    className="text-[11px] font-semibold uppercase tracking-[0.06em] text-n400 underline decoration-dotted underline-offset-2 transition-colors hover:text-accent"
                  >
                    Cancel order
                  </button>
                ) : null}
              </>
            }
          />
          {isSupplier && po.status === 'DRAFT' ? (
            <ApprovalBar
              entity="purchase-orders"
              id={po.id}
              module="invoices"
              record={po}
              onChanged={() => void queryClient.invalidateQueries({ queryKey: ['purchase-order', id] })}
            />
          ) : null}
        </Card>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title={isSupplier ? 'Supplier' : 'Customer'} />
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
              {isNew ? (
                <Field label="Direction" hint="Fixed once saved.">
                  <Select
                    value={direction}
                    onChange={(e) => setDirection(e.target.value as 'CUSTOMER' | 'SUPPLIER')}
                    options={[
                      { value: 'SUPPLIER', label: 'Issued to a supplier' },
                      { value: 'CUSTOMER', label: 'Received from a customer' },
                    ]}
                  />
                </Field>
              ) : null}

              <Field
                label={isSupplier ? 'PO number' : "Customer's PO number"}
                required={!isSupplier}
                hint={isSupplier ? 'Allocated automatically on save.' : 'Exactly as printed on their document.'}
              >
                <Input
                  value={isSupplier && isNew ? '' : form.number}
                  placeholder={isSupplier ? 'ZEU-PO-000001' : 'e.g. ENBD-PO-77120'}
                  disabled={isSupplier}
                  onChange={(e) => setForm({ ...form, number: e.target.value })}
                />
              </Field>

              <Field label={isSupplier ? 'Vendor' : 'Customer'} required>
                <AccountPicker
                  value={form.accountId || null}
                  type={isSupplier ? 'VENDOR' : undefined}
                  selectedLabel={form.accountLabel}
                  onChange={(id, row) => setForm({ ...form, accountId: id ?? '', accountLabel: row?.name ?? null, contactId: '' })}
                  placeholder={isSupplier ? 'Search vendors…' : 'Search customers…'}
                />
              </Field>

              <Field label="Contact">
                <ContactPicker
                  value={form.contactId || null}
                  accountId={form.accountId || null}
                  selectedLabel={po?.contact ? `${po.contact.firstName} ${po.contact.lastName}` : null}
                  onChange={(id) => setForm({ ...form, contactId: id ?? '' })}
                />
              </Field>

              <Field label="Linked deal">
                {po?.deal ? (
                  <Link to={`/deals/${po.deal.id}`} className="block truncate rounded-sharp border border-line bg-sunken px-3 py-2 text-[13px] underline decoration-dotted underline-offset-2">
                    {po.deal.reference} · {po.deal.name}
                  </Link>
                ) : (
                  <Lookup<{ id: string; reference: string; name: string; account: { name: string } }>
                    value={form.dealId || null}
                    onChange={(id) => setForm({ ...form, dealId: id ?? '' })}
                    endpoint="/deals"
                    placeholder="Search deals…"
                    render={(row) => ({ primary: `${row.reference} · ${row.name}`, secondary: row.account.name })}
                  />
                )}
              </Field>

              <Field label="Order date">
                <Input type="date" value={form.orderDate} disabled={locked} onChange={(e) => setForm({ ...form, orderDate: e.target.value })} />
              </Field>

              {isSupplier ? (
                <>
                  <Field label="Required by">
                    <Input type="date" value={form.expectedDate} disabled={locked} onChange={(e) => setForm({ ...form, expectedDate: e.target.value })} />
                  </Field>
                  <Field label="Payment terms (days)" hint="Sets the date Zeus reminds you to pay.">
                    <Input
                      type="number" min="0" value={form.paymentTermsDays} disabled={locked}
                      onChange={(e) => {
                        const days = e.target.value;
                        const base = form.orderDate ? new Date(form.orderDate) : new Date();
                        setForm({
                          ...form,
                          paymentTermsDays: days,
                          paymentDueDate: days === '' ? '' : dateInput(new Date(base.getTime() + Number(days) * 86_400_000)),
                        });
                      }}
                    />
                  </Field>
                  <Field label="Payment due">
                    <Input type="date" value={form.paymentDueDate} disabled={locked} onChange={(e) => setForm({ ...form, paymentDueDate: e.target.value })} />
                  </Field>
                  <Field label="Vendor invoice number" hint="Fill in when their bill arrives.">
                    <Input value={form.supplierInvoiceNumber} disabled={locked} onChange={(e) => setForm({ ...form, supplierInvoiceNumber: e.target.value })} />
                  </Field>
                  <Field label="Vendor invoice date">
                    <Input type="date" value={form.supplierInvoiceDate} disabled={locked} onChange={(e) => setForm({ ...form, supplierInvoiceDate: e.target.value })} />
                  </Field>
                </>
              ) : null}
            </div>
          </Card>

          <Card>
            <CardHeader title="Line items" subtitle={isSupplier ? 'Priced at what you pay the vendor' : 'As stated on their order'} />
            <LineEditor
              lines={lines}
              onChange={setLines}
              locked={locked}
              defaultVat={defaultVat}
              costFromCatalog={isSupplier}
              priceLabel={isSupplier ? 'Buy price' : 'Unit price'}
              headerDiscountPct={form.discountPct}
              dealId={form.dealId || po?.deal?.id || null}
              vendorId={form.accountId || null}
              currency={po?.currency ?? 'AED'}
            />
          </Card>

          {!isNew ? (
            <Card>
              <CardHeader title="Files" subtitle={isSupplier ? 'Vendor acknowledgement, delivery note' : "The customer's signed PO" } />
              <AttachmentPanel parent="account" parentId={po!.account.id} />
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Terms & notes" />
            <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
              {isSupplier ? (
                <Field label="Ship to" hint="Defaults to your company address on the printed order.">
                  <Textarea rows={3} value={form.shipToAddress} disabled={locked} onChange={(e) => setForm({ ...form, shipToAddress: e.target.value })} />
                </Field>
              ) : null}
              <Field label="Terms">
                <Textarea rows={3} value={form.terms} disabled={locked} onChange={(e) => setForm({ ...form, terms: e.target.value })} />
              </Field>
              <Field label="Notes" className={isSupplier ? undefined : 'sm:col-span-2'}>
                <Textarea rows={3} value={form.notes} disabled={locked} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </Field>
            </div>
          </Card>
        </div>

        <div className="flex flex-col gap-3 xl:sticky xl:top-4 xl:self-start">
          <Card>
            <CardHeader title="Totals" subtitle={po?.currency ?? 'AED'} />
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
              <Row label="VAT" value={money(totals.vatAmount, true)} />
              <div className="mt-2 flex items-center justify-between gap-2 bg-n950 px-3 py-2.5 text-white">
                <span className="text-[10px] font-bold uppercase tracking-[0.12em]">Order total</span>
                <span className="tabular text-[17px] font-bold">{money(totals.total, true)}</span>
              </div>
              <p className="pt-1 text-[11px] text-muted">VAT is charged per line, so a zero-rated item never picks up tax.</p>
            </div>
          </Card>

          {po && isSupplier ? (
            <Card>
              <CardHeader
                title="Payments out"
                subtitle={`${money(Number(po.amountPaid))} of ${money(Number(po.total))}`}
                actions={can('invoices', 'update') && po.status !== 'DRAFT' ? <Button size="sm" onClick={() => setPaying(true)}>Add</Button> : undefined}
              />
              <PaymentLedger payments={po.payments} currency={po.currency} onDeleted={() => queryClient.invalidateQueries({ queryKey: ['purchase-order', id] })} />
            </Card>
          ) : null}
        </div>
      </div>

      {paying && po ? (
        <RecordPaymentModal
          direction="OUTGOING"
          purchaseOrderId={po.id}
          documentNumber={po.number}
          outstanding={outstanding}
          onClose={() => setPaying(false)}
          onSaved={() => queryClient.invalidateQueries({ queryKey: ['purchase-order', id] })}
        />
      ) : null}

      {receiving && po ? <ReceiveModal po={po} onClose={() => setReceiving(false)} /> : null}
      {sending && po ? <SendPoModal po={po} onClose={() => setSending(false)} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Remove this purchase order?"
        confirmLabel="Remove"
        message={<>{po?.number} will be archived. Orders with payments recorded against them cannot be removed.</>}
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

function ReceiveModal({ po, onClose }: { po: PoFull; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [received, setReceived] = useState<Record<string, number>>(
    Object.fromEntries(po.lines.map((l) => [l.id, Number(l.quantityReceived)])),
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${po.id}/receive`, {
      received: Object.entries(received).map(([lineId, quantityReceived]) => ({ lineId, quantityReceived })),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-order', po.id] });
      toast.push('Goods receipt recorded.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not record it.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Receive goods"
      subtitle={`${po.number} · mark what has physically arrived`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={save.isPending} onClick={() => save.mutate()}>Save receipt</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        {po.lines.map((line) => (
          <div key={line.id} className="grid grid-cols-[1fr_110px_110px] items-end gap-3 border-b border-line pb-3 last:border-0">
            <span className="text-[13px]">
              <span className="block font-semibold">{line.description}</span>
              <span className="block text-[11px] text-muted">Ordered {Number(line.quantity)} {line.unit}</span>
            </span>
            <Field label="Received">
              <Input
                type="number" min="0" max={Number(line.quantity)} step="1"
                value={received[line.id] ?? 0}
                onChange={(e) => setReceived({ ...received, [line.id]: Number(e.target.value) })}
              />
            </Field>
            <Button size="sm" variant="ghost" onClick={() => setReceived({ ...received, [line.id]: Number(line.quantity) })}>
              All in
            </Button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function SendPoModal({ po, onClose }: { po: PoFull; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: () => api.post(`/purchase-orders/${po.id}/send`, {
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      message: message || undefined,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['purchase-order', po.id] });
      toast.push('Purchase order sent.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not send it.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Email ${po.number}`}
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
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="orders@vendor.com" />
        </Field>
        <Field label="Message">
          <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Leave blank for the standard covering note." />
        </Field>
      </div>
    </Modal>
  );
}
