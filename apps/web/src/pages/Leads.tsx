import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money, relative } from '../lib/format';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorNote, Field, Input, Loading, Modal,
  PageHeader, Pagination, SearchInput, Select, Textarea, useDebounced, useToast,
} from '../components/ui';
import { CustomFieldInputs, type CustomValues } from '../components/customFields';
import { AccountPicker, DuplicateWarning, ListSelect, OwnerSelect, Toolbar, type DuplicateMatch } from '../components/pickers';
import { LifecycleMini, leadTrack } from '../components/lifecycle';
import { BulkActionBar, useBulkSelection } from '../components/bulkActions';

export interface Lead {
  id: string; firstName: string; lastName: string; company: string; domain: string | null;
  email: string | null; phone: string | null; jobTitle: string | null; source: string; status: string;
  rating: string | null; interestArea: string | null; estimatedValue: string | number | null;
  createdAt: string; lastActivityAt: string | null; owner: { id: string; name: string } | null;
}

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'watch' | 'secure' | 'accent'> = {
  NEW: 'info', WORKING: 'watch', NURTURING: 'neutral', QUALIFIED: 'secure', CONVERTED: 'secure', DISQUALIFIED: 'accent',
};

export default function Leads() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const bulk = useBulkSelection();
  const debounced = useDebounced(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['leads', debounced, status, source, ownerId, page],
    queryFn: () => api.get<{ data: Lead[]; total: number; totalPages: number; page: number }>(`/leads${qs({ search: debounced, status, source, ownerId, page, pageSize: 25 })}`),
  });

  const exportLeads = async (format: 'xlsx' | 'pdf') => {
    try {
      await download(`/reports/leads?format=${format}${qs({ status, source })}`, `zeus-leads.${format}`);
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Leads"
        description="Unqualified interest. Convert a lead to create the account, contact and deal in one step."
        actions={can('leads', 'create') ? <Button variant="accent" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New lead</Button> : undefined}
      />

      <Card>
        <Toolbar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search name, company, email, domain…" className="w-full sm:w-72" />
          <Select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            placeholder="All statuses"
            options={['NEW', 'WORKING', 'NURTURING', 'QUALIFIED', 'CONVERTED', 'DISQUALIFIED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
            className="w-[150px]"
          />
          <ListSelect listKey="lists.leadSources" value={source} onChange={(v) => { setSource(v); setPage(1); }} placeholder="All sources" className="w-[160px]" />
          <OwnerSelect value={ownerId} onChange={(v) => { setOwnerId(v); setPage(1); }} className="w-[160px]" />
          {can('leads', 'export') ? (
            <div className="ml-auto flex gap-2">
              <Button size="sm" icon={<Download size={13} />} onClick={() => exportLeads('xlsx')}>Excel</Button>
              <Button size="sm" icon={<Download size={13} />} onClick={() => exportLeads('pdf')}>PDF</Button>
            </div>
          ) : null}
        </Toolbar>

        {can('leads', 'update') || can('leads', 'delete') ? (
          <BulkActionBar
            basePath="/leads"
            selected={bulk.selected}
            onClear={bulk.clear}
            canAssign={can('leads', 'update')}
            canDelete={can('leads', 'delete')}
            queryKey="leads"
            noun="lead"
          />
        ) : null}

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/leads/${row.id}`)}
              selection={can('leads', 'update') || can('leads', 'delete') ? { selected: bulk.selected, onToggle: bulk.toggle, onToggleAll: bulk.toggleAll } : undefined}
              empty={<EmptyState title="No leads yet" message="Add leads by hand, or bring a spreadsheet in through Import." />}
              columns={[
                {
                  key: 'name', header: 'Lead',
                  render: (row) => (
                    <span>
                      <span className="block font-semibold">{row.firstName} {row.lastName}</span>
                      <span className="block text-[11px] text-muted">{row.company}{row.jobTitle ? ` · ${row.jobTitle}` : ''}</span>
                    </span>
                  ),
                },
                {
                  key: 'contact', header: 'Contact', width: '190px',
                  render: (row) => (
                    <span>
                      {row.email ? <a href={`mailto:${row.email}`} onClick={(e) => e.stopPropagation()} className="block truncate text-[12px] underline decoration-dotted underline-offset-2">{row.email}</a> : <span className="block text-[12px] text-n400">No email</span>}
                      {row.phone ? <span className="block text-[11px] text-muted">{row.phone}</span> : null}
                    </span>
                  ),
                },
                { key: 'source', header: 'Source', width: '124px', render: (row) => <span className="text-[12px]">{row.source}</span> },
                { key: 'status', header: 'Status', width: '108px', render: (row) => <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge> },
                { key: 'track', header: 'Progress', width: '88px', render: (row) => <LifecycleMini track={leadTrack(row.status)} /> },
                { key: 'rating', header: 'Rating', width: '78px', render: (row) => row.rating ? <Badge tone={row.rating === 'Hot' ? 'accent' : row.rating === 'Warm' ? 'watch' : 'neutral'}>{row.rating}</Badge> : <span className="text-n400">—</span> },
                { key: 'estimatedValue', header: 'Est. value', align: 'right', width: '112px', render: (row) => <span className="tabular">{row.estimatedValue ? money(row.estimatedValue) : '—'}</span> },
                { key: 'createdAt', header: 'Added', width: '104px', render: (row) => <span className="text-[12px] text-muted">{date(row.createdAt)}</span> },
                { key: 'lastActivityAt', header: 'Last touch', width: '112px', render: (row) => <span className="text-[12px] text-muted">{relative(row.lastActivityAt)}</span> },
                { key: 'owner', header: 'Owner', width: '124px', render: (row) => <span className="text-[12px]">{row.owner?.name ?? 'Unassigned'}</span> },
              ]}
            />
            <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>

      {creating ? <LeadForm onClose={() => setCreating(false)} /> : null}
    </>
  );
}

function LeadForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    firstName: '', lastName: '', company: '', email: '', phone: '', jobTitle: '',
    source: 'Database', sourcePartnerId: '', rating: 'Warm', interestArea: '',
    estimatedValue: '', emirate: '', linkedinUrl: '', description: '',
  });
  const [custom, setCustom] = useState<CustomValues>({});
  const [duplicates, setDuplicates] = useState<{ matches: DuplicateMatch[]; domain: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (ignoreDuplicates: boolean) =>
      api.post<Lead>('/leads', {
        ...form,
        email: form.email || null,
        estimatedValue: form.estimatedValue ? Number(form.estimatedValue) : null,
        sourcePartnerId: form.sourcePartnerId || null,
        customFields: custom,
        ignoreDuplicates,
      }),
    onSuccess: (lead) => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      toast.push('Lead created.');
      onClose();
      navigate(`/leads/${lead.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.details) {
        setDuplicates(err.details as { matches: DuplicateMatch[]; domain: string | null });
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the lead.');
      }
    },
  });

  const ready = form.firstName.trim() && form.lastName.trim() && form.company.trim();

  return (
    <Modal
      open
      onClose={onClose}
      title="New lead"
      subtitle="Zeus checks the email domain against existing accounts and leads before saving."
      footer={
        duplicates ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="accent" disabled={!ready} loading={create.isPending} onClick={() => create.mutate(false)}>Create lead</Button>
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

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" required>
            <Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} autoFocus />
          </Field>
          <Field label="Last name" required>
            <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </Field>
        </div>

        <Field label="Company" required>
          <Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Legal or trading name" />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Work email" hint="Used for duplicate detection.">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.ae" />
          </Field>
          <Field label="Phone">
            <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+971 …" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Job title">
            <Input value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
          </Field>
          <Field label="LinkedIn">
            <Input value={form.linkedinUrl} onChange={(e) => setForm({ ...form, linkedinUrl: e.target.value })} placeholder="linkedin.com/in/…" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Source">
            <ListSelect listKey="lists.leadSources" value={form.source} onChange={(v) => setForm({ ...form, source: v })} />
          </Field>
          <Field label="Rating">
            <ListSelect listKey="lists.ratings" value={form.rating} onChange={(v) => setForm({ ...form, rating: v })} />
          </Field>
          <Field label="Emirate">
            <ListSelect listKey="lists.emirates" value={form.emirate} onChange={(v) => setForm({ ...form, emirate: v })} placeholder="—" />
          </Field>
        </div>

        {form.source.toLowerCase().includes('partner') ? (
          <Field label="Referring partner" hint="Carried through to the deal when this lead converts.">
            <AccountPicker value={form.sourcePartnerId || null} type="PARTNER" onChange={(id) => setForm({ ...form, sourcePartnerId: id ?? '' })} placeholder="Search partners…" />
          </Field>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Interest area">
            <ListSelect listKey="lists.productCategories" value={form.interestArea} onChange={(v) => setForm({ ...form, interestArea: v })} placeholder="What are they after?" />
          </Field>
          <Field label="Estimated value (AED)">
            <Input type="number" min="0" step="1000" value={form.estimatedValue} onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })} />
          </Field>
        </div>

        <Field label="Notes">
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Context, requirement, timing…" />
        </Field>

        <CustomFieldInputs module="leads" values={custom} onChange={setCustom} />
      </div>
    </Modal>
  );
}
