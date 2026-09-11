import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Handshake, Plus } from 'lucide-react';
import { api, ApiError, qs } from '../lib/api';
import { date } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, Checkbox, DataTable, EmptyState, ErrorNote, Field, Input,
  Loading, Modal, PageHeader, Select, StatTile, Textarea, cx, useToast,
} from '../components/ui';
import { OwnerSelect, Toolbar } from '../components/pickers';
import { useAuth } from '../lib/auth';

/**
 * The partner register.
 *
 * Sorted by who has waited longest, not alphabetically — an A–Z list of a growing roster
 * is something you scroll past, the same rows ordered by neglect are a plan for the week.
 * Everything else on the row exists to answer "and is it worth the call": who owns the
 * relationship, how many deals are open, when they are next due.
 */

interface PartnerRow {
  id: string;
  name: string;
  isDormant: boolean;
  channelManager: { id: string; name: string } | null;
  owner: { id: string; name: string } | null;
  openDeals: number;
  cadenceDays: number;
  cadenceIsOwn: boolean;
  lastContactAt: string | null;
  dueAt: string | null;
  overdueDays: number | null;
}

interface Register {
  rows: PartnerRow[];
  houseCadenceDays: number;
  overdue: number;
  unmanaged: number;
}

/** What a person can record from here. A task is not contact, so it is not on the list. */
const LOG_TYPES = [
  { value: 'VISIT', label: 'Visit' },
  { value: 'CALL', label: 'Call' },
  { value: 'MEETING', label: 'Meeting' },
  { value: 'EMAIL', label: 'Email' },
  { value: 'REQUEST', label: 'They asked us for something' },
  { value: 'NOTE', label: 'Note (not contact)' },
];

