import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Merge, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money, relative } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, DataTable, DefinitionList, EmptyState, ErrorNote,
  Field, Input, Loading, Modal, PageHeader, Select, StatTile, Tabs, Textarea, useToast,
} from '../components/ui';
import { AccountPicker, ListSelect, OwnerSelect } from '../components/pickers';
import { ActivityPanel, type ActivityRecord } from '../components/timeline';
import { AttachmentPanel } from '../components/attachments';
import { CustomFieldInputs, CustomFieldValues, type CustomValues } from '../components/customFields';
import { LifecycleRail, accountHint, accountJourney } from '../components/lifecycle';
import { DealForm } from './Deals';
import { ContactForm } from './Contacts';
import { useUndo } from '../lib/undo';

interface AccountFull {
  id: string; name: string; type: string; domain: string | null; website: string | null;
  industry: string | null; employeeBand: string | null; phone: string | null; email: string | null;
  trn: string | null; addressLine1: string | null; addressLine2: string | null; city: string | null;
  emirate: string | null; country: string; poBox: string | null; linkedinUrl: string | null;
  description: string | null; lastActivityAt: string | null; createdAt: string; customFields: CustomValues;
  owner: { id: string; name: string } | null;
  contacts: Array<{ id: string; firstName: string; lastName: string; email: string | null; phone: string | null; jobTitle: string | null; isPrimary: boolean }>;
  deals: Array<{ id: string; reference: string; name: string; amount: string | number; status: string; closeDate: string; stage: { name: string; color: string }; owner: { name: string } | null }>;
  quotes: Array<{ id: string; number: string; status: string; total: string | number; issueDate: string }>;
  invoices: Array<{ id: string; number: string; status: string; total: string | number; dueDate: string | null }>;
  activities: ActivityRecord[];
}

