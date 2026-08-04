import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, Circle, Mail, PhoneCall, StickyNote, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative } from '../lib/format';
import { Badge, Button, Field, Input, Select, Textarea, cx, useToast } from './ui';

export interface ActivityRecord {
  id: string;
  type: 'TASK' | 'CALL' | 'MEETING' | 'EMAIL' | 'NOTE';
  subject: string;
  description: string | null;
  status: string;
  priority: string;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  owner?: { name: string; avatarColor?: string } | null;
}

const ICONS = { TASK: CheckCircle2, CALL: PhoneCall, MEETING: Users, EMAIL: Mail, NOTE: StickyNote };

export interface TimelineLinks {
  accountId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  dealId?: string | null;
}

/** Log-a-thing composer plus the record's history. Same component on every detail page. */
export function ActivityPanel({ activities, links, invalidate }: {
  activities: ActivityRecord[];
  links: TimelineLinks;
  invalidate: () => void;
}) {
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [type, setType] = useState<ActivityRecord['type']>('NOTE');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [priority, setPriority] = useState('Normal');

  const create = useMutation({
    mutationFn: () =>
      api.post('/activities', {
        type,
        subject: subject.trim(),
        description: description.trim() || null,
        dueAt: type === 'TASK' || type === 'MEETING' || type === 'CALL' ? dueAt || null : null,
        priority,
        ...links,
      }),
    onSuccess: () => {
      setSubject('');
      setDescription('');
      setDueAt('');
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
      toast.push(type === 'TASK' ? 'Task added.' : 'Logged.');
    },
    onError: (err) => toast.push(err instanceof Error ? err.message : 'Could not save.', 'error'),
  });

  const complete = useMutation({
    mutationFn: (id: string) => api.patch(`/activities/${id}`, { status: 'Completed' }),
    onSuccess: () => {
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['activities'] });
      toast.push('Marked complete.');
    },
  });

  const needsDate = type === 'TASK' || type === 'MEETING' || type === 'CALL';

  return (
    <div>
      {can('activities', 'create') ? (
        <div className="border-b border-line bg-sunken px-4 py-3">
          <div className="mb-2 flex flex-wrap gap-1">
            {(['NOTE', 'CALL', 'MEETING', 'EMAIL', 'TASK'] as const).map((option) => (
              <button
                key={option}
                onClick={() => setType(option)}
                className={cx(
                  'rounded-sharp border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] transition-colors',
                  type === option ? 'border-n950 bg-n950 text-white' : 'border-line bg-white text-muted hover:text-ink',
                )}
              >
                {option === 'NOTE' ? 'Note' : option === 'TASK' ? 'Task' : option.charAt(0) + option.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={type === 'TASK' ? 'What needs doing?' : type === 'NOTE' ? 'What happened?' : `Subject of this ${type.toLowerCase()}`}
          />

          {subject.trim() ? (
            <div className="mt-2 space-y-2">
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Detail (optional)" />
              {needsDate ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label={type === 'TASK' ? 'Due' : 'When'}>
                    <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
                  </Field>
                  <Field label="Priority">
                    <Select value={priority} onChange={(e) => setPriority(e.target.value)} options={['Low', 'Normal', 'High', 'Urgent'].map((p) => ({ value: p, label: p }))} />
                  </Field>
                </div>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setSubject(''); setDescription(''); }}>Cancel</Button>
                <Button variant="accent" size="sm" loading={create.isPending} onClick={() => create.mutate()}>
                  {type === 'TASK' ? 'Add task' : 'Log it'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <ol className="max-h-[520px] overflow-y-auto">
        {activities.length === 0 ? (
          <li className="px-4 py-10 text-center text-xs text-muted">Nothing logged yet.</li>
        ) : (
          activities.map((activity) => {
            const Icon = ICONS[activity.type] ?? StickyNote;
            const open = activity.status === 'Open' && activity.type !== 'NOTE' && activity.type !== 'EMAIL';
            const overdue = open && activity.dueAt && new Date(activity.dueAt) < new Date();
            return (
              <li key={activity.id} className="flex gap-3 border-b border-line px-4 py-3">
                <span className={cx('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sharp border', overdue ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-white text-muted')}>
                  <Icon size={14} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[13px] font-semibold">{activity.subject}</span>
                    {open ? <Badge tone={overdue ? 'accent' : 'watch'}>{overdue ? 'overdue' : 'open'}</Badge> : null}
                    {activity.priority === 'Urgent' || activity.priority === 'High' ? <Badge tone="accent">{activity.priority}</Badge> : null}
                  </div>
                  {activity.description ? <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed text-n600">{activity.description}</p> : null}
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] uppercase tracking-[0.08em] text-n400">
                    <span>{activity.owner?.name ?? 'System'}</span>
                    <span>·</span>
                    <span title={dateTime(activity.createdAt)}>{relative(activity.createdAt)}</span>
                    {activity.dueAt ? (
                      <>
                        <span>·</span>
                        <span className={cx('flex items-center gap-1', overdue && 'font-semibold text-accent')}>
                          <CalendarDays size={10} /> due {relative(activity.dueAt)}
                        </span>
                      </>
                    ) : null}
                  </p>
                </div>
                {open && can('activities', 'update') ? (
                  <button
                    onClick={() => complete.mutate(activity.id)}
                    title="Mark complete"
                    className="mt-0.5 shrink-0 text-n300 transition-colors hover:text-secure"
                  >
                    <Circle size={17} />
                  </button>
                ) : null}
              </li>
            );
          })
        )}
      </ol>
    </div>
  );
}
