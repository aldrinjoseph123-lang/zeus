import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorNote, Field, Input, Loading, Modal,
  PageHeader, Pagination, SearchInput, Select, Textarea, useDebounced, useToast,
} from '../components/ui';
import { CustomFieldInputs, type CustomValues } from '../components/customFields';
import { DuplicateWarning, ListSelect, OwnerSelect, Toolbar, type DuplicateMatch } from '../components/pickers';
import { BulkActionBar, useBulkSelection } from '../components/bulkActions';

export interface Account {
  id: string; name: string; type: string; domain: string | null; industry: string | null;
  emirate: string | null; city: string | null; phone: string | null; email: string | null;
  lastActivityAt: string | null; createdAt: string;
  owner: { id: string; name: string } | null;
  _count: { contacts: number; deals: number };
}

const TYPE_TONE: Record<string, 'neutral' | 'info' | 'secure' | 'dark'> = {
  CUSTOMER: 'secure', PARTNER: 'info', VENDOR: 'dark', PROSPECT: 'neutral',
};

export default function Accounts() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [industry, setIndustry] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [stale, setStale] = useState(false);
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search, 300);
  const bulk = useBulkSelection();

  const { data, isLoading } = useQuery({
    queryKey: ['accounts', debounced, type, industry, ownerId, stale, page],
    queryFn: () =>
      api.get<{ data: Account[]; total: number; totalPages: number; page: number }>(
        `/accounts${qs({ search: debounced, type, industry, ownerId, stale: stale || undefined, page, pageSize: 25 })}`,
      ),
  });

  const exportAccounts = async (format: 'xlsx' | 'pdf') => {
    try {
      await download(`/reports/${stale ? 'stale-accounts' : 'accounts'}?format=${format}${qs({ type })}`, `zeus-accounts.${format}`);
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Customers, partners and vendors. One record per company domain."
        actions={can('accounts', 'create') ? <Button variant="accent" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New account</Button> : undefined}
      />

      <Card>
        <Toolbar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search name, domain, TRN…" className="w-full sm:w-72" />
          <Select
            value={type}
            onChange={(e) => { setType(e.target.value); setPage(1); }}
            placeholder="All types"
            options={[{ value: 'CUSTOMER', label: 'Customers' }, { value: 'PARTNER', label: 'Partners' }, { value: 'VENDOR', label: 'Vendors' }, { value: 'PROSPECT', label: 'Prospects' }]}
            className="w-[140px]"
          />
          <ListSelect listKey="lists.industries" value={industry} onChange={(v) => { setIndustry(v); setPage(1); }} placeholder="All industries" className="w-[170px]" />
          <OwnerSelect value={ownerId} onChange={(v) => { setOwnerId(v); setPage(1); }} className="w-[150px]" />
          <button
            onClick={() => { setStale(!stale); setPage(1); }}
            className={
              stale
                ? 'rounded-sharp border border-accent bg-accent px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-white'
                : 'rounded-sharp border border-line bg-card px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted hover:border-n900 hover:text-ink'
            }
          >
            Stale only
          </button>
          {can('accounts', 'export') ? (
            <div className="ml-auto flex gap-2">
              <Button size="sm" icon={<Download size={13} />} onClick={() => exportAccounts('xlsx')}>Excel</Button>
              <Button size="sm" icon={<Download size={13} />} onClick={() => exportAccounts('pdf')}>PDF</Button>
            </div>
          ) : null}
        </Toolbar>

        {can('accounts', 'update') || can('accounts', 'delete') ? (
          <BulkActionBar
            basePath="/accounts"
            selected={bulk.selected}
            onClear={bulk.clear}
            canAssign={can('accounts', 'update')}
            canDelete={can('accounts', 'delete')}
            queryKey="accounts"
            noun="account"
          />
        ) : null}

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/accounts/${row.id}`)}
              selection={can('accounts', 'update') || can('accounts', 'delete') ? { selected: bulk.selected, onToggle: bulk.toggle, onToggleAll: bulk.toggleAll } : undefined}
              empty={<EmptyState title="No accounts match" message="Create one, or import your existing list." />}
              columns={[
                {
                  key: 'name', header: 'Account',
                  render: (row) => (
                    <span>
                      <span className="block font-semibold">{row.name}</span>
                      <span className="block text-[11px] text-muted">{row.domain ?? 'No domain on file'}</span>
                    </span>
                  ),
                },
                { key: 'type', header: 'Type', width: '104px', render: (row) => <Badge tone={TYPE_TONE[row.type] ?? 'neutral'}>{row.type}</Badge> },
                { key: 'industry', header: 'Industry', width: '150px', render: (row) => <span className="text-[12px]">{row.industry ?? '—'}</span> },
                { key: 'emirate', header: 'Emirate', width: '110px', render: (row) => <span className="text-[12px] text-muted">{row.emirate ?? '—'}</span> },
                { key: 'contacts', header: 'Contacts', align: 'right', width: '80px', render: (row) => <span className="tabular">{row._count.contacts}</span> },
                { key: 'deals', header: 'Deals', align: 'right', width: '70px', render: (row) => <span className="tabular">{row._count.deals}</span> },
                {
                  key: 'lastActivityAt', header: 'Last activity', width: '128px',
                  render: (row) => {
                    const days = row.lastActivityAt ? Math.floor((Date.now() - new Date(row.lastActivityAt).getTime()) / 86_400_000) : null;
                    return <span className={days === null || days > 7 ? 'text-[12px] font-semibold text-accent' : 'text-[12px] text-muted'}>{relative(row.lastActivityAt)}</span>;
                  },
                },
                { key: 'owner', header: 'Owner', width: '124px', render: (row) => <span className="text-[12px]">{row.owner?.name ?? 'Unassigned'}</span> },
              ]}
            />
            <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>

      {creating ? <AccountForm onClose={() => setCreating(false)} /> : null}
    </>
  );
}

export function AccountForm({ onClose, defaultType }: { onClose: () => void; defaultType?: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const [form, setForm] = useState({
    name: '', type: defaultType ?? 'PROSPECT', domain: '', website: '', industry: '', employeeBand: '',
    phone: '', email: '', trn: '', addressLine1: '', city: '', emirate: '', poBox: '', linkedinUrl: '', description: '',
  });
  const [custom, setCustom] = useState<CustomValues>({});
  const [duplicates, setDuplicates] = useState<{ matches: DuplicateMatch[]; domain: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (ignoreDuplicates: boolean) => api.post<Account>('/accounts', { ...form, customFields: custom, ignoreDuplicates }),
    onSuccess: (account) => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.push('Account created.');
      onClose();
      navigate(`/accounts/${account.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.details) {
        setDuplicates(err.details as { matches: DuplicateMatch[]; domain: string | null });
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the account.');
      }
    },
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="New account"
      subtitle="The domain is what Zeus matches on — fill it in and duplicates stop happening."
      footer={
        duplicates ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="accent" disabled={!form.name.trim()} loading={create.isPending} onClick={() => create.mutate(false)}>Create account</Button>
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

        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="Account name" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Legal or trading name" autoFocus />
          </Field>
          <Field label="Type">
            <Select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              options={[{ value: 'CUSTOMER', label: 'Customer' }, { value: 'PROSPECT', label: 'Prospect' }, { value: 'PARTNER', label: 'Partner' }, { value: 'VENDOR', label: 'Vendor' }]}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Domain" hint="e.g. emiratesnbd.com — the duplicate key.">
            <Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} placeholder="company.ae" />
          </Field>
          <Field label="Website">
            <Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="https://…" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Industry"><ListSelect listKey="lists.industries" value={form.industry} onChange={(v) => setForm({ ...form, industry: v })} placeholder="—" /></Field>
          <Field label="Employees"><ListSelect listKey="lists.employeeBands" value={form.employeeBand} onChange={(v) => setForm({ ...form, employeeBand: v })} placeholder="—" /></Field>
          <Field label="Emirate"><ListSelect listKey="lists.emirates" value={form.emirate} onChange={(v) => setForm({ ...form, emirate: v })} placeholder="—" /></Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="TRN" hint="Printed on quotes and invoices."><Input value={form.trn} onChange={(e) => setForm({ ...form, trn: e.target.value })} placeholder="15 digits" /></Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label="Address"><Input value={form.addressLine1} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} /></Field>
          <Field label="City"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
          <Field label="P.O. Box"><Input value={form.poBox} onChange={(e) => setForm({ ...form, poBox: e.target.value })} /></Field>
        </div>

        <Field label="Notes"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>

        <CustomFieldInputs module="accounts" values={custom} onChange={setCustom} />
      </div>
    </Modal>
  );
}
