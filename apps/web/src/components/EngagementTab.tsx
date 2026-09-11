import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { date, relative } from '../lib/format';
import { Badge, DataTable, EmptyState, Loading } from './ui';

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
