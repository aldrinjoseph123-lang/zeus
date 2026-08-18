import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { Badge, Button, Field, Modal, Textarea, cx, useToast } from './ui';

/**
 * Manager sign-off, shown on the three records that can commit the company:
 * a deal about to close won, a PO about to go to a supplier, an invoice about to
 * go to a customer. The rep submits, a manager decides, and until then the screen
 * says plainly which step is blocked.
 */

export type ApprovalEntity = 'deals' | 'purchase-orders' | 'invoices' | 'quotes';

export interface ApprovalState {
  approvalStatus: 'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  approvalNote: string | null;
  approvalRequestedAt: string | null;
  approvalDecidedAt: string | null;
  approvalRequestedBy: { id: string; name: string } | null;
  approvalDecidedBy: { id: string; name: string } | null;
}

const BLOCKED_STEP: Record<ApprovalEntity, string> = {
  deals: 'closing this deal won',
  'purchase-orders': 'issuing this order to the supplier',
  invoices: 'sending this invoice to the customer',
  quotes: 'sending this quote to the customer',
};

export function ApprovalBar({ entity, id, record, module, onChanged }: {
  entity: ApprovalEntity;
  id: string;
  record: ApprovalState;
  /** RBAC module the approve right lives on — deals for deals, invoices/quotes for the rest. */
  module: 'deals' | 'invoices' | 'quotes';
  onChanged: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');

  const act = useMutation({
    mutationFn: (action: 'submit' | 'approve' | 'reject') =>
      api.post(`/approvals/${entity}/${id}/${action}`, action === 'submit' ? {} : { note: note || undefined }),
    onSuccess: (_res, action) => {
      setRejecting(false);
      setNote('');
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ['pending-approvals'] });
      toast.push(action === 'submit' ? 'Sent for approval.' : action === 'approve' ? 'Approved.' : 'Rejected.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not update the approval.', 'error'),
  });

  const status = record.approvalStatus;
  const mayApprove = can(module, 'approve');
  const mayEdit = can(module, 'update');

  // Nothing has been asked for and nothing is blocked — offer it, quietly.
  if (status === 'NOT_REQUIRED') {
    if (!mayEdit) return null;
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-sunken px-4 py-2.5">
        <ShieldCheck size={13} className="shrink-0 text-n400" />
        <span className="eyebrow">Approval</span>
        <span className="text-[12px] text-muted">Not requested. Send it to a sales manager if it needs signing off.</span>
        <Button size="sm" variant="ghost" className="ml-auto" loading={act.isPending} onClick={() => act.mutate('submit')}>
          Send for approval
        </Button>
      </div>
    );
  }

  const tone =
    status === 'APPROVED' ? 'bg-[#e8f5ed] text-[#14653a]'
    : status === 'REJECTED' ? 'bg-accent-soft text-[var(--red-700)]'
    : 'bg-[#fdf3e7] text-[#8a4d10]';

  const icon =
    status === 'APPROVED' ? <CheckCircle2 size={14} className="shrink-0" />
    : status === 'REJECTED' ? <XCircle size={14} className="shrink-0" />
    : <Clock size={14} className="shrink-0" />;

  return (
    <>
      <div className={cx('flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-line px-4 py-2.5', tone)}>
        {icon}
        <span className="eyebrow">Approval</span>
        <Badge tone={status === 'APPROVED' ? 'secure' : status === 'REJECTED' ? 'accent' : 'watch'}>
          {status === 'PENDING' ? 'Awaiting sign-off' : status === 'APPROVED' ? 'Approved' : 'Rejected'}
        </Badge>

        <span className="min-w-0 text-[12px]">
          {status === 'PENDING' ? (
            <>
              Requested by {record.approvalRequestedBy?.name ?? 'a rep'} {record.approvalRequestedAt ? `on ${dateTime(record.approvalRequestedAt)}` : ''}.
              {' '}<strong>{BLOCKED_STEP[entity][0].toUpperCase()}{BLOCKED_STEP[entity].slice(1)} is blocked until a manager signs it off.</strong>
            </>
          ) : status === 'APPROVED' ? (
            <>Approved by {record.approvalDecidedBy?.name ?? 'a manager'} {record.approvalDecidedAt ? `on ${dateTime(record.approvalDecidedAt)}` : ''}.{record.approvalNote ? ` ${record.approvalNote}` : ''}</>
          ) : (
            <>Rejected by {record.approvalDecidedBy?.name ?? 'a manager'}{record.approvalNote ? ` — ${record.approvalNote}` : ''}. Fix it and send it back.</>
          )}
        </span>

        <span className="ml-auto flex shrink-0 gap-1.5">
          {status === 'PENDING' && mayApprove ? (
            <>
              <Button size="sm" variant="outline" icon={<XCircle size={12} />} onClick={() => setRejecting(true)}>Reject</Button>
              <Button size="sm" variant="accent" icon={<CheckCircle2 size={12} />} loading={act.isPending} onClick={() => act.mutate('approve')}>
                Approve
              </Button>
            </>
          ) : null}
          {status === 'PENDING' && !mayApprove ? (
            <span className="inline-flex items-center gap-1 text-[11px]">
              <ShieldAlert size={12} /> Sales manager only
            </span>
          ) : null}
          {status === 'REJECTED' && mayEdit ? (
            <Button size="sm" variant="outline" loading={act.isPending} onClick={() => act.mutate('submit')}>Resubmit</Button>
          ) : null}
        </span>
      </div>

      {rejecting ? (
        <Modal
          open
          onClose={() => setRejecting(false)}
          title="Reject this?"
          subtitle="The reason goes back to the person who submitted it."
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
              <Button variant="danger" disabled={!note.trim()} loading={act.isPending} onClick={() => act.mutate('reject')}>
                Reject
              </Button>
            </>
          }
        >
          <Field label="Why" required hint="Say what needs to change so it can come back fixed.">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Margin is under 15% — re-price or get vendor support." />
          </Field>
        </Modal>
      ) : null}
    </>
  );
}
