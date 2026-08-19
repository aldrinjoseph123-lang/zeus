import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, ApiError, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorNote, Field, Input, Loading, Modal,
  PageHeader, Pagination, SearchInput, Textarea, useDebounced, useToast,
} from '../components/ui';
import { CustomFieldInputs, type CustomValues } from '../components/customFields';
import { AccountPicker, DuplicateWarning, OwnerSelect, Toolbar, type DuplicateMatch } from '../components/pickers';
import { BulkActionBar, useBulkSelection } from '../components/bulkActions';

interface Contact {
  id: string; firstName: string; lastName: string; email: string | null; phone: string | null;
  mobile: string | null; jobTitle: string | null; department: string | null; isPrimary: boolean;
  account: { id: string; name: string; type: string } | null;
  owner: { id: string; name: string } | null;
}

export default function Contacts() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search, 300);
  const bulk = useBulkSelection();

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', debounced, ownerId, page],
    queryFn: () => api.get<{ data: Contact[]; total: number; totalPages: number; page: number }>(`/contacts${qs({ search: debounced, ownerId, page, pageSize: 25 })}`),
  });

  return (
    <>
      <PageHeader
        title="Contacts"
        description="The people behind the accounts."
        actions={can('contacts', 'create') ? <Button variant="accent" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New contact</Button> : undefined}
      />

      <Card>
        <Toolbar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search name, email, phone, account…" className="w-full sm:w-80" />
          <OwnerSelect value={ownerId} onChange={(v) => { setOwnerId(v); setPage(1); }} className="w-[160px]" />
        </Toolbar>

        {can('contacts', 'update') || can('contacts', 'delete') ? (
          <BulkActionBar
            basePath="/contacts"
            selected={bulk.selected}
            onClear={bulk.clear}
            canAssign={can('contacts', 'update')}
            canDelete={can('contacts', 'delete')}
            queryKey="contacts"
            noun="contact"
          />
        ) : null}

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => row.account && navigate(`/accounts/${row.account.id}`)}
              selection={can('contacts', 'update') || can('contacts', 'delete') ? { selected: bulk.selected, onToggle: bulk.toggle, onToggleAll: bulk.toggleAll } : undefined}
              empty={<EmptyState title="No contacts" message="Contacts arrive when you convert a lead, or add them to an account." />}
              columns={[
                {
                  key: 'name', header: 'Contact',
                  render: (row) => (
                    <span className="flex items-center gap-2">
                      <span>
                        <span className="block font-semibold">{row.firstName} {row.lastName}</span>
                        <span className="block text-[11px] text-muted">{row.jobTitle ?? '—'}{row.department ? ` · ${row.department}` : ''}</span>
                      </span>
                      {row.isPrimary ? <Badge tone="dark">Primary</Badge> : null}
                    </span>
                  ),
                },
                {
                  key: 'account', header: 'Account', width: '220px',
                  render: (row) => row.account
                    ? <Link to={`/accounts/${row.account.id}`} onClick={(e) => e.stopPropagation()} className="text-[12px] font-semibold underline decoration-dotted underline-offset-2">{row.account.name}</Link>
                    : <span className="text-n400">Unlinked</span>,
                },
                { key: 'email', header: 'Email', render: (row) => row.email ? <a href={`mailto:${row.email}`} onClick={(e) => e.stopPropagation()} className="text-[12px] underline decoration-dotted underline-offset-2">{row.email}</a> : <span className="text-n400">—</span> },
                { key: 'phone', header: 'Phone', width: '150px', render: (row) => <span className="text-[12px]">{row.phone ?? row.mobile ?? '—'}</span> },
                { key: 'owner', header: 'Owner', width: '130px', render: (row) => <span className="text-[12px]">{row.owner?.name ?? 'Unassigned'}</span> },
              ]}
            />
            <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>

      {creating ? <ContactForm onClose={() => setCreating(false)} /> : null}
    </>
  );
}

export function ContactForm({ onClose, defaultAccountId, defaultAccountName, onSaved }: {
  onClose: () => void;
  defaultAccountId?: string;
  defaultAccountName?: string;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', mobile: '', jobTitle: '', department: '',
    linkedinUrl: '', accountId: defaultAccountId ?? '', isPrimary: false, description: '',
  });
  const [custom, setCustom] = useState<CustomValues>({});
  const [duplicates, setDuplicates] = useState<{ matches: DuplicateMatch[]; domain: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (ignoreDuplicates: boolean) =>
      api.post('/contacts', { ...form, email: form.email || null, accountId: form.accountId || null, customFields: custom, ignoreDuplicates }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['contacts'] });
      onSaved?.();
      toast.push('Contact created.');
      onClose();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.details) {
        setDuplicates(err.details as { matches: DuplicateMatch[]; domain: string | null });
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the contact.');
      }
    },
  });

  const ready = form.firstName.trim() && form.lastName.trim();

  return (
    <Modal
      open
      onClose={onClose}
      title="New contact"
      footer={
        duplicates ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="accent" disabled={!ready} loading={create.isPending} onClick={() => create.mutate(false)}>Create contact</Button>
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
          <Field label="First name" required><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} autoFocus /></Field>
          <Field label="Last name" required><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
        </div>

        <Field label="Account">
          <AccountPicker value={form.accountId || null} selectedLabel={defaultAccountName} onChange={(id) => setForm({ ...form, accountId: id ?? '' })} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Job title"><Input value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} /></Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Mobile"><Input value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} /></Field>
          <Field label="Department"><Input value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></Field>
        </div>

        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={form.isPrimary} onChange={(e) => setForm({ ...form, isPrimary: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
          Primary contact for this account
        </label>

        <Field label="Notes"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>

        <CustomFieldInputs module="contacts" values={custom} onChange={setCustom} />
      </div>
    </Modal>
  );
}
