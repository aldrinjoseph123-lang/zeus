import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Circle, MinusCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Badge, Button, Card, CardHeader, Loading, PageHeader, useToast } from '../components/ui';

type Item = { key: string; label: string; description: string; href: string; required: boolean; done: boolean; skipped: boolean };
type Status = { complete: boolean; finished: boolean; items: Item[] };

/**
 * First-run checklist. Opens on sign-in until the admin presses Finish; each row links
 * to the Settings page where the work actually happens, so no form is duplicated here.
 * Skipping hides a row from this page only — it stays under the bell until it is done.
 */
export default function Setup() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({ queryKey: ['setup'], queryFn: () => api.get<Status>('/setup/status') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['setup'] });

  const skip = useMutation({
    mutationFn: (v: { key: string; skipped: boolean }) => api.post('/setup/skip', v),
    onSuccess: refresh,
  });
  const finish = useMutation({
    mutationFn: () => api.post('/setup/finish', {}),
    onSuccess: () => {
      refresh();
      toast.push('Setup finished. Anything still pending stays under the bell.');
      navigate('/', { replace: true });
    },
  });

  if (isLoading || !data) return <Loading />;

  const editable = can('settings', 'update');
  const pending = data.items.filter((i) => !i.done);
  const visible = data.items.filter((i) => !i.skipped || i.done);
  const skippedCount = data.items.filter((i) => i.skipped && !i.done).length;

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-4">
      <PageHeader
        title="Set up Zeus"
        description={
          data.complete
            ? `Ready to trade. ${pending.length ? `${pending.length} optional item${pending.length === 1 ? '' : 's'} still pending.` : 'Everything is configured.'}`
            : 'The required item has to be done before Zeus can issue a tax invoice. Everything else can wait — it will stay under the bell.'
        }
      />

      <Card>
        <CardHeader
          title="Checklist"
          subtitle="Each row opens the Settings page where it gets done."
          actions={editable ? (
            <Button variant="accent" size="sm" disabled={!data.complete} loading={finish.isPending} onClick={() => finish.mutate()}>
              {data.finished ? 'Done' : 'Finish setup'}
            </Button>
          ) : undefined}
        />
        <ul className="divide-y divide-line">
          {visible.map((item) => (
            // Stacks on narrow screens: side by side, the buttons squeeze the text to a word a line.
            <li key={item.key} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
              <span className="mt-0.5 hidden shrink-0 sm:block" aria-hidden>
                {item.done
                  ? <Check size={16} className="text-secure" />
                  : item.skipped
                    ? <MinusCircle size={16} className="text-n400" />
                    : <Circle size={16} className={item.required ? 'text-accent' : 'text-n400'} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[14px] font-semibold">{item.label}</p>
                  {item.required && !item.done ? <Badge tone="dark">Required</Badge> : null}
                  {item.done ? <Badge tone="neutral">Done</Badge> : null}
                </div>
                <p className="mt-0.5 text-[13px] text-muted">{item.description}</p>
              </div>
              {!item.done ? (
                <div className="flex shrink-0 items-center gap-1 self-end sm:self-start">
                  {editable && !item.required ? (
                    <Button variant="ghost" size="sm" onClick={() => skip.mutate({ key: item.key, skipped: true })}>
                      Skip for now
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => navigate(item.href)}>
                    Configure <ArrowRight size={13} className="ml-1" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {skippedCount > 0 ? (
          <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[12px] text-muted">
            <span>{skippedCount} skipped — still listed under the bell until done.</span>
            {editable ? (
              <button
                className="font-semibold uppercase tracking-[0.08em] text-accent hover:underline"
                onClick={() => data.items.filter((i) => i.skipped).forEach((i) => skip.mutate({ key: i.key, skipped: false }))}
              >
                Show skipped
              </button>
            ) : null}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
