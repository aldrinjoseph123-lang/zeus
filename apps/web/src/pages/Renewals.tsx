import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Download, Plus, RefreshCw } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, daysBetween, money } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, DataTable, EmptyState, ErrorNote, Field, Input, Loading,
  Modal, PageHeader, Pagination, SearchInput, Select, StatTile, Textarea, cx, useDebounced, useToast,
} from '../components/ui';
import { AccountPicker, OwnerSelect, Toolbar } from '../components/pickers';
import { RankedBars } from '../components/charts';

/**
 * Renewals.
 *
 * The question this screen answers is "what runs out soon, and is anyone on it?".
 * Everything else — value, vendor, term — is supporting detail, so the expiry date
 * and whether a renewal deal exists are what the eye lands on first.
 */

interface Subscription {
  id: string; reference: string; description: string; status: string;
  quantity: string | number; unit: string; unitPrice: string | number;
  termValue: string | number; termMonths: number;
  startDate: string; endDate: string; autoRenew: boolean; vendorRef: string | null;
  account: { id: string; name: string };
  vendor: { id: string; name: string } | null;
  product: { id: string; sku: string; name: string } | null;
  owner: { id: string; name: string } | null;
  renewalDeal: { id: string; reference: string; status: string; stage: { name: string } } | null;
  sourceInvoice: { id: string; number: string } | null;
}

interface Summary {
  underCover: { count: number; value: number; cost: number };
  next30: { count: number; value: number };
  next60: { count: number; value: number };
  next90: { count: number; value: number };
  unworked: { count: number; value: number };
  lapsed12m: { count: number; value: number };
  byMonth: Array<{ month: string; value: number; count: number; worked: number }>;
  leadDays: number;
}

const STATUS_TONE: Record<string, 'neutral' | 'secure' | 'watch' | 'accent' | 'info'> = {
  ACTIVE: 'secure', EXPIRING: 'watch', RENEWED: 'info', LAPSED: 'accent', CANCELLED: 'neutral',
};

const monthLabel = (key: string) => {
  const [year, month] = key.split('-').map(Number);
  return new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
};

