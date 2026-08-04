import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Mail, PhoneCall, StickyNote, Users } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative } from '../lib/format';
import {
  Badge, Button, Card, EmptyState, Loading, PageHeader, Pagination, SearchInput,
  Select, Tabs, cx, useDebounced, useToast,
} from '../components/ui';
import { OwnerSelect, Toolbar } from '../components/pickers';

interface Activity {
  id: string; type: 'TASK' | 'CALL' | 'MEETING' | 'EMAIL' | 'NOTE'; subject: string; description: string | null;
  status: string; priority: string; dueAt: string | null; completedAt: string | null; createdAt: string;
  owner: { id: string; name: string } | null;
  account: { id: string; name: string } | null;
  deal: { id: string; reference: string; name: string } | null;
  lead: { id: string; company: string } | null;
}

interface MyDay { overdue: Activity[]; today: Activity[]; thisWeek: Activity[]; unscheduled: Activity[] }

const ICONS = { TASK: CheckCircle2, CALL: PhoneCall, MEETING: Users, EMAIL: Mail, NOTE: StickyNote };

export default function Activities() {
  const [tab, setTab] = useState('my-day');
  const { can } = useAuth();
  const toast = useToast();

  return (
    <>
      <PageHeader
        title="Tasks & activity"
        description="What you owe people, and everything logged against the pipeline."
        actions={
          can('activities', 'export') ? (
            <Button
              icon={<Download size={14} />}
              onClick={() => download('/reports/activities?format=xlsx', 'zeus-activities.xlsx').catch((err) => toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error'))}
            >
              Excel
            </Button>
          ) : undefined
        }
      />

      <Card>
        <Tabs tabs={[{ key: 'my-day', label: 'My day' }, { key: 'all', label: 'All activity' }]} active={tab} onChange={setTab} />
        {tab === 'my-day' ? <MyDayView /> : <AllActivity />}
      </Card>
    </>
  );
}

function TaskRow({ activity, onComplete, busy }: { activity: Activity; onComplete: (id: string) => void; busy: boolean }) {
  const { can } = useAuth();
  const Icon = ICONS[activity.type] ?? CheckCircle2;
  const overdue = activity.status === 'Open' && activity.dueAt && new Date(activity.dueAt) < new Date();
  const link = activity.deal ? `/deals/${activity.deal.id}` : activity.account ? `/accounts/${activity.account.id}` : activity.lead ? `/leads/${activity.lead.id}` : null;

  return (
    <li className="flex items-start gap-3 border-b border-line px-4 py-2.5">
      {can('activities', 'update') && activity.status === 'Open' ? (
        <button
          onClick={() => onComplete(activity.id)}
          disabled={busy}
          title="Mark complete"
          className="mt-0.5 h-4 w-4 shrink-0 rounded-sharp border border-n300 transition-colors hover:border-secure hover:bg-secure/10 disabled:opacity-40"
        />
      ) : (
        <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-secure" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Icon size={12} className="text-n400" />
          <span className={cx('text-[13px] font-semibold', activity.status === 'Completed' && 'text-muted line-through')}>{activity.subject}</span>
          {activity.priority === 'Urgent' || activity.priority === 'High' ? <Badge tone="accent">{activity.priority}</Badge> : null}
        </div>
        {activity.description ? <p className="mt-0.5 line-clamp-1 text-[12px] text-muted">{activity.description}</p> : null}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] uppercase tracking-[0.08em] text-n400">
          {link ? (
            <Link to={link} className="underline decoration-dotted underline-offset-2 hover:text-ink">
              {activity.deal ? `${activity.deal.reference} · ${activity.deal.name}` : activity.account?.name ?? activity.lead?.company}
            </Link>
          ) : (
            <span>Unlinked</span>
          )}
          <span>·</span>
          <span>{activity.owner?.name ?? 'Unassigned'}</span>
        </p>
      </div>

      {activity.dueAt ? (
        <span className={cx('shrink-0 text-right text-[11px]', overdue ? 'font-semibold text-accent' : 'text-muted')} title={dateTime(activity.dueAt)}>
          {relative(activity.dueAt)}
        </span>
      ) : null}
    </li>
  );
}

function MyDayView() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['my-day'],
    queryFn: () => api.get<MyDay>('/activities/my-day'),
  });

  const complete = useMutation({
    mutationFn: (id: string) => api.patch(`/activities/${id}`, { status: 'Completed' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-day'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard-attention'] });
      toast.push('Done.');
    },
  });

  if (isLoading) return <Loading />;
  if (!data) return <EmptyState title="Nothing to show" />;

  const sections: Array<{ key: keyof MyDay; title: string; tone: 'accent' | 'default' }> = [
    { key: 'overdue', title: 'Overdue', tone: 'accent' },
    { key: 'today', title: 'Due today', tone: 'default' },
    { key: 'thisWeek', title: 'This week', tone: 'default' },
    { key: 'unscheduled', title: 'No date set', tone: 'default' },
  ];

  const total = sections.reduce((sum, section) => sum + data[section.key].length, 0);
  if (total === 0) {
    return <EmptyState title="Nothing open" message="No tasks, calls or meetings are waiting on you. Add one from any deal or account." icon={<CheckCircle2 size={24} />} />;
  }

  return (
    <div>
      {sections.map((section) =>
        data[section.key].length === 0 ? null : (
          <div key={section.key}>
            <div className={cx('flex items-center justify-between border-b border-line px-4 py-2', section.tone === 'accent' ? 'bg-accent-soft' : 'bg-sunken')}>
              <span className={cx('eyebrow', section.tone === 'accent' && 'text-accent')}>{section.title}</span>
              <span className="text-[11px] text-muted">{data[section.key].length}</span>
            </div>
            <ul>
              {data[section.key].map((activity) => (
                <TaskRow key={activity.id} activity={activity} onComplete={(id) => complete.mutate(id)} busy={complete.isPending} />
              ))}
            </ul>
          </div>
        ),
      )}
    </div>
  );
}

function AllActivity() {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['activities', debounced, type, status, ownerId, page],
    queryFn: () => api.get<{ data: Activity[]; total: number; totalPages: number; page: number }>(`/activities${qs({ search: debounced, type, status, ownerId, page, pageSize: 30, sortBy: 'createdAt', sortDir: 'desc' })}`),
  });

  const complete = useMutation({
    mutationFn: (id: string) => api.patch(`/activities/${id}`, { status: 'Completed' }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['activities'] }); toast.push('Done.'); },
  });

  return (
    <>
      <Toolbar>
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search subjects…" className="w-full sm:w-64" />
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} placeholder="All types" options={['TASK', 'CALL', 'MEETING', 'EMAIL', 'NOTE'].map((t) => ({ value: t, label: t.charAt(0) + t.slice(1).toLowerCase() }))} className="w-[130px]" />
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} placeholder="Any status" options={[{ value: 'Open', label: 'Open' }, { value: 'Completed', label: 'Completed' }]} className="w-[130px]" />
        <OwnerSelect value={ownerId} onChange={(v) => { setOwnerId(v); setPage(1); }} className="w-[160px]" />
      </Toolbar>

      {isLoading ? (
        <Loading />
      ) : (data?.data ?? []).length === 0 ? (
        <EmptyState title="No activity matches" message="Try clearing a filter." />
      ) : (
        <>
          <ul>
            {data!.data.map((activity) => (
              <TaskRow key={activity.id} activity={activity} onComplete={(id) => complete.mutate(id)} busy={complete.isPending} />
            ))}
          </ul>
          <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      )}
    </>
  );
}
