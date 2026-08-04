import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Banknote, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money } from '../lib/format';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Modal, Textarea, cx, useToast } from './ui';
import { ListSelect } from './pickers';

export interface PaymentRecord {
  id: string;
  direction: 'INCOMING' | 'OUTGOING';
  amount: string | number;
  currency: string;
  method: string;
  reference: string | null;
  paidAt: string;
  notes: string | null;
  recordedBy: { name: string } | null;
}

/**
 * Record a receipt or a disbursement. The server derives the document balance from
 * these rows, so a part-payment needs no manual maths anywhere.
 */
export function RecordPaymentModal({
  direction, invoiceId, purchaseOrderId, documentNumber, outstanding, onClose, onSaved,
}: {
  direction: 'INCOMING' | 'OUTGOING';
  invoiceId?: string;
  purchaseOrderId?: string;
  documentNumber: string;
  outstanding: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const [amount, setAmount] = useState(outstanding > 0 ? String(outstanding) : '');
  const [method, setMethod] = useState('Bank Transfer');
  const [reference, setReference] = useState('');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmOver, setConfirmOver] = useState(false);

  const save = useMutation({
    mutationFn: (allowOverpayment: boolean) =>
      api.post('/payments', {
        direction,
        invoiceId: invoiceId ?? null,
        purchaseOrderId: purchaseOrderId ?? null,
        amount: Number(amount || 0),
        method,
        reference: reference || null,
        paidAt,
        notes: notes || null,
        allowOverpayment,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      void queryClient.invalidateQueries({ queryKey: ['cash-position'] });
      toast.push(direction === 'INCOMING' ? 'Receipt recorded.' : 'Payment recorded.');
      onSaved();
      onClose();
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : 'Could not record the payment.';
      // The server challenges an overpayment rather than silently accepting it.
      if (message.includes('more than the')) { setConfirmOver(true); setError(message); }
      else setError(message);
    },
  });

  const value = Number(amount || 0);
  const over = value > outstanding + 0.009;

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={direction === 'INCOMING' ? 'Record a receipt' : 'Record a payment'}
        subtitle={`${documentNumber} · ${money(outstanding)} outstanding`}
        width="sm"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="accent" disabled={value <= 0} loading={save.isPending} onClick={() => save.mutate(false)}>
              {direction === 'INCOMING' ? 'Record receipt' : 'Record payment'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {error && !confirmOver ? <ErrorNote error={error} /> : null}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Amount (AED)"
              required
              hint={over ? 'More than the balance outstanding.' : outstanding > 0 ? `Leaves ${money(outstanding - value)} outstanding.` : undefined}
            >
              <Input type="number" min="0" step="0.01" value={amount} autoFocus onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Date received">
              <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Method">
              <ListSelect listKey="lists.paymentMethods" value={method} onChange={setMethod} />
            </Field>
            <Field label="Reference" hint="Bank reference or cheque number.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="FT26072800112" />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmOver}
        onClose={() => { setConfirmOver(false); setError(null); }}
        onConfirm={() => { setConfirmOver(false); save.mutate(true); }}
        loading={save.isPending}
        danger={false}
        title="More than the balance"
        confirmLabel="Record it anyway"
        message={<>{money(value)} exceeds the {money(outstanding)} outstanding on {documentNumber}. Usually that is a typo — record it only if the customer genuinely overpaid.</>}
      />
    </>
  );
}

/** The money ledger on an invoice or purchase order. */
export function PaymentLedger({ payments, currency = 'AED', onDeleted }: {
  payments: PaymentRecord[];
  currency?: string;
  onDeleted?: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [removing, setRemoving] = useState<PaymentRecord | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/payments/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
      void queryClient.invalidateQueries({ queryKey: ['purchase-orders'] });
      setRemoving(null);
      onDeleted?.();
      toast.push('Payment reversed.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not reverse it.', 'error'),
  });

  if (payments.length === 0) {
    return <EmptyState title="Nothing received yet" message="Record a payment and the balance updates itself." icon={<Banknote size={22} />} />;
  }

  return (
    <>
      <ul>
        {payments.map((payment) => (
          <li key={payment.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
            <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center border', payment.direction === 'INCOMING' ? 'border-[#b8dfc8] bg-[#e8f5ed] text-secure' : 'border-line bg-white text-muted')}>
              <Banknote size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="tabular block text-[13px] font-semibold">
                {currency} {money(payment.amount, true).replace('AED', '').trim()}
              </span>
              <span className="block truncate text-[11px] text-muted">
                {payment.method}
                {payment.reference ? ` · ${payment.reference}` : ''}
                {payment.recordedBy ? ` · ${payment.recordedBy.name}` : ''}
              </span>
            </span>
            <span className="shrink-0 text-[11px] text-muted">{date(payment.paidAt)}</span>
            {can('invoices', 'delete') ? (
              <button onClick={() => setRemoving(payment)} aria-label="Reverse this payment" className="shrink-0 text-n300 transition-colors hover:text-accent">
                <Trash2 size={14} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={() => remove.mutate(removing!.id)}
        loading={remove.isPending}
        title="Reverse this payment?"
        confirmLabel="Reverse"
        message={<>{money(removing?.amount ?? 0)} will be removed from the ledger and the balance recalculated. The reversal is recorded in the audit trail.</>}
      />
    </>
  );
}

export function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'PAID' || status === 'RECEIVED' || status === 'CLOSED' ? 'secure'
    : status === 'OVERDUE' || status === 'CANCELLED' ? 'accent'
    : status === 'PARTIAL' || status === 'PARTIALLY_RECEIVED' ? 'watch'
    : status === 'SENT' || status === 'ISSUED' || status === 'ACKNOWLEDGED' ? 'info'
    : 'neutral';
  return <Badge tone={tone}>{status.replace(/_/g, ' ')}</Badge>;
}
