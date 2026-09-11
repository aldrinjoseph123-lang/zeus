import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, relative } from '../lib/format';
import { Badge, Button, DataTable, EmptyState, ErrorNote, Field, Input, Loading, Modal, Textarea, useToast } from './ui';
import { AccountPicker } from './pickers';

/**
 * What we have done with this partner, and what they are still waiting on.
 *
 * Deliberately its own tab rather than the account's main timeline: engagement reads as a
 * rhythm, and a rhythm is easier to see when quotes and invoices are not interleaved with
 * it. The cost of that choice is real and worth knowing — someone opening a partner to
 * check a deal will not see that we visited last week.
 */

interface EngagementActivity {
  id: string;
  type: string;
  subject: string;
  description: string | null;
  status: string;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  owner: { id: string; name: string } | null;
  contact: { id: string; firstName: string; lastName: string } | null;
}

interface Engagement {
  partner: {
    id: string; name: string; isDormant: boolean;
    lastContactAt: string | null; cadenceDays: number;
    channelManager: { id: string; name: string } | null;
  };
  activities: EngagementActivity[];
  openRequests: number;
}

const TYPE_LABELS: Record<string, string> = {
  VISIT: 'Visit', CALL: 'Call', MEETING: 'Meeting', EMAIL: 'Email',
  REQUEST: 'Request', NOTE: 'Note', TASK: 'Task',
};

/** A request waiting on us is the only thing here that is anyone's problem. */
function toneFor(a: EngagementActivity) {
  if (a.type === 'REQUEST' && a.status === 'Open') return 'accent' as const;
  if (a.status === 'Open') return 'watch' as const;
  return 'neutral' as const;
}

interface Enablement {
  id: string;
  vendor: { id: string; name: string };
  enabledAt: string;
  expiresAt: string;
  note: string | null;
  recordedBy: { id: string; name: string } | null;
  /** live | expiring | expired — expiring and expired want different reactions. */
  state: 'live' | 'expiring' | 'expired';
}

const ENABLEMENT_TONE = { live: 'secure', expiring: 'watch', expired: 'accent' } as const;

/**
 * What this partner can sell.
 *
 * Per vendor, not per SKU, and everything expires — a list nobody re-checks is a list of
 * what was true once. It answers the question asked the moment a lead lands and needs
 * somewhere to go: who can actually handle this.
 */
function EnablementPanel({ accountId }: { accountId: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);

  const { data } = useQuery({
    queryKey: ['partner-enablement', accountId],
    queryFn: () => api.get<{ rows: Enablement[]; warnDays: number }>(`/partners/${accountId}/enablement`),
  });

  const remove = useMutation({
    mutationFn: (vendorId: string) => api.del(`/partners/${accountId}/enablement/${vendorId}`),
    onSuccess: () => {
      toast.push('Enablement removed.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['partner-enablement', accountId] });
    },
  });

  const mayEdit = can('partners', 'update');
  const rows = data?.rows ?? [];

  return (
    <div className="border-b border-line px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="eyebrow">Enabled to sell</span>
        {mayEdit ? (
          <Button size="sm" icon={<Plus size={12} />} onClick={() => setAdding(true)}>Add vendor</Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className="mt-2 text-[12px] text-muted">
          No vendors recorded. Until one is, Zeus cannot answer which partners can sell what.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {rows.map((r) => (
            <span key={r.id} className="inline-flex items-center gap-1.5">
              <Badge tone={ENABLEMENT_TONE[r.state]}>
                {r.vendor.name}
                <span className="font-normal normal-case tracking-normal">
                  {r.state === 'expired' ? ' · lapsed' : ` · to ${date(r.expiresAt)}`}
                </span>
              </Badge>
              {mayEdit ? (
                <button
                  type="button"
                  aria-label={`Remove ${r.vendor.name}`}
                  className="text-muted transition-colors hover:text-accent-ink"
                  onClick={() => remove.mutate(r.vendor.id)}
                >
                  <X size={12} />
                </button>
              ) : null}
            </span>
          ))}
        </div>
      )}

      {adding ? (
        <AddEnablement
          accountId={accountId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            toast.push('Enablement recorded.', 'success');
            void queryClient.invalidateQueries({ queryKey: ['partner-enablement', accountId] });
          }}
        />
      ) : null}
    </div>
  );
}

