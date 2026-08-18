import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRightLeft, Pencil, ShieldOff, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money, relative } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, DefinitionList, EmptyState, ErrorNote, Field,
  Input, Loading, Modal, PageHeader, Select, Textarea, useToast,
} from '../components/ui';
import { AccountPicker, ListSelect, OwnerSelect } from '../components/pickers';
import { ActivityPanel, type ActivityRecord } from '../components/timeline';
import { AttachmentPanel } from '../components/attachments';
import { CustomFieldInputs, CustomFieldValues, type CustomValues } from '../components/customFields';
import { LifecycleRail, leadHint, leadTrack } from '../components/lifecycle';
import { useUndo } from '../lib/undo';

interface LeadFull {
  id: string; firstName: string; lastName: string; company: string; domain: string | null;
  email: string | null; phone: string | null; jobTitle: string | null; linkedinUrl: string | null;
  source: string; sourcePartnerId: string | null; status: string; rating: string | null; score: number;
  interestArea: string | null; estimatedValue: string | number | null; description: string | null;
  emirate: string | null; country: string; createdAt: string; lastActivityAt: string | null;
  convertedAt: string | null; convertedAccountId: string | null; convertedDealId: string | null;
  disqualifyReason: string | null; customFields: CustomValues; erasedAt: string | null;
  owner: { id: string; name: string } | null;
  convertedAccount: { id: string; name: string } | null;
  activities: ActivityRecord[];
}