export default function Renewals() {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState(params.get('search') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [withinDays, setWithinDays] = useState(params.get('withinDays') ?? '90');
  const [unworked, setUnworked] = useState(params.get('unworked') === 'true');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const debounced = useDebounced(search, 300);

  const { data: summary } = useQuery({
    queryKey: ['renewals-summary'],
    queryFn: () => api.get<Summary>('/subscriptions/summary'),
  });

  const { data, isLoading } = useQuery({
    queryKey: ['subscriptions', debounced, status, withinDays, unworked, page],
    queryFn: () =>
      api.get<{ data: Subscription[]; total: number; totalPages: number; page: number; totals: { value: number; cost: number } }>(
        `/subscriptions${qs({ search: debounced, status, withinDays: withinDays || undefined, unworked: unworked || undefined, page, pageSize: 25 })}`,
      ),
  });

  const renew = useMutation({
    mutationFn: (id: string) => api.post<{ id: string; reference: string }>(`/subscriptions/${id}/renew`),
    onSuccess: (deal) => {
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['renewals-summary'] });
      toast.push(`${deal.reference} opened.`, 'success');
      navigate(`/deals/${deal.id}`);
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not open the renewal.', 'error'),
  });

  const setFilter = (next: Record<string, string | undefined>) => {
    const merged = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) merged.set(key, value);
      else merged.delete(key);
    }
    setParams(merged, { replace: true });
    setPage(1);
  };

  return (
    <>
      <PageHeader
        title="Renewals"
        description={`What customers own and when it runs out. Zeus opens the renewal ${summary?.leadDays ?? 90} days ahead.`}
        actions={
          <>
            {can('deals', 'export') ? (
              <Button
                icon={<Download size={14} />}
                onClick={() => download('/reports/renewals?format=xlsx', 'zeus-renewals.xlsx').catch((err) => toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error'))}
              >
                Excel
              </Button>
            ) : null}
            {can('deals', 'create') ? (
              <Button variant="accent" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add entitlement</Button>
            ) : null}
          </>
        }
      />

      {summary ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatTile label="Under cover" value={money(summary.underCover.value)} sub={`${summary.underCover.count} live entitlement${summary.underCover.count === 1 ? '' : 's'}`} />
          <StatTile label="Next 30 days" value={money(summary.next30.value)} sub={`${summary.next30.count} expiring`} tone={summary.next30.count ? 'watch' : 'default'} />
          <StatTile label="Next 90 days" value={money(summary.next90.value)} sub={`${summary.next90.count} expiring`} />
          <StatTile
            label="Nobody on it"
            value={money(summary.unworked.value)}
            sub={`${summary.unworked.count} with no renewal open`}
            tone={summary.unworked.count ? 'accent' : 'secure'}
          />
          <StatTile label="Lapsed (12m)" value={money(summary.lapsed12m.value)} sub={`${summary.lapsed12m.count} let go`} tone={summary.lapsed12m.count ? 'accent' : 'default'} />
        </div>
      ) : null}

      {summary?.byMonth.length ? (
        <Card className="mt-3">
          <CardHeader title="Expiring by month" subtitle="Twelve months ahead — the shape of next year's renewal revenue" />
          <div className="px-4 py-3">
            <RankedBars
              data={summary.byMonth.map((m) => ({ name: monthLabel(m.month), value: m.value, count: m.count, worked: m.worked }))}
              height={Math.max(180, summary.byMonth.length * 26)}
            />
          </div>
        </Card>
      ) : null}

      <Card className="mt-3">
        <Toolbar>
          <SearchInput
            value={search}
            onChange={(v) => { setSearch(v); setFilter({ search: v || undefined }); }}
            placeholder="Search reference, entitlement, customer…"
            className="w-full sm:w-72"
          />
          <Select
            value={withinDays}
            onChange={(e) => { setWithinDays(e.target.value); setFilter({ withinDays: e.target.value || undefined }); }}
            placeholder="Any expiry"
            options={[
              { value: '30', label: 'Next 30 days' },
              { value: '60', label: 'Next 60 days' },
              { value: '90', label: 'Next 90 days' },
              { value: '180', label: 'Next 6 months' },
              { value: '365', label: 'Next 12 months' },
            ]}
            className="w-[150px]"
          />
          <Select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setFilter({ status: e.target.value || undefined }); }}
            placeholder="All statuses"
            options={['ACTIVE', 'EXPIRING', 'RENEWED', 'LAPSED', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
            className="w-[140px]"
          />
          <button
            onClick={() => { setUnworked(!unworked); setFilter({ unworked: !unworked ? 'true' : undefined }); }}
            className={
              unworked
                ? 'rounded-sharp border border-accent bg-accent px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-white'
                : 'rounded-sharp border border-line bg-white px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted hover:border-n900 hover:text-ink'
            }
          >
            Nobody on it
          </button>
        </Toolbar>

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              empty={
                <EmptyState
                  title="Nothing under cover yet"
                  message="Entitlements appear here when an invoice with a term is issued. You can also add one by hand for something sold before Zeus."
                  icon={<CalendarClock size={22} />}
                />
              }
              columns={[
                {
                  key: 'description', header: 'Entitlement',
                  render: (row) => (
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{row.description}</span>
                      <span className="block text-[11px] text-muted">
                        {row.reference} · {Number(row.quantity)} × {row.unit}
                        {row.vendor ? ` · ${row.vendor.name}` : ''}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'account', header: 'Customer', width: '190px',
                  render: (row) => (
                    <Link to={`/accounts/${row.account.id}`} onClick={(e) => e.stopPropagation()} className="font-semibold underline decoration-dotted underline-offset-2">
                      {row.account.name}
                    </Link>
                  ),
                },
                { key: 'status', header: 'Status', width: '96px', render: (row) => <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge> },
                {
                  key: 'endDate', header: 'Cover ends', align: 'right', width: '120px',
                  render: (row) => {
                    const left = daysBetween(row.endDate);
                    const daysLeft = left === null ? null : -left;
                    return (
                      <span className={cx('tabular text-[12px]', daysLeft !== null && daysLeft <= 30 && 'font-semibold text-accent')}>
                        <span className="block">{date(row.endDate)}</span>
                        {daysLeft !== null ? (
                          <span className="block text-[10px] text-n400">{daysLeft < 0 ? `${-daysLeft}d ago` : `${daysLeft}d left`}</span>
                        ) : null}
                      </span>
                    );
                  },
                },
                { key: 'termValue', header: 'Per term', align: 'right', width: '110px', render: (row) => <span className="tabular font-semibold">{money(row.termValue)}</span> },
                {
                  key: 'renewal', header: 'Renewal', width: '150px',
                  render: (row) =>
                    row.renewalDeal ? (
                      <Link to={`/deals/${row.renewalDeal.id}`} onClick={(e) => e.stopPropagation()} className="text-[12px]">
                        <span className="block font-semibold underline decoration-dotted underline-offset-2">{row.renewalDeal.reference}</span>
                        <span className="block text-[10px] text-n400">{row.renewalDeal.stage.name}</span>
                      </Link>
                    ) : row.status === 'ACTIVE' || row.status === 'EXPIRING' ? (
                      can('deals', 'create') ? (
                        <Button
                          size="sm"
                          variant="outline"
                          icon={<RefreshCw size={12} />}
                          loading={renew.isPending && renew.variables === row.id}
                          onClick={(e) => { e.stopPropagation(); renew.mutate(row.id); }}
                        >
                          Open
                        </Button>
                      ) : <span className="text-[11px] text-accent">Not opened</span>
                    ) : <span className="text-n400">—</span>,
                },
                { key: 'owner', header: 'Owner', width: '120px', render: (row) => <span className="text-[12px]">{row.owner?.name ?? '—'}</span> },
              ]}
            />
            <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>

      {adding ? <EntitlementModal onClose={() => setAdding(false)} /> : null}
    </>
  );
}

/** Manual entry, for what was sold before Zeus existed or bought outside an invoice. */
function EntitlementModal({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    accountId: '', accountLabel: null as string | null, description: '',
    vendorId: '', quantity: '1', unit: 'licence', unitPrice: '', unitCost: '',
    startDate: new Date().toISOString().slice(0, 10), termMonths: '12',
    vendorRef: '', notes: '', autoRenew: true, ownerId: '',
  });

  const save = useMutation({
    mutationFn: () =>
      api.post('/subscriptions', {
        accountId: form.accountId,
        description: form.description.trim(),
        vendorId: form.vendorId || null,
        quantity: Number(form.quantity) || 1,
        unit: form.unit,
        unitPrice: Number(form.unitPrice) || 0,
        unitCost: Number(form.unitCost) || 0,
        startDate: form.startDate,
        termMonths: Number(form.termMonths) || 12,
        autoRenew: form.autoRenew,
        vendorRef: form.vendorRef || null,
        notes: form.notes || null,
        ownerId: form.ownerId || null,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['renewals-summary'] });
      toast.push('Entitlement recorded.');
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.'),
  });

  const termValue = (Number(form.quantity) || 0) * (Number(form.unitPrice) || 0);

  return (
    <Modal
      open
      onClose={onClose}
      title="Add an entitlement"
      subtitle="Something the customer already owns. Zeus will chase its renewal from here."
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="accent"
            disabled={!form.accountId || !form.description.trim()}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Customer" required>
            <AccountPicker
              value={form.accountId || null}
              selectedLabel={form.accountLabel}
              onChange={(id, row) => setForm({ ...form, accountId: id ?? '', accountLabel: row?.name ?? null })}
            />
          </Field>
          <Field label="Vendor" hint="Whose licence it is — drives the renewals-by-vendor view.">
            <AccountPicker value={form.vendorId || null} type="VENDOR" onChange={(id) => setForm({ ...form, vendorId: id ?? '' })} placeholder="Search vendors…" />
          </Field>
        </div>
        <Field label="What they own" required>
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="CrowdStrike Falcon Pro — 800 endpoints" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Quantity"><Input type="number" min="0" step="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} /></Field>
          <Field label="Unit"><Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} /></Field>
          <Field label="Sell / unit"><Input type="number" min="0" step="0.01" value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} /></Field>
          <Field label="Cost / unit"><Input type="number" min="0" step="0.01" value={form.unitCost} onChange={(e) => setForm({ ...form, unitCost: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Cover starts" required>
            <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
          </Field>
          <Field label="Term (months)" hint="Cover ends the day before the anniversary.">
            <Input type="number" min="1" step="1" value={form.termMonths} onChange={(e) => setForm({ ...form, termMonths: e.target.value })} />
          </Field>
          <Field label="Owner">
            <OwnerSelect value={form.ownerId} onChange={(id) => setForm({ ...form, ownerId: id })} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vendor reference" hint="Licence key or support contract number.">
            <Input value={form.vendorRef} onChange={(e) => setForm({ ...form, vendorRef: e.target.value })} />
          </Field>
          <Field label="Term value">
            <div className="tabular flex h-[38px] items-center border border-line bg-sunken px-3 text-[14px] font-semibold">
              {money(termValue)}
            </div>
          </Field>
        </div>
        <Field label="Notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
