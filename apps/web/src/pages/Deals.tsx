import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, LayoutGrid, Plus, Rows3 } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, daysBetween, money, moneyShort, percent } from '../lib/format';
import {
  Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorNote, Field, Input, Loading, Modal,
  PageHeader, Select, Textarea, useToast, cx, SearchInput, Pagination, useDebounced,
} from '../components/ui';
import { CustomFieldInputs, type CustomValues } from '../components/customFields';
import { SavedViews } from '../components/savedViews';
import { AccountPicker, ContactPicker, DuplicateWarning, ListSelect, OwnerSelect, Toolbar, type DuplicateMatch } from '../components/pickers';
import { useUndo } from '../lib/undo';

interface Stage { id: string; name: string; order: number; color: string; probability: number; isWon: boolean; isLost: boolean; rotDays: number }
interface Deal {
  id: string; reference: string; name: string; amount: number | string; totalAmount: number | string;
  probability: number; closeDate: string; status: string; type: string; source: string;
  stageChangedAt: string; createdAt: string; lastActivityAt: string | null;
  account: { id: string; name: string }; partnerAccount: { id: string; name: string } | null;
  stage: Stage; owner: { id: string; name: string; avatarColor: string } | null;
}
interface Board { pipeline: { id: string; name: string; kind: string }; columns: Array<{ stage: Stage; count: number; netTotal: number; weightedTotal: number; deals: Deal[] }> }