export default function LeadDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const undo = useUndo();
  const { can } = useAuth();

  const [editing, setEditing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [erasing, setErasing] = useState(false);

  const { data: lead, isLoading, error } = useQuery({
    queryKey: ['lead', id],
    queryFn: () => api.get<LeadFull>(`/leads/${id}`),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['lead', id] });
    void queryClient.invalidateQueries({ queryKey: ['leads'] });
  };

  const setStatus = useMutation({
    mutationFn: (status: string) => api.patch(`/leads/${id}`, { status }),
    onSuccess: () => { invalidate(); toast.push('Status updated.'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not update.', 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.del<{ undoId?: string }>(`/leads/${id}`),
    onSuccess: (res) => { undo.toast('Lead deleted.', res.undoId); navigate('/leads'); },
  });

  if (isLoading) return <Loading />;
  if (error || !lead) return <EmptyState title="Lead not found" message={(error as Error)?.message} action={<Link to="/leads"><Button>Back to leads</Button></Link>} />;

  const converted = lead.status === 'CONVERTED';

  return (
    <>
      <Link to="/leads" className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted transition-colors hover:text-ink">
        <ArrowLeft size={13} /> All leads
      </Link>

      <PageHeader
        title={`${lead.firstName} ${lead.lastName}`}
        description={`${lead.company}${lead.jobTitle ? ` · ${lead.jobTitle}` : ''} · added ${date(lead.createdAt)}`}
        actions={
          <>
            {!converted && can('leads', 'update') ? (
              <Button variant="accent" icon={<ArrowRightLeft size={14} />} onClick={() => setConverting(true)}>Convert</Button>
            ) : null}
            {!converted && can('leads', 'update') ? <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit</Button> : null}
            {can('leads', 'delete') ? <Button icon={<ShieldOff size={14} />} onClick={() => setErasing(true)}>Erase data</Button> : null}
            {can('leads', 'delete') ? <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Delete</Button> : null}
          </>
        }
      />

      <Card className="mb-3">
        <LifecycleRail
          track={leadTrack(lead.status)}
          hint={{
            ...leadHint(lead),
            cta: lead.status === 'QUALIFIED' && can('leads', 'update')
              ? { label: 'Convert', onClick: () => setConverting(true) }
              : undefined,
          }}
          disabled={setStatus.isPending}
          onStep={
            can('leads', 'update') && !converted
              // Converting is not a status flip — it creates the account and the deal.
              ? (key) => (key === 'CONVERTED' ? setConverting(true) : setStatus.mutate(key))
              : undefined
          }
          meta={
            can('leads', 'update') && !converted && lead.status !== 'DISQUALIFIED' ? (
              <>
                {lead.status !== 'NURTURING' ? (
                  <button
                    onClick={() => setStatus.mutate('NURTURING')}
                    className="text-[11px] font-semibold uppercase tracking-[0.06em] text-n400 underline decoration-dotted underline-offset-2 transition-colors hover:text-ink"
                  >
                    Park as nurturing
                  </button>
                ) : null}
                <button
                  onClick={() => setStatus.mutate('DISQUALIFIED')}
                  className="text-[11px] font-semibold uppercase tracking-[0.06em] text-n400 underline decoration-dotted underline-offset-2 transition-colors hover:text-accent"
                >
                  Disqualify
                </button>
              </>
            ) : null
          }
        />
      </Card>

      {converted ? (
        <Card className="mb-3 border-[#b8dfc8] bg-[#e8f5ed]">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] text-[#14653a]">
            <Badge tone="secure">Converted</Badge>
            <span>
              Converted {relative(lead.convertedAt)} into
              {lead.convertedAccount ? <Link to={`/accounts/${lead.convertedAccount.id}`} className="ml-1 font-semibold underline decoration-dotted underline-offset-2">{lead.convertedAccount.name}</Link> : ' an account'}
              {lead.convertedDealId ? <Link to={`/deals/${lead.convertedDealId}`} className="ml-1 font-semibold underline decoration-dotted underline-offset-2">and a deal</Link> : null}.
            </span>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-3 xl:grid-cols-[1fr_1.1fr]">
        <div className="flex flex-col gap-3">
        <Card>
          <CardHeader title="Lead details" />
          <div className="px-4 py-4">
            <DefinitionList
              items={[
                { label: 'Company', value: lead.company },
                { label: 'Domain', value: lead.domain ?? '—' },
                { label: 'Email', value: lead.email ? <a href={`mailto:${lead.email}`} className="underline decoration-dotted underline-offset-2">{lead.email}</a> : '—' },
                { label: 'Phone', value: lead.phone ?? '—' },
                { label: 'LinkedIn', value: lead.linkedinUrl ? <a href={lead.linkedinUrl.startsWith('http') ? lead.linkedinUrl : `https://${lead.linkedinUrl}`} target="_blank" rel="noreferrer" className="underline decoration-dotted underline-offset-2">Profile</a> : '—' },
                { label: 'Source', value: lead.source },
                { label: 'Rating', value: lead.rating ? <Badge tone={lead.rating === 'Hot' ? 'accent' : lead.rating === 'Warm' ? 'watch' : 'neutral'}>{lead.rating}</Badge> : '—' },
                { label: 'Interest area', value: lead.interestArea ?? '—' },
                { label: 'Estimated value', value: lead.estimatedValue ? money(lead.estimatedValue) : '—' },
                { label: 'Emirate', value: lead.emirate ?? '—' },
                { label: 'Owner', value: lead.owner?.name ?? 'Unassigned' },
                { label: 'Last touch', value: relative(lead.lastActivityAt) },
              ]}
            />
            {lead.description ? (
              <div className="mt-4 border-t border-line pt-3">
                <span className="eyebrow">Notes</span>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-n600">{lead.description}</p>
              </div>
            ) : null}
            <CustomFieldValues module="leads" values={lead.customFields} />
          </div>
        </Card>

        <Card className="xl:col-start-1">
          <CardHeader title="Files" subtitle="RFQs, requirement documents, business cards" />
          <AttachmentPanel parent="lead" parentId={lead.id} />
        </Card>
        </div>

        <Card>
          <CardHeader title="Timeline" subtitle="Every touch on this lead" />
          <ActivityPanel activities={lead.activities} links={{ leadId: lead.id }} invalidate={invalidate} />
        </Card>
      </div>

      {editing ? <EditLeadModal lead={lead} onClose={() => setEditing(false)} onSaved={invalidate} /> : null}
      {converting ? <ConvertModal lead={lead} onClose={() => setConverting(false)} /> : null}
      {erasing ? <EraseLeadModal lead={lead} onClose={() => setErasing(false)} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete this lead?"
        confirmLabel="Delete lead"
        message="The lead is archived rather than destroyed — an administrator can restore it."
      />
    </>
  );
}

function EditLeadModal({ lead, onClose, onSaved }: { lead: LeadFull; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    firstName: lead.firstName, lastName: lead.lastName, company: lead.company,
    email: lead.email ?? '', phone: lead.phone ?? '', jobTitle: lead.jobTitle ?? '',
    linkedinUrl: lead.linkedinUrl ?? '', source: lead.source, rating: lead.rating ?? '',
    interestArea: lead.interestArea ?? '', estimatedValue: lead.estimatedValue ? String(lead.estimatedValue) : '',
    emirate: lead.emirate ?? '', ownerId: lead.owner?.id ?? '', description: lead.description ?? '',
  });
  const [custom, setCustom] = useState<CustomValues>(lead.customFields ?? {});
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/leads/${lead.id}`, {
        ...form,
        email: form.email || null,
        estimatedValue: form.estimatedValue ? Number(form.estimatedValue) : null,
        ownerId: form.ownerId || null,
        customFields: custom,
      }),
    onSuccess: () => { toast.push('Lead updated.'); onSaved(); onClose(); },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit lead"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="First name" required><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
          <Field label="Last name" required><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
        </div>
        <Field label="Company" required><Input value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Job title"><Input value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} /></Field>
          <Field label="LinkedIn"><Input value={form.linkedinUrl} onChange={(e) => setForm({ ...form, linkedinUrl: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Source"><ListSelect listKey="lists.leadSources" value={form.source} onChange={(v) => setForm({ ...form, source: v })} /></Field>
          <Field label="Rating"><ListSelect listKey="lists.ratings" value={form.rating} onChange={(v) => setForm({ ...form, rating: v })} placeholder="—" /></Field>
          <Field label="Emirate"><ListSelect listKey="lists.emirates" value={form.emirate} onChange={(v) => setForm({ ...form, emirate: v })} placeholder="—" /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Interest area"><ListSelect listKey="lists.productCategories" value={form.interestArea} onChange={(v) => setForm({ ...form, interestArea: v })} placeholder="—" /></Field>
          <Field label="Estimated value"><Input type="number" min="0" value={form.estimatedValue} onChange={(e) => setForm({ ...form, estimatedValue: e.target.value })} /></Field>
          <Field label="Owner"><OwnerSelect value={form.ownerId} onChange={(v) => setForm({ ...form, ownerId: v })} /></Field>
        </div>
        <Field label="Notes"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>

        <CustomFieldInputs module="leads" values={custom} onChange={setCustom} />
      </div>
    </Modal>
  );
}

function ConvertModal({ lead, onClose }: { lead: LeadFull; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [form, setForm] = useState({
    accountId: '',
    accountType: 'CUSTOMER',
    createDeal: true,
    dealName: `${lead.company} — ${lead.interestArea ?? 'Opportunity'}`,
    dealAmount: lead.estimatedValue ? String(lead.estimatedValue) : '',
    dealType: 'PRODUCT',
    closeDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    partnerAccountId: lead.sourcePartnerId ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const convert = useMutation({
    mutationFn: () =>
      api.post<{ accountId: string; contactId: string; dealId: string | null }>(`/leads/${lead.id}/convert`, {
        accountId: form.accountId || undefined,
        accountType: form.accountType,
        createDeal: form.createDeal,
        dealName: form.dealName,
        dealAmount: form.dealAmount ? Number(form.dealAmount) : undefined,
        dealType: form.dealType,
        closeDate: form.closeDate,
        partnerAccountId: form.partnerAccountId || null,
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['leads'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.push('Lead converted.');
      navigate(result.dealId ? `/deals/${result.dealId}` : `/accounts/${result.accountId}`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not convert.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Convert lead"
      subtitle="Creates the account and contact. Zeus reuses an existing account when the domain already matches."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={convert.isPending} onClick={() => convert.mutate()}>Convert lead</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}

        <div className="border border-line bg-sunken px-3 py-2.5 text-[12px] text-n600">
          <strong>{lead.firstName} {lead.lastName}</strong> at <strong>{lead.company}</strong>
          {lead.domain ? <> · domain <strong>{lead.domain}</strong></> : null}
        </div>

        <Field label="Merge into an existing account" hint="Leave empty to create a new account from the lead's company.">
          <AccountPicker value={form.accountId || null} onChange={(id) => setForm({ ...form, accountId: id ?? '' })} placeholder="Search accounts…" />
        </Field>

        {!form.accountId ? (
          <Field label="New account type">
            <Select
              value={form.accountType}
              onChange={(e) => setForm({ ...form, accountType: e.target.value })}
              options={[{ value: 'CUSTOMER', label: 'Customer' }, { value: 'PROSPECT', label: 'Prospect' }, { value: 'PARTNER', label: 'Partner' }]}
            />
          </Field>
        ) : null}

        <label className="flex items-center gap-2 border border-line bg-card px-3 py-2.5 text-[13px]">
          <input type="checkbox" checked={form.createDeal} onChange={(e) => setForm({ ...form, createDeal: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
          Also create a deal in the default pipeline
        </label>

        {form.createDeal ? (
          <div className="space-y-3 border-l-2 border-accent pl-3">
            <Field label="Deal name" required>
              <Input value={form.dealName} onChange={(e) => setForm({ ...form, dealName: e.target.value })} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Net value (AED)">
                <Input type="number" min="0" value={form.dealAmount} onChange={(e) => setForm({ ...form, dealAmount: e.target.value })} />
              </Field>
              <Field label="Type">
                <Select value={form.dealType} onChange={(e) => setForm({ ...form, dealType: e.target.value })} options={[{ value: 'PRODUCT', label: 'Reselling' }, { value: 'SERVICE', label: 'Managed service' }, { value: 'MIXED', label: 'Mixed' }]} />
              </Field>
              <Field label="Expected close">
                <Input type="date" value={form.closeDate} onChange={(e) => setForm({ ...form, closeDate: e.target.value })} />
              </Field>
            </div>
            <Field label="Partner on this deal" hint="Pre-filled when the lead came from a partner.">
              <AccountPicker value={form.partnerAccountId || null} type="PARTNER" onChange={(id) => setForm({ ...form, partnerAccountId: id ?? '' })} placeholder="Search partners…" />
            </Field>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function EraseLeadModal({ lead, onClose }: { lead: LeadFull; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const erase = useMutation({
    mutationFn: () => api.post(`/leads/${lead.id}/erase`, { reason }),
    onSuccess: () => { toast.push('Personal data erased.'); navigate('/leads'); },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not erase.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Erase personal data?"
      subtitle="Name, email, phone and LinkedIn are permanently scrubbed. Company and pipeline history stay so the deal record still means what it meant. There is no undo."
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!reason.trim()} loading={erase.isPending} onClick={() => erase.mutate()}>Erase data</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        <Field label="Reason" required hint="For the audit trail — e.g. a right-to-erasure request.">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Customer requested deletion of their data." />
        </Field>
      </div>
    </Modal>
  );
}