export default function AccountDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const undo = useUndo();
  const { can } = useAuth();

  const [tab, setTab] = useState('deals');
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [addingDeal, setAddingDeal] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: account, isLoading, error } = useQuery({
    queryKey: ['account', id],
    queryFn: () => api.get<AccountFull>(`/accounts/${id}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['account', id] });
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const remove = useMutation({
    mutationFn: () => api.del<{ undoId?: string }>(`/accounts/${id}`),
    onSuccess: (res) => { undo.toast('Account deleted.', res.undoId); navigate('/accounts'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not delete.', 'error'),
  });

  if (isLoading) return <Loading />;
  if (error || !account) return <EmptyState title="Account not found" message={(error as Error)?.message} action={<Link to="/accounts"><Button>Back to accounts</Button></Link>} />;

  const openDeals = account.deals.filter((d) => d.status === 'OPEN');
  const wonDeals = account.deals.filter((d) => d.status === 'WON');
  const openValue = openDeals.reduce((sum, d) => sum + Number(d.amount), 0);
  const wonValue = wonDeals.reduce((sum, d) => sum + Number(d.amount), 0);
  const quiet = account.lastActivityAt ? Math.floor((Date.now() - new Date(account.lastActivityAt).getTime()) / 86_400_000) : null;

  return (
    <>
      <Link to="/accounts" className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted transition-colors hover:text-ink">
        <ArrowLeft size={13} /> All accounts
      </Link>

      <PageHeader
        title={account.name}
        description={[account.type, account.domain, account.industry, account.emirate].filter(Boolean).join(' · ')}
        actions={
          <>
            {can('deals', 'create') ? <Button icon={<Plus size={14} />} onClick={() => setAddingDeal(true)}>New deal</Button> : null}
            {can('accounts', 'update') ? <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit</Button> : null}
            {can('accounts', 'delete') ? <Button icon={<Merge size={14} />} onClick={() => setMerging(true)}>Merge</Button> : null}
            {can('accounts', 'delete') ? <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Delete</Button> : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Open pipeline" value={money(openValue)} sub={`${openDeals.length} open deal${openDeals.length === 1 ? '' : 's'}`} />
        <StatTile label="Closed won" value={money(wonValue)} sub={`${wonDeals.length} deal${wonDeals.length === 1 ? '' : 's'}`} tone="secure" />
        <StatTile label="Contacts" value={account.contacts.length} sub={account.contacts.find((c) => c.isPrimary) ? `Primary: ${account.contacts.find((c) => c.isPrimary)!.firstName}` : 'No primary set'} />
        <StatTile
          label="Last activity"
          value={quiet === null ? 'Never' : `${quiet}d`}
          sub={relative(account.lastActivityAt)}
          tone={quiet === null || quiet > 7 ? 'watch' : 'default'}
        />
      </div>

      <Card className="mt-3">
        <LifecycleRail
          title="Relationship"
          track={accountJourney(account)}
          hint={{
            ...accountHint(account),
            cta: !account.deals.length && can('deals', 'create')
              ? { label: 'New deal', onClick: () => setAddingDeal(true) }
              : undefined,
          }}
        />
      </Card>

      <div className="mt-3 grid gap-3 xl:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Company" />
            <div className="px-4 py-4">
              <DefinitionList
                items={[
                  { label: 'Type', value: <Badge tone={account.type === 'CUSTOMER' ? 'secure' : account.type === 'PARTNER' ? 'info' : 'neutral'}>{account.type}</Badge> },
                  { label: 'Domain', value: account.domain ?? '—' },
                  { label: 'Website', value: account.website ? <a href={account.website.startsWith('http') ? account.website : `https://${account.website}`} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2">{account.website}</a> : '—' },
                  { label: 'Industry', value: account.industry ?? '—' },
                  { label: 'Employees', value: account.employeeBand ?? '—' },
                  { label: 'TRN', value: account.trn ?? '—' },
                  { label: 'Phone', value: account.phone ?? '—' },
                  { label: 'Email', value: account.email ? <a href={`mailto:${account.email}`} className="underline decoration-dotted underline-offset-2">{account.email}</a> : '—' },
                  { label: 'Address', value: [account.addressLine1, account.poBox ? `P.O. Box ${account.poBox}` : null, account.city, account.emirate, account.country].filter(Boolean).join(', ') || '—' },
                  { label: 'Owner', value: account.owner?.name ?? 'Unassigned' },
                ]}
              />
              {account.description ? (
                <div className="mt-4 border-t border-line pt-3">
                  <span className="eyebrow">Notes</span>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-n600">{account.description}</p>
                </div>
              ) : null}
              <CustomFieldValues module="accounts" values={account.customFields} />
            </div>
          </Card>

          <Card>
            <Tabs
              tabs={[
                { key: 'deals', label: 'Deals', count: account.deals.length },
                { key: 'contacts', label: 'Contacts', count: account.contacts.length },
                { key: 'commercial', label: 'Quotes', count: account.quotes.length + account.invoices.length },
              ]}
              active={tab}
              onChange={setTab}
            />

            {tab === 'deals' ? (
              account.deals.length === 0 ? (
                <EmptyState title="No deals yet" message="Start the first opportunity with this account." action={can('deals', 'create') ? <Button variant="accent" size="sm" onClick={() => setAddingDeal(true)}>New deal</Button> : undefined} />
              ) : (
                <DataTable
                  dense
                  rows={account.deals}
                  rowKey={(row) => row.id}
                  onRowClick={(row) => navigate(`/deals/${row.id}`)}
                  columns={[
                    { key: 'name', header: 'Deal', render: (row) => <span><span className="block font-semibold">{row.name}</span><span className="block text-[11px] text-muted">{row.reference}</span></span> },
                    { key: 'stage', header: 'Stage', width: '120px', render: (row) => <span className="flex items-center gap-1.5"><span className="h-2 w-2" style={{ background: row.stage.color }} /><span className="text-[12px]">{row.stage.name}</span></span> },
                    { key: 'amount', header: 'Net', align: 'right', width: '106px', render: (row) => <span className="tabular font-semibold">{money(row.amount)}</span> },
                    { key: 'closeDate', header: 'Close', width: '100px', render: (row) => <span className="text-[12px] text-muted">{date(row.closeDate)}</span> },
                  ]}
                />
              )
            ) : tab === 'contacts' ? (
              <>
                {can('contacts', 'create') ? (
                  <div className="flex justify-end border-b border-line px-3 py-2">
                    <Button size="sm" icon={<Plus size={13} />} onClick={() => setAddingContact(true)}>Add contact</Button>
                  </div>
                ) : null}
                {account.contacts.length === 0 ? (
                  <EmptyState title="No contacts" message="Add the people you actually deal with." />
                ) : (
                  <DataTable
                    dense
                    rows={account.contacts}
                    rowKey={(row) => row.id}
                    columns={[
                      {
                        key: 'name', header: 'Contact',
                        render: (row) => (
                          <span className="flex items-center gap-2">
                            <span>
                              <span className="block font-semibold">{row.firstName} {row.lastName}</span>
                              <span className="block text-[11px] text-muted">{row.jobTitle ?? '—'}</span>
                            </span>
                            {row.isPrimary ? <Badge tone="dark">Primary</Badge> : null}
                          </span>
                        ),
                      },
                      { key: 'email', header: 'Email', render: (row) => row.email ? <a href={`mailto:${row.email}`} className="text-[12px] underline decoration-dotted underline-offset-2">{row.email}</a> : <span className="text-n400">—</span> },
                      { key: 'phone', header: 'Phone', width: '140px', render: (row) => <span className="text-[12px]">{row.phone ?? '—'}</span> },
                    ]}
                  />
                )}
              </>
            ) : (
              <div className="divide-y divide-[var(--border-default)]">
                {account.quotes.length === 0 && account.invoices.length === 0 ? (
                  <EmptyState title="Nothing quoted yet" message="Quotes and invoices raised for this account appear here." />
                ) : (
                  <>
                    {account.quotes.map((quote) => (
                      <Link key={quote.id} to={`/quotes/${quote.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-sunken">
                        <span>
                          <span className="block text-[13px] font-semibold">{quote.number}</span>
                          <span className="block text-[11px] text-muted">Quote · {date(quote.issueDate)}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge tone={quote.status === 'ACCEPTED' ? 'secure' : quote.status === 'SENT' ? 'info' : 'neutral'}>{quote.status}</Badge>
                          <span className="tabular text-[13px] font-semibold">{money(quote.total)}</span>
                        </span>
                      </Link>
                    ))}
                    {account.invoices.map((invoice) => (
                      <div key={invoice.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <span>
                          <span className="block text-[13px] font-semibold">{invoice.number}</span>
                          <span className="block text-[11px] text-muted">Invoice · {invoice.dueDate ? `due ${date(invoice.dueDate)}` : 'no due date'}</span>
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge tone={invoice.status === 'PAID' ? 'secure' : invoice.status === 'OVERDUE' ? 'accent' : 'neutral'}>{invoice.status}</Badge>
                          <span className="tabular text-[13px] font-semibold">{money(invoice.total)}</span>
                        </span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Files" subtitle="Trade licence, TRN certificate, signed agreements" />
            <AttachmentPanel parent="account" parentId={account.id} />
          </Card>
        </div>

        <Card>
          <CardHeader title="Timeline" subtitle="Keep this fed — it is what the stale-account alert reads" />
          <ActivityPanel activities={account.activities} links={{ accountId: account.id }} invalidate={invalidate} />
        </Card>
      </div>

      {editing ? <EditAccountModal account={account} onClose={() => setEditing(false)} onSaved={invalidate} /> : null}
      {merging ? <MergeModal accountId={account.id} accountName={account.name} onClose={() => setMerging(false)} /> : null}
      {addingDeal ? <DealForm onClose={() => setAddingDeal(false)} defaultAccountId={account.id} defaultAccountName={account.name} /> : null}
      {addingContact ? <ContactForm onClose={() => setAddingContact(false)} defaultAccountId={account.id} defaultAccountName={account.name} onSaved={invalidate} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete this account?"
        confirmLabel="Delete account"
        message="Accounts with open deals cannot be deleted. Contacts and history are archived alongside it."
      />
    </>
  );
}

function EditAccountModal({ account, onClose, onSaved }: { account: AccountFull; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: account.name, type: account.type, domain: account.domain ?? '', website: account.website ?? '',
    industry: account.industry ?? '', employeeBand: account.employeeBand ?? '', phone: account.phone ?? '',
    email: account.email ?? '', trn: account.trn ?? '', addressLine1: account.addressLine1 ?? '',
    city: account.city ?? '', emirate: account.emirate ?? '', poBox: account.poBox ?? '',
    linkedinUrl: account.linkedinUrl ?? '', description: account.description ?? '', ownerId: account.owner?.id ?? '',
  });
  const [custom, setCustom] = useState<CustomValues>(account.customFields ?? {});
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.patch(`/accounts/${account.id}`, { ...form, ownerId: form.ownerId || null, customFields: custom }),
    onSuccess: () => { toast.push('Account updated.'); onSaved(); onClose(); },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit account"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <Field label="Account name" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={['CUSTOMER', 'PROSPECT', 'PARTNER', 'VENDOR'].map((t) => ({ value: t, label: t.charAt(0) + t.slice(1).toLowerCase() }))} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Domain"><Input value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} /></Field>
          <Field label="Website"><Input value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Industry"><ListSelect listKey="lists.industries" value={form.industry} onChange={(v) => setForm({ ...form, industry: v })} placeholder="—" /></Field>
          <Field label="Employees"><ListSelect listKey="lists.employeeBands" value={form.employeeBand} onChange={(v) => setForm({ ...form, employeeBand: v })} placeholder="—" /></Field>
          <Field label="Emirate"><ListSelect listKey="lists.emirates" value={form.emirate} onChange={(v) => setForm({ ...form, emirate: v })} placeholder="—" /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="TRN"><Input value={form.trn} onChange={(e) => setForm({ ...form, trn: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label="Address"><Input value={form.addressLine1} onChange={(e) => setForm({ ...form, addressLine1: e.target.value })} /></Field>
          <Field label="City"><Input value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></Field>
          <Field label="P.O. Box"><Input value={form.poBox} onChange={(e) => setForm({ ...form, poBox: e.target.value })} /></Field>
        </div>
        <Field label="Owner"><OwnerSelect value={form.ownerId} onChange={(v) => setForm({ ...form, ownerId: v })} /></Field>
        <Field label="Notes"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>

        <CustomFieldInputs module="accounts" values={custom} onChange={setCustom} />
      </div>
    </Modal>
  );
}

function MergeModal({ accountId, accountName, onClose }: { accountId: string; accountName: string; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [intoId, setIntoId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const merge = useMutation({
    mutationFn: () => api.post<{ survivorId: string }>(`/accounts/${accountId}/merge`, { intoId }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      toast.push('Accounts merged.');
      navigate(`/accounts/${result.survivorId}`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not merge.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Merge account"
      subtitle="Fixing a duplicate that slipped through"
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!intoId} loading={merge.isPending} onClick={() => merge.mutate()}>Merge</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        <p className="text-[13px] leading-relaxed text-n600">
          Every contact, deal, quote, invoice and note on <strong>{accountName}</strong> moves to the account you pick.
          <strong> {accountName}</strong> is then archived. This cannot be undone from the UI.
        </p>
        <Field label="Merge into" required>
          <AccountPicker value={intoId || null} onChange={(id) => setIntoId(id ?? '')} placeholder="Search for the surviving account…" />
        </Field>
      </div>
    </Modal>
  );
}