export default function Deals() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<'board' | 'list'>((params.get('view') as 'board' | 'list') ?? 'board');
  const [creating, setCreating] = useState(params.get('new') === '1');
  const { can } = useAuth();

  useEffect(() => {
    if (params.get('new') === '1') {
      setCreating(true);
      params.delete('new');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  return (
    <>
      <PageHeader
        title="Deals"
        description="Drag a card to move it through the pipeline. Every move is recorded."
        actions={
          <>
            <div className="flex border border-line bg-card">
              <button
                onClick={() => setView('board')}
                className={cx('flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em]', view === 'board' ? 'bg-n950 text-white' : 'text-muted hover:bg-n50')}
              >
                <LayoutGrid size={13} /> Board
              </button>
              <button
                onClick={() => setView('list')}
                className={cx('flex items-center gap-1.5 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.08em]', view === 'list' ? 'bg-n950 text-white' : 'text-muted hover:bg-n50')}
              >
                <Rows3 size={13} /> List
              </button>
            </div>
            {can('deals', 'create') ? (
              <Button variant="accent" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
                New deal
              </Button>
            ) : null}
          </>
        }
      />

      {view === 'board' ? <DealBoard /> : <DealList />}
      {creating ? <DealForm onClose={() => setCreating(false)} /> : null}
    </>
  );
}

// ── board ─────────────────────────────────────────────────────────────────────

function DealBoard() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { can } = useAuth();

  const [search, setSearch] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const [hoverStage, setHoverStage] = useState<string | null>(null);
  const [lostPrompt, setLostPrompt] = useState<{ dealId: string; stageId: string } | null>(null);
  const debounced = useDebounced(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['deal-board', debounced, ownerId],
    queryFn: () => api.get<Board>(`/deals/board${qs({ search: debounced, ownerId })}`),
  });

  const undo = useUndo();

  const move = useMutation({
    mutationFn: (input: { dealId: string; stageId: string; lostReason?: string; note?: string }) =>
      api.post<{ undoId?: string }>(`/deals/${input.dealId}/stage`, input),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['deal-board'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      // A drag onto the wrong column is the easiest mistake on this screen to make.
      undo.toast('Deal moved.', res.undoId);
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not move the deal.', 'error'),
  });

  if (isLoading) return <Loading label="Loading board" />;
  if (!data) return <EmptyState title="No pipeline configured" message="Create a pipeline in Settings → Pipelines." />;

  const drop = (stage: Stage) => {
    setHoverStage(null);
    if (!dragging) return;
    const dealId = dragging;
    setDragging(null);
    if (stage.isLost) {
      setLostPrompt({ dealId, stageId: stage.id });
      return;
    }
    move.mutate({ dealId, stageId: stage.id });
  };

  return (
    <>
      <Card className="mb-3">
        <Toolbar className="border-b-0">
          <SearchInput value={search} onChange={setSearch} placeholder="Filter this board…" className="w-full sm:w-72" />
          <OwnerSelect value={ownerId} onChange={setOwnerId} className="w-[170px]" />
          <span className="ml-auto text-[11px] uppercase tracking-[0.08em] text-muted">{data.pipeline.name}</span>
        </Toolbar>
      </Card>

      <div className="flex gap-3 overflow-x-auto pb-3">
        {data.columns.map((column) => (
          <div
            key={column.stage.id}
            onDragOver={(e) => { e.preventDefault(); setHoverStage(column.stage.id); }}
            onDragLeave={() => setHoverStage((s) => (s === column.stage.id ? null : s))}
            onDrop={() => drop(column.stage)}
            className={cx(
              'flex w-[272px] shrink-0 flex-col border bg-card transition-colors',
              hoverStage === column.stage.id ? 'border-accent bg-accent-soft' : 'border-line',
            )}
          >
            <div className="border-b border-line px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0" style={{ background: column.stage.color }} />
                <span className="truncate text-[12px] font-bold uppercase tracking-[0.08em]">{column.stage.name}</span>
                <span className="ml-auto text-[11px] text-n400">{column.count}</span>
              </div>
              <div className="tabular mt-1 flex items-baseline justify-between text-[11px]">
                <span className="font-semibold">{moneyShort(column.netTotal)}</span>
                {!column.stage.isWon && !column.stage.isLost ? (
                  <span className="text-muted">{moneyShort(column.weightedTotal)} weighted</span>
                ) : null}
              </div>
            </div>

            <div className="flex max-h-[calc(100vh-320px)] flex-1 flex-col gap-2 overflow-y-auto p-2">
              {column.deals.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] text-n400">Nothing here yet.</p>
              ) : (
                column.deals.map((deal) => {
                  const stuck = (daysBetween(deal.stageChangedAt) ?? 0) > column.stage.rotDays && deal.status === 'OPEN';
                  const overdue = new Date(deal.closeDate) < new Date() && deal.status === 'OPEN';
                  return (
                    <article
                      key={deal.id}
                      draggable={can('deals', 'update')}
                      onDragStart={() => setDragging(deal.id)}
                      onDragEnd={() => setDragging(null)}
                      onClick={() => navigate(`/deals/${deal.id}`)}
                      className={cx(
                        'cursor-pointer border border-line bg-card p-2.5 transition-shadow hover:shadow-[var(--shadow-md)]',
                        dragging === deal.id && 'opacity-40',
                        stuck && 'border-l-[3px] border-l-[var(--status-watch)]',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-[10px] uppercase tracking-[0.08em] text-n400">{deal.reference}</span>
                        {deal.partnerAccount ? <Badge tone="info">Partner</Badge> : null}
                      </div>
                      <h4 className="mt-1 line-clamp-2 text-[13px] font-semibold leading-snug">{deal.name}</h4>
                      <p className="mt-0.5 truncate text-[11px] text-muted">{deal.account.name}</p>

                      <div className="tabular mt-2 flex items-baseline justify-between">
                        <span className="text-[14px] font-bold">{moneyShort(deal.amount)}</span>
                        <span className="text-[10px] text-n400">{deal.probability}%</span>
                      </div>

                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-1.5">
                        <span className={cx('text-[10px] uppercase tracking-[0.06em]', overdue ? 'font-semibold text-accent' : 'text-n400')}>
                          {overdue ? 'overdue' : date(deal.closeDate)}
                        </span>
                        {deal.owner ? (
                          <span className="flex h-5 w-5 items-center justify-center rounded-sharp text-[9px] font-bold text-white" style={{ background: deal.owner.avatarColor }} title={deal.owner.name}>
                            {deal.owner.name.split(' ').slice(0, 2).map((p) => p[0]).join('')}
                          </span>
                        ) : null}
                      </div>

                      {stuck ? (
                        <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--status-watch)]">
                          {daysBetween(deal.stageChangedAt)}d in stage
                        </p>
                      ) : null}
                    </article>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>

      {lostPrompt ? (
        <LostReasonModal
          onClose={() => setLostPrompt(null)}
          onConfirm={(lostReason, note) => {
            move.mutate({ ...lostPrompt, lostReason, note });
            setLostPrompt(null);
          }}
        />
      ) : null}
    </>
  );
}

function LostReasonModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string, note?: string) => void }) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="Mark deal lost"
      subtitle="A reason is required — it feeds the win/loss report."
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!reason} onClick={() => onConfirm(reason, note || undefined)}>Mark lost</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Lost reason" required>
          <ListSelect listKey="lists.lostReasons" value={reason} onChange={setReason} placeholder="Select a reason" />
        </Field>
        <Field label="Note" hint="Optional — added to the deal timeline.">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What actually happened?" />
        </Field>
      </div>
    </Modal>
  );
}

// ── list ──────────────────────────────────────────────────────────────────────

function DealList() {
  const navigate = useNavigate();
  const { can, user } = useAuth();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('OPEN');
  const [ownerId, setOwnerId] = useState('');
  const [type, setType] = useState('');
  const [channel, setChannel] = useState('');
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState('amount');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const debounced = useDebounced(search, 300);
  const queryClient = useQueryClient();

  // Bulk selection across the visible page.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOwner, setBulkOwner] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const clearSelection = () => setSelected(new Set());
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = (ids: string[]) => setSelected((s) => (ids.every((id) => s.has(id)) ? new Set() : new Set(ids)));

  const afterBulk = (msg: string) => {
    clearSelection();
    void queryClient.invalidateQueries({ queryKey: ['deals'] });
    toast.push(msg);
  };
  const bulkAssign = useMutation({
    mutationFn: () => api.post<{ updated: number; skipped: number }>('/deals/bulk-assign', { ids: [...selected], ownerId: bulkOwner }),
    onSuccess: (r) => { setBulkOwner(''); afterBulk(`${r.updated} reassigned${r.skipped ? `, ${r.skipped} skipped` : ''}.`); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not reassign.', 'error'),
  });
  const bulkDelete = useMutation({
    mutationFn: () => api.post<{ deleted: number; skipped: number }>('/deals/bulk-delete', { ids: [...selected] }),
    onSuccess: (r) => { setConfirmDelete(false); afterBulk(`${r.deleted} deleted${r.skipped ? `, ${r.skipped} skipped` : ''}.`); },
    onError: (err) => { setConfirmDelete(false); toast.push(err instanceof ApiError ? err.message : 'Could not delete.', 'error'); },
  });

  const { data, isLoading } = useQuery({
    queryKey: ['deals', debounced, status, ownerId, type, channel, page, sortBy, sortDir],
    queryFn: () =>
      api.get<{ data: Deal[]; total: number; totalPages: number; page: number; totals: { net: number; gross: number } }>(
        `/deals${qs({ search: debounced, status, ownerId, type, hasPartner: channel, page, sortBy, sortDir, pageSize: 25 })}`,
      ),
  });

  const exportList = async (format: 'xlsx' | 'pdf') => {
    try {
      await download(`/reports/pipeline?format=${format}${qs({ ownerId })}`, `zeus-pipeline.${format}`);
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error');
    }
  };

  const sort = (key: string) => {
    if (sortBy === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortBy(key); setSortDir('desc'); }
  };

  return (
    <Card>
      <Toolbar>
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search deals, references, customers…" className="w-full sm:w-72" />
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} placeholder="All statuses" options={[{ value: 'OPEN', label: 'Open' }, { value: 'WON', label: 'Won' }, { value: 'LOST', label: 'Lost' }]} className="w-[130px]" />
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} placeholder="All types" options={[{ value: 'PRODUCT', label: 'Reselling' }, { value: 'SERVICE', label: 'Managed service' }, { value: 'MIXED', label: 'Mixed' }]} className="w-[150px]" />
        <Select value={channel} onChange={(e) => { setChannel(e.target.value); setPage(1); }} placeholder="All channels" options={[{ value: 'true', label: 'Partner-sourced' }, { value: 'false', label: 'Direct' }]} className="w-[150px]" />
        <OwnerSelect value={ownerId} onChange={(v) => { setOwnerId(v); setPage(1); }} className="w-[160px]" />
        <div className="ml-auto flex gap-2">
          <SavedViews
            storageKey={`zeus.views.deals.${user?.id ?? 'anon'}`}
            current={{ search, status, ownerId, type, channel, sortBy, sortDir }}
            onApply={(f) => {
              setSearch((f.search as string) ?? '');
              setStatus((f.status as string) ?? 'OPEN');
              setOwnerId((f.ownerId as string) ?? '');
              setType((f.type as string) ?? '');
              setChannel((f.channel as string) ?? '');
              setSortBy((f.sortBy as string) ?? 'amount');
              setSortDir((f.sortDir as 'asc' | 'desc') ?? 'desc');
              setPage(1);
            }}
          />
          {can('deals', 'export') ? (
            <>
              <Button size="sm" icon={<Download size={13} />} onClick={() => exportList('xlsx')}>Excel</Button>
              <Button size="sm" icon={<Download size={13} />} onClick={() => exportList('pdf')}>PDF</Button>
            </>
          ) : null}
        </div>
      </Toolbar>

      {data?.totals ? (
        <div className="flex flex-wrap gap-6 border-b border-line bg-sunken px-3 py-2">
          <span className="text-[12px] text-muted">Net total <strong className="tabular ml-1 text-[14px] text-ink">{money(data.totals.net)}</strong></span>
          <span className="text-[12px] text-muted">Incl. VAT <strong className="tabular ml-1 text-[14px] text-ink">{money(data.totals.gross)}</strong></span>
        </div>
      ) : null}

      {selected.size > 0 && (can('deals', 'update') || can('deals', 'delete')) ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-3 py-2">
          <span className="text-[12px] font-semibold">{selected.size} selected</span>
          {can('deals', 'update') ? (
            <span className="flex items-center gap-1.5">
              <OwnerSelect value={bulkOwner} onChange={setBulkOwner} className="w-[170px]" />
              <Button size="sm" disabled={!bulkOwner || bulkAssign.isPending} loading={bulkAssign.isPending} onClick={() => bulkAssign.mutate()}>Assign</Button>
            </span>
          ) : null}
          {can('deals', 'delete') ? (
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
          ) : null}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={clearSelection}>Clear</Button>
        </div>
      ) : null}

      {isLoading ? (
        <Loading />
      ) : (
        <>
          <DataTable
            rows={data?.data ?? []}
            rowKey={(row) => row.id}
            onRowClick={(row) => navigate(`/deals/${row.id}`)}
            selection={can('deals', 'update') || can('deals', 'delete') ? { selected, onToggle: toggle, onToggleAll: toggleAll } : undefined}
            sortBy={sortBy}
            sortDir={sortDir}
            onSort={sort}
            empty={<EmptyState title="No deals match" message="Adjust the filters, or create the first deal." />}
            columns={[
              { key: 'reference', header: 'Ref', width: '92px', render: (row: Deal) => <span className="text-[11px] uppercase tracking-[0.06em] text-muted">{row.reference}</span> },
              {
                key: 'name', header: 'Deal', sortable: true,
                render: (row) => (
                  <span>
                    <span className="block font-semibold">{row.name}</span>
                    <span className="block text-[11px] text-muted">
                      {row.account.name}
                      {row.partnerAccount ? <> · via {row.partnerAccount.name}</> : null}
                    </span>
                  </span>
                ),
              },
              {
                key: 'stage', header: 'Stage', width: '132px',
                render: (row) => (
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 shrink-0" style={{ background: row.stage.color }} />
                    <span className="truncate text-[12px]">{row.stage.name}</span>
                  </span>
                ),
              },
              { key: 'type', header: 'Type', width: '90px', render: (row) => <Badge tone={row.type === 'SERVICE' ? 'info' : 'neutral'}>{row.type === 'SERVICE' ? 'Service' : row.type === 'MIXED' ? 'Mixed' : 'Product'}</Badge> },
              { key: 'amount', header: 'Net (AED)', align: 'right', sortable: true, width: '116px', render: (row) => <span className="tabular font-semibold">{money(row.amount)}</span> },
              { key: 'probability', header: 'Prob', align: 'right', sortable: true, width: '64px', render: (row) => <span className="tabular text-muted">{percent(row.probability)}</span> },
              { key: 'closeDate', header: 'Close', sortable: true, width: '106px', render: (row) => <span className={cx('text-[12px]', new Date(row.closeDate) < new Date() && row.status === 'OPEN' && 'font-semibold text-accent')}>{date(row.closeDate)}</span> },
              { key: 'source', header: 'Source', width: '116px', render: (row) => <span className="text-[12px] text-muted">{row.source}</span> },
              { key: 'owner', header: 'Owner', width: '124px', render: (row) => <span className="text-[12px]">{row.owner?.name ?? 'Unassigned'}</span> },
            ]}
          />
          <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
        </>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete selected deals?"
        message={`${selected.size} deal${selected.size === 1 ? '' : 's'} will be removed. You can restore them from the audit trail.`}
        confirmLabel="Delete"
        danger
        loading={bulkDelete.isPending}
        onConfirm={() => bulkDelete.mutate()}
        onClose={() => setConfirmDelete(false)}
      />
    </Card>
  );
}

// ── create ────────────────────────────────────────────────────────────────────

export function DealForm({ onClose, defaultAccountId, defaultAccountName }: { onClose: () => void; defaultAccountId?: string; defaultAccountName?: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: '',
    accountId: defaultAccountId ?? '',
    partnerAccountId: '',
    primaryContactId: '',
    type: 'PRODUCT',
    amount: '',
    source: 'Database',
    closeDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    stageId: '',
    description: '',
    nextStep: '',
  });
  const [custom, setCustom] = useState<CustomValues>({});
  const [duplicates, setDuplicates] = useState<{ matches: DuplicateMatch[]; domain: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: pipelines } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api.get<Array<{ id: string; name: string; isDefault: boolean; stages: Stage[] }>>('/pipelines'),
  });
  const pipeline = pipelines?.find((p) => p.isDefault) ?? pipelines?.[0];

  const create = useMutation({
    mutationFn: (ignoreDuplicates: boolean) =>
      api.post<Deal>('/deals', {
        name: form.name,
        accountId: form.accountId,
        partnerAccountId: form.partnerAccountId || null,
        primaryContactId: form.primaryContactId || null,
        type: form.type,
        amount: Number(form.amount || 0),
        source: form.source,
        closeDate: form.closeDate,
        stageId: form.stageId || undefined,
        description: form.description || null,
        nextStep: form.nextStep || null,
        customFields: custom,
        ignoreDuplicates,
      }),
    onSuccess: (deal) => {
      void queryClient.invalidateQueries({ queryKey: ['deal-board'] });
      void queryClient.invalidateQueries({ queryKey: ['deals'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.push(`${deal.reference} created.`);
      onClose();
      navigate(`/deals/${deal.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.details) {
        const details = err.details as { matches: DuplicateMatch[]; domain: string | null };
        setDuplicates(details);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the deal.');
      }
    },
  });

  const canSubmit = form.name.trim() && form.accountId;

  return (
    <Modal
      open
      onClose={onClose}
      title="New deal"
      subtitle="End customer is required. Add a partner when one introduced the opportunity."
      footer={
        duplicates ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="accent" disabled={!canSubmit} loading={create.isPending} onClick={() => create.mutate(false)}>Create deal</Button>
          </>
        )
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        {duplicates ? (
          <DuplicateWarning
            matches={duplicates.matches}
            domain={duplicates.domain}
            busy={create.isPending}
            onCancel={() => setDuplicates(null)}
            onProceed={() => create.mutate(true)}
          />
        ) : null}

        <Field label="Deal name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Emirates NBD — MDR renewal" autoFocus />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="End customer" required hint="The company that consumes the product or service.">
            <AccountPicker
              value={form.accountId || null}
              selectedLabel={defaultAccountName}
              onChange={(id) => setForm({ ...form, accountId: id ?? '', primaryContactId: '' })}
            />
          </Field>
          <Field label="Partner" hint="Optional — the reseller who brought this in.">
            <AccountPicker value={form.partnerAccountId || null} type="PARTNER" onChange={(id) => setForm({ ...form, partnerAccountId: id ?? '' })} placeholder="Search partners…" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Primary contact">
            <ContactPicker value={form.primaryContactId || null} accountId={form.accountId || null} onChange={(id) => setForm({ ...form, primaryContactId: id ?? '' })} />
          </Field>
          <Field label="Source">
            <ListSelect listKey="lists.leadSources" value={form.source} onChange={(v) => setForm({ ...form, source: v })} />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Net value (AED)" hint="Excluding VAT.">
            <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={[{ value: 'PRODUCT', label: 'Product reselling' }, { value: 'SERVICE', label: 'Managed service' }, { value: 'MIXED', label: 'Mixed' }]} />
          </Field>
          <Field label="Expected close">
            <Input type="date" value={form.closeDate} onChange={(e) => setForm({ ...form, closeDate: e.target.value })} />
          </Field>
        </div>

        {pipeline ? (
          <Field label="Starting stage">
            <Select
              value={form.stageId}
              onChange={(e) => setForm({ ...form, stageId: e.target.value })}
              placeholder={`${pipeline.stages[0]?.name ?? 'First stage'} (default)`}
              options={pipeline.stages.filter((s) => !s.isWon && !s.isLost).map((s) => ({ value: s.id, label: `${s.name} — ${s.probability}%` }))}
            />
          </Field>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Next step">
            <Input value={form.nextStep} onChange={(e) => setForm({ ...form, nextStep: e.target.value })} placeholder="e.g. Send scoping questionnaire" />
          </Field>
          <Field label="Notes">
            <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
        </div>

        <CustomFieldInputs module="deals" values={custom} onChange={setCustom} />
      </div>
    </Modal>
  );
}