export default function Partners() {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [includeDormant, setIncludeDormant] = useState(false);
  const [logging, setLogging] = useState<PartnerRow | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['partners', includeDormant],
    queryFn: () => api.get<Register>(`/partners${qs({ includeDormant: includeDormant || undefined })}`),
  });

  if (isLoading) return <Loading label="Reading the register" />;
  if (error || !data) return <EmptyState title="Partners unavailable" message={(error as Error)?.message} />;

  const mayEdit = can('partners', 'update');

  return (
    <>
      <PageHeader
        title="Partners"
        description="Who we work with, and when we last spoke to them. Longest wait first."
      />

      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <StatTile label="Partners" value={String(data.rows.length)} />
        <StatTile label="Overdue a contact" value={String(data.overdue)} tone={data.overdue > 0 ? 'accent' : undefined} />
        <StatTile label="Nobody managing" value={String(data.unmanaged)} tone={data.unmanaged > 0 ? 'accent' : undefined} />
      </div>

      <Card className="mt-3">
        <CardHeader
          title="The register"
          subtitle={`House rhythm: every ${data.houseCadenceDays} days unless a partner sets its own.`}
        />
        <Toolbar>
          <Checkbox
            label="Include dormant"
            checked={includeDormant}
            onChange={setIncludeDormant}
          />
        </Toolbar>

        {data.rows.length === 0 ? (
          <EmptyState
            icon={<Handshake size={20} />}
            title="No partners yet"
            message="Accounts of type Partner appear here, with the engagement you record against them."
            action={<Button to="/accounts">Open accounts</Button>}
          />
        ) : (
          <DataTable
            rows={data.rows}
            rowKey={(p) => p.id}
            columns={[
              {
                key: 'name',
                header: 'Partner',
                render: (p: PartnerRow) => (
                  <span className="flex items-center gap-2">
                    <Link to={`/accounts/${p.id}`} className="font-semibold hover:text-accent-ink">{p.name}</Link>
                    {p.isDormant ? <Badge tone="neutral">Dormant</Badge> : null}
                    {p.cadenceIsOwn ? <Badge tone="neutral">{p.cadenceDays}d</Badge> : null}
                  </span>
                ),
              },
              { key: 'state', header: 'Last contact', render: (p: PartnerRow) => <ContactState row={p} /> },
              {
                key: 'manager',
                header: 'Channel manager',
                render: (p: PartnerRow) => (p.channelManager
                  ? <span>{p.channelManager.name}</span>
                  : <span className="text-accent-ink">Nobody</span>),
              },
              { key: 'deals', header: 'Open deals', align: 'right', render: (p: PartnerRow) => p.openDeals || '—' },
              {
                key: 'act',
                header: '',
                align: 'right',
                render: (p: PartnerRow) => (mayEdit
                  ? <Button size="sm" icon={<Plus size={12} />} onClick={() => setLogging(p)}>Log</Button>
                  : null),
              },
            ]}
          />
        )}
      </Card>

      {logging ? (
        <LogDialog
          partner={logging}
          onClose={() => setLogging(null)}
          onLogged={() => {
            setLogging(null);
            toast.push('Logged.', 'success');
            void queryClient.invalidateQueries({ queryKey: ['partners'] });
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The one cell people actually read. "Never" is louder than a long gap, because a partner
 * with no history at all is the one most likely to have been forgotten entirely.
 */
function ContactState({ row }: { row: PartnerRow }) {
  if (!row.lastContactAt) {
    return <span className="font-semibold text-accent-ink">Never contacted</span>;
  }
  const overdue = (row.overdueDays ?? 0) > 0;
  return (
    <span className={cx('flex items-baseline gap-2', overdue && 'text-accent-ink')}>
      <span className={cx(overdue && 'font-semibold')}>{date(row.lastContactAt)}</span>
      <span className="text-[11px] text-muted">
        {overdue ? `${row.overdueDays}d overdue` : `due ${date(row.dueAt)}`}
      </span>
    </span>
  );
}

/**
 * The ten-second log.
 *
 * Three fields, today already filled in, everything else optional. The realistic failure
 * of this whole register is an empty one in three months: a visit gets written down in a
 * car park or it never gets written down, and every extra required field loses to that.
 */
function LogDialog({ partner, onClose, onLogged }: {
  partner: PartnerRow; onClose: () => void; onLogged: () => void;
}) {
  const [type, setType] = useState('VISIT');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [bookNext, setBookNext] = useState(true);
  const [followUpOwnerId, setFollowUpOwnerId] = useState(partner.channelManager?.id ?? '');

  // A month out by default — or this partner's own rhythm, which is the point of having
  // one. Computed once when the dialog opens rather than on every render: reading the
  // clock during render makes the value drift under React, and this is a form default.
  const [followUpAt, setFollowUpAt] = useState(
    () => new Date(Date.now() + partner.cadenceDays * 86_400_000).toISOString().slice(0, 10),
  );

  const save = useMutation({
    mutationFn: () => api.post(`/partners/${partner.id}/log`, {
      type,
      subject,
      description: description || undefined,
      followUpAt: bookNext && followUpAt ? new Date(`${followUpAt}T09:00:00`).toISOString() : null,
      followUpOwnerId: bookNext ? (followUpOwnerId || null) : null,
    }),
    onSuccess: onLogged,
  });

  return (
    <Modal open title={`Log against ${partner.name}`} onClose={onClose}>
      <div className="grid gap-3">
        <Field label="What was it">
          <Select value={type} onChange={(e) => setType(e.target.value)} options={LOG_TYPES} />
        </Field>
        <Field label="In a line">
          <Input
            autoFocus
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Quarterly catch-up at their office"
          />
        </Field>
        <Field label="Anything worth remembering" hint="Optional.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>

        <div className="border-t border-line pt-3">
          <Checkbox
            label="Book the next one"
            checked={bookNext}
            onChange={setBookNext}
          />
          {bookNext ? (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="When">
                <Input type="date" value={followUpAt} onChange={(e) => setFollowUpAt(e.target.value)} />
              </Field>
              <Field label="Whose task" hint="Defaults to the channel manager.">
                <OwnerSelect value={followUpOwnerId} onChange={setFollowUpOwnerId} />
              </Field>
            </div>
          ) : null}
        </div>

        {save.error ? <ErrorNote error={save.error as ApiError} /> : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="accent"
            disabled={!subject.trim()}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Log it
          </Button>
        </div>
      </div>
    </Modal>
  );
}