function AddEnablement({ accountId, onClose, onSaved }: {
  accountId: string; onClose: () => void; onSaved: () => void;
}) {
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [vendorLabel, setVendorLabel] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState('');
  const [note, setNote] = useState('');

  // A year unless the vendor's programme says otherwise, which is the usual case. Read
  // once on open, not on every render — the clock is not a pure value.
  const [suggested] = useState(() => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10));

  const save = useMutation({
    mutationFn: () => api.put(`/partners/${accountId}/enablement/${vendorId}`, {
      expiresAt: new Date(`${expiresAt || suggested}T09:00:00`).toISOString(),
      note: note || null,
    }),
    onSuccess: onSaved,
  });

  return (
    <Modal open title="Enable this partner on a vendor" onClose={onClose} width="sm">
      <div className="grid gap-3">
        <Field label="Vendor" hint="Per vendor, not per product — a new SKU under one they already carry needs nothing.">
          <AccountPicker
            value={vendorId}
            type="VENDOR"
            selectedLabel={vendorLabel}
            onChange={(id, row) => { setVendorId(id); setVendorLabel(row?.name ?? null); }}
          />
        </Field>
        <Field label="Re-check by" hint="A year from today unless the vendor sets a different term.">
          <Input type="date" value={expiresAt || suggested} onChange={(e) => setExpiresAt(e.target.value)} />
        </Field>
        <Field label="Note" hint="Optional — certification number, who was trained.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
        {save.error ? <ErrorNote error={save.error as ApiError} /> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!vendorId} loading={save.isPending} onClick={() => save.mutate()}>
            Record it
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function EngagementTab({ accountId }: { accountId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-engagement', accountId],
    queryFn: () => api.get<Engagement>(`/partners/${accountId}/engagement`),
  });

  if (isLoading) return <Loading label="Reading the history" />;
  if (error || !data) {
    return <EmptyState title="Engagement unavailable" message={(error as Error)?.message} />;
  }

  const { partner, activities, openRequests } = data;

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 border-b border-line px-4 py-3 text-[12px]">
        <span>
          <span className="eyebrow">Last contact</span>{' '}
          <span className="font-semibold">
            {partner.lastContactAt ? relative(partner.lastContactAt) : 'never'}
          </span>
        </span>
        <span>
          <span className="eyebrow">Rhythm</span>{' '}
          <span className="font-semibold">every {partner.cadenceDays} days</span>
        </span>
        <span>
          <span className="eyebrow">Channel manager</span>{' '}
          <span className="font-semibold">{partner.channelManager?.name ?? 'Nobody'}</span>
        </span>
        {openRequests > 0 ? (
          <span className="ml-auto">
            <Badge tone="accent">{openRequests} waiting on us</Badge>
          </span>
        ) : null}
      </div>

      <EnablementPanel accountId={accountId} />

      {activities.length === 0 ? (
        <EmptyState
          title="Nothing recorded yet"
          message="Visits, calls and meetings logged against this partner appear here, newest first."
        />
      ) : (
        <DataTable
          dense
          rows={activities}
          rowKey={(row) => row.id}
          columns={[
            {
              key: 'type',
              header: 'What',
              width: '92px',
              render: (row) => <Badge tone={toneFor(row)}>{TYPE_LABELS[row.type] ?? row.type}</Badge>,
            },
            {
              key: 'subject',
              header: 'Detail',
              render: (row) => (
                <span>
                  <span className="block font-semibold">{row.subject}</span>
                  {row.contact ? (
                    <span className="block text-[11px] text-muted">
                      with {row.contact.firstName} {row.contact.lastName}
                    </span>
                  ) : null}
                  {row.description ? (
                    <span className="mt-0.5 block whitespace-pre-wrap text-[11px] text-muted">{row.description}</span>
                  ) : null}
                </span>
              ),
            },
            {
              key: 'when',
              header: 'When',
              width: '120px',
              render: (row) => (
                <span className="text-[12px] text-muted">
                  {row.completedAt ? date(row.completedAt) : row.dueAt ? `due ${date(row.dueAt)}` : date(row.createdAt)}
                </span>
              ),
            },
            {
              key: 'owner',
              header: 'Who',
              width: '120px',
              render: (row) => <span className="text-[12px] text-muted">{row.owner?.name ?? '—'}</span>,
            },
          ]}
        />
      )}
    </div>
  );
}
