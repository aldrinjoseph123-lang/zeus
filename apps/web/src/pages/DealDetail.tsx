import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, FileText, Mail, Pencil, Plus, ShieldCheck, Tags, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, dateInput, daysBetween, money, percent, relative } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, DataTable, DefinitionList, EmptyState, ErrorNote,
  Field, Input, Loading, Modal, PageHeader, Select, Textarea, cx, useToast,
} from '../components/ui';
import { AccountPicker, ContactPicker, ListSelect, OwnerSelect } from '../components/pickers';
import { ActivityPanel, type ActivityRecord } from '../components/timeline';
import { AttachmentPanel } from '../components/attachments';
import { CustomFieldInputs, CustomFieldValues, type CustomValues } from '../components/customFields';
import { LifecycleRail, dealHint, dealJourney } from '../components/lifecycle';
import { ApprovalBar, type ApprovalState } from '../components/approvals';
import { PriceModal } from './PriceBook';
import { useUndo } from '../lib/undo';

interface Registration {
  id: string; side: 'VENDOR' | 'PARTNER';
  regNumber: string | null; status: string; submittedAt: string | null; approvedAt: string | null;
  expiresAt: string | null; approvedDiscount: string | number | null; notes: string | null;
  partnerNotifiedAt: string | null;
  vendor: { id: string; name: string } | null;
  partner: { id: string; name: string } | null;
  partnerContact: { id: string; firstName: string; lastName: string; email: string | null } | null;
}

interface DealFull {
  id: string; reference: string; name: string; status: string; type: string; source: string;
  amount: string | number; vatRate: string | number; vatAmount: string | number; totalAmount: string | number; cost?: string | number;
  probability: number; closeDate: string; closedAt: string | null; lostReason: string | null; competitor: string | null;
  nextStep: string | null; description: string | null; stageChangedAt: string; createdAt: string; lastActivityAt: string | null;
  customFields: CustomValues;
  account: { id: string; name: string; type: string; domain: string | null; industry: string | null };
  partnerAccount: { id: string; name: string } | null;
  primaryContact: { id: string; firstName: string; lastName: string; email: string | null; phone: string | null; jobTitle: string | null } | null;
  stage: { id: string; name: string; color: string; probability: number; isWon: boolean; isLost: boolean; rotDays: number };
  pipeline: { id: string; name: string; kind: string };
  owner: { id: string; name: string; avatarColor: string } | null;
  registrations: Registration[];
  quotes: Array<{ id: string; number: string; status: string; total: string | number; issueDate: string; validUntil: string | null }>;
  invoices: Array<{ id: string; number: string; status: string; total: string | number; amountPaid: string | number; dueDate: string | null }>;
  activities: ActivityRecord[];
  stageHistory: Array<{ id: string; toStageId: string; fromStageId: string | null; toStatus: string; changedAt: string; daysInStage: number }>;
}

type DealWithApproval = DealFull & ApprovalState;

const REG_TONE: Record<string, 'neutral' | 'secure' | 'watch' | 'accent'> = {
  DRAFT: 'neutral', SUBMITTED: 'watch', APPROVED: 'secure', REJECTED: 'accent', EXPIRED: 'accent',
};

export default function DealDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const undo = useUndo();
  const { can, sees } = useAuth();

  const [editing, setEditing] = useState(false);
  const [addingReg, setAddingReg] = useState(false);
  const [addingPrice, setAddingPrice] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lostFor, setLostFor] = useState<string | null>(null);

  const { data: deal, isLoading, error } = useQuery({
    queryKey: ['deal', id],
    queryFn: () => api.get<DealWithApproval>(`/deals/${id}`),
  });

  const { data: pipelines } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api.get<Array<{ id: string; name: string; stages: Array<{ id: string; name: string; color: string; order: number; probability: number; isWon: boolean; isLost: boolean }> }>>('/pipelines'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['deal', id] });
    void queryClient.invalidateQueries({ queryKey: ['deal-board'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const moveStage = useMutation({
    mutationFn: (input: { stageId: string; lostReason?: string }) => api.post<{ undoId?: string }>(`/deals/${id}/stage`, input),
    onSuccess: (res) => { invalidate(); undo.toast('Stage updated.', res.undoId); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not move the deal.', 'error'),
  });

  const remove = useMutation({
    mutationFn: () => api.del<{ undoId?: string }>(`/deals/${id}`),
    onSuccess: (res) => { undo.toast('Deal deleted.', res.undoId); navigate('/deals'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not delete.', 'error'),
  });

  const clone = useMutation({
    mutationFn: () => api.post<{ id: string; reference: string }>(`/deals/${id}/clone`, {}),
    onSuccess: (copy) => { toast.push(`${copy.reference} created.`); navigate(`/deals/${copy.id}`); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not clone the deal.', 'error'),
  });

  // Special prices agreed for this opportunity. Kept beside the registrations, because
  // an SPA is what a registration is *for* — the approval is only the paperwork.
  const { data: specialPrices } = useQuery({
    queryKey: ['deal-prices', id],
    queryFn: () => api.get<{ data: Array<{ id: string; cost: string | number; minQuantity: string | number; validTo: string | null; vendor: { name: string } | null; product: { sku: string; name: string; listPrice: string | number } }> }>(`/price-book?dealId=${id}&pageSize=50`),
    enabled: sees('products', 'cost'),
    retry: false,
  });

  const notifyPartner = useMutation({
    mutationFn: (regId: string) => api.post<{ to: string }>(`/registrations/${regId}/notify-partner`),
    onSuccess: (res) => { invalidate(); toast.push(`Reminder sent to ${res.to}.`); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not email the partner.', 'error'),
  });

  if (isLoading) return <Loading />;
  if (error || !deal) return <EmptyState title="Deal not found" message={(error as Error)?.message} action={<Link to="/deals"><Button>Back to deals</Button></Link>} />;

  const stages = pipelines?.find((p) => p.id === deal.pipeline.id)?.stages ?? [];
  const currentIndex = stages.findIndex((s) => s.id === deal.stage.id);
  const inStage = daysBetween(deal.stageChangedAt) ?? 0;
  const marginPct = deal.cost !== undefined && Number(deal.amount) > 0
    ? ((Number(deal.amount) - Number(deal.cost)) / Number(deal.amount)) * 100
    : null;

  // The one button that moves the commercial journey on from wherever it stands.
  const acceptedQuote = deal.quotes.find((q) => q.status === 'ACCEPTED');
  const liveInvoices = deal.invoices.filter((i) => i.status !== 'DRAFT' && i.status !== 'CANCELLED');
  const unpaid = liveInvoices.find((i) => Number(i.total) > Number(i.amountPaid));
  const journeyCta =
    deal.status === 'LOST' ? undefined
    : !deal.quotes.length && can('quotes', 'create') ? { label: 'Build quote', to: `/quotes/new?dealId=${deal.id}&accountId=${deal.account.id}` }
    : acceptedQuote && !liveInvoices.length && can('invoices', 'create') ? { label: 'Raise invoice', to: `/quotes/${acceptedQuote.id}` }
    : unpaid ? { label: 'Open invoice', to: `/invoices/${unpaid.id}` }
    : deal.quotes[0] ? { label: 'Open quote', to: `/quotes/${deal.quotes[0].id}` }
    : undefined;

  return (
    <>
      <Link to="/deals" className="mb-3 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted transition-colors hover:text-ink">
        <ArrowLeft size={13} /> All deals
      </Link>

      <PageHeader
        title={deal.name}
        description={`${deal.reference} · ${deal.pipeline.name} · created ${date(deal.createdAt)}`}
        actions={
          <>
            {can('quotes', 'create') ? (
              <Link to={`/quotes/new?dealId=${deal.id}&accountId=${deal.account.id}`}>
                <Button icon={<FileText size={14} />}>New quote</Button>
              </Link>
            ) : null}
            {can('deals', 'update') ? <Button icon={<Pencil size={14} />} onClick={() => setEditing(true)}>Edit</Button> : null}
            {can('deals', 'create') ? <Button icon={<Copy size={14} />} loading={clone.isPending} onClick={() => clone.mutate()}>Clone</Button> : null}
            {can('deals', 'delete') ? <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)}>Delete</Button> : null}
          </>
        }
      />

      {/* headline strip */}
      <Card className="mb-3">
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="eyebrow">Net value</span>
            <p className="tabular mt-1 text-[26px] font-bold leading-none">{money(deal.amount)}</p>
            <p className="mt-1 text-[11px] text-muted">
              + {money(deal.vatAmount)} VAT ({percent(deal.vatRate)}) = <strong className="text-ink">{money(deal.totalAmount)}</strong>
            </p>
          </div>
          <div>
            <span className="eyebrow">Weighted</span>
            <p className="tabular mt-1 text-[26px] font-bold leading-none">{money((Number(deal.amount) * deal.probability) / 100)}</p>
            <p className="mt-1 text-[11px] text-muted">{deal.probability}% probability</p>
          </div>
          <div>
            <span className="eyebrow">Expected close</span>
            <p className={cx('tabular mt-1 text-[26px] font-bold leading-none', new Date(deal.closeDate) < new Date() && deal.status === 'OPEN' && 'text-accent')}>
              {date(deal.closeDate)}
            </p>
            <p className="mt-1 text-[11px] text-muted">
              {deal.status === 'OPEN' ? `${inStage} day${inStage === 1 ? '' : 's'} in ${deal.stage.name}` : `Closed ${relative(deal.closedAt)}`}
            </p>
          </div>
          <div>
            <span className="eyebrow">{sees('deals', 'cost') ? 'Margin' : 'Channel'}</span>
            {sees('deals', 'cost') && marginPct !== null ? (
              <>
                <p className="tabular mt-1 text-[26px] font-bold leading-none">{percent(marginPct, 1)}</p>
                <p className="mt-1 text-[11px] text-muted">{money(Number(deal.amount) - Number(deal.cost ?? 0))} on {money(deal.cost ?? 0)} cost</p>
              </>
            ) : (
              <>
                <p className="mt-1 text-[20px] font-bold leading-tight">{deal.partnerAccount ? 'Partner-sourced' : 'Direct'}</p>
                <p className="mt-1 text-[11px] text-muted">{deal.partnerAccount?.name ?? deal.account.name}</p>
              </>
            )}
          </div>
        </div>

        {/* stage rail — the sales team's one-click status update */}
        <div className="border-t border-line px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="eyebrow">Stage</span>
            {deal.status !== 'OPEN' ? (
              <Badge tone={deal.status === 'WON' ? 'secure' : 'accent'}>
                {deal.status === 'WON' ? 'Won' : `Lost — ${deal.lostReason ?? 'no reason'}`}
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {stages.map((stage, index) => {
              const active = stage.id === deal.stage.id;
              const passed = currentIndex >= 0 && index < currentIndex && !stage.isLost;
              return (
                <button
                  key={stage.id}
                  disabled={!can('deals', 'update') || moveStage.isPending || active}
                  onClick={() => (stage.isLost ? setLostFor(stage.id) : moveStage.mutate({ stageId: stage.id }))}
                  className={cx(
                    'flex-1 min-w-[104px] border px-2.5 py-2 text-left transition-colors disabled:cursor-default',
                    active ? 'border-transparent text-white' : passed ? 'border-line bg-n100 text-n600' : 'border-line bg-card text-muted hover:border-n900 hover:text-ink',
                  )}
                  style={active ? { background: stage.color } : undefined}
                >
                  <span className="block text-[11px] font-bold uppercase tracking-[0.06em]">{stage.name}</span>
                  <span className={cx('block text-[10px]', active ? 'text-white/75' : 'text-n400')}>{stage.probability}%</span>
                </button>
              );
            })}
          </div>
          {deal.status === 'OPEN' && inStage > deal.stage.rotDays ? (
            <p className="mt-2 text-[11px] font-semibold text-[var(--status-watch)]">
              This deal has sat in {deal.stage.name} for {inStage} days — the threshold is {deal.stage.rotDays}.
            </p>
          ) : null}
        </div>

        {deal.status === 'OPEN' ? (
          <ApprovalBar entity="deals" id={deal.id} module="deals" record={deal} onChanged={invalidate} />
        ) : null}
      </Card>

      {/* commercial journey — quote, acceptance, invoice, cash */}
      <Card className="mb-3">
        <LifecycleRail title="Commercial journey" track={dealJourney(deal)} hint={{ ...dealHint(deal), cta: journeyCta }} />
      </Card>

      <div className="grid gap-3 xl:grid-cols-[1fr_1.15fr]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Details" />
            <div className="px-4 py-4">
              <DefinitionList
                items={[
                  { label: 'End customer', value: <Link to={`/accounts/${deal.account.id}`} className="font-semibold underline decoration-dotted underline-offset-2">{deal.account.name}</Link> },
                  { label: 'Partner', value: deal.partnerAccount ? <Link to={`/accounts/${deal.partnerAccount.id}`} className="underline decoration-dotted underline-offset-2">{deal.partnerAccount.name}</Link> : <span className="text-muted">Direct deal</span> },
                  { label: 'Primary contact', value: deal.primaryContact ? `${deal.primaryContact.firstName} ${deal.primaryContact.lastName}${deal.primaryContact.jobTitle ? ` · ${deal.primaryContact.jobTitle}` : ''}` : '—' },
                  { label: 'Contact email', value: deal.primaryContact?.email ? <a href={`mailto:${deal.primaryContact.email}`} className="underline decoration-dotted underline-offset-2">{deal.primaryContact.email}</a> : '—' },
                  { label: 'Type', value: deal.type === 'SERVICE' ? 'Managed service' : deal.type === 'MIXED' ? 'Mixed' : 'Product reselling' },
                  { label: 'Source', value: deal.source },
                  { label: 'Owner', value: deal.owner?.name ?? 'Unassigned' },
                  { label: 'Customer domain', value: deal.account.domain ?? '—' },
                  { label: 'Next step', value: deal.nextStep ?? '—' },
                  { label: 'Competitor', value: deal.competitor ?? '—' },
                ]}
              />
              {deal.description ? (
                <div className="mt-4 border-t border-line pt-3">
                  <span className="eyebrow">Notes</span>
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-n600">{deal.description}</p>
                </div>
              ) : null}
              <CustomFieldValues module="deals" values={deal.customFields} />
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Registrations"
              subtitle="Vendor protection on your buy price, partner protection on their customer"
              actions={can('deals', 'update') ? <Button size="sm" icon={<Plus size={13} />} onClick={() => setAddingReg(true)}>Register</Button> : undefined}
            />
            {deal.registrations.length === 0 ? (
              <EmptyState
                title="No registrations"
                message="Register the opportunity with the vendor to protect your discount, or register it for the partner who brought it."
                icon={<ShieldCheck size={22} />}
              />
            ) : (
              <DataTable
                dense
                rows={deal.registrations}
                rowKey={(row) => row.id}
                columns={[
                  {
                    key: 'party', header: 'Registered',
                    render: (row) => (
                      <span>
                        <span className="block font-semibold">{row.vendor?.name ?? row.partner?.name ?? '—'}</span>
                        <span className="block text-[10px] uppercase tracking-[0.08em] text-n400">
                          {row.side === 'PARTNER' ? 'For partner' : 'With vendor'}
                          {row.regNumber ? ` · ${row.regNumber}` : ''}
                        </span>
                      </span>
                    ),
                  },
                  { key: 'status', header: 'Status', width: '96px', render: (row) => <Badge tone={REG_TONE[row.status] ?? 'neutral'}>{row.status}</Badge> },
                  { key: 'discount', header: 'Disc', align: 'right', width: '64px', render: (row) => <span className="tabular">{row.approvedDiscount ? percent(row.approvedDiscount, 1) : '—'}</span> },
                  {
                    key: 'expiresAt', header: 'Expires', align: 'right', width: '116px',
                    render: (row) => {
                      if (!row.expiresAt) return <span className="text-n400">—</span>;
                      const left = daysBetween(row.expiresAt);
                      const daysLeft = left === null ? null : -left;
                      return (
                        <span className={cx('tabular text-[12px]', daysLeft !== null && daysLeft < 30 && 'font-semibold text-accent')}>
                          <span className="block">{date(row.expiresAt)}</span>
                          {daysLeft !== null ? (
                            <span className="block text-[10px] text-n400">
                              {daysLeft < 0 ? `lapsed ${-daysLeft}d ago` : `${daysLeft}d left`}
                            </span>
                          ) : null}
                        </span>
                      );
                    },
                  },
                  {
                    key: 'actions', header: '', width: '84px', align: 'right',
                    render: (row) =>
                      row.side === 'PARTNER' && can('deals', 'update') ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Mail size={12} />}
                          loading={notifyPartner.isPending && notifyPartner.variables === row.id}
                          onClick={() => notifyPartner.mutate(row.id)}
                        >
                          Remind
                        </Button>
                      ) : null,
                  },
                ]}
              />
            )}
          </Card>

          {sees('products', 'cost') ? (
            <Card>
              <CardHeader
                title="Special pricing"
                subtitle="Vendor prices approved for this deal only — quote lines pick these up automatically"
                actions={can('products', 'create') ? (
                  <Button size="sm" icon={<Plus size={13} />} onClick={() => setAddingPrice(true)}>Add price</Button>
                ) : undefined}
              />
              {!specialPrices?.data.length ? (
                <EmptyState
                  title="No special price on this deal"
                  message="Quote lines will use the standing vendor price. Add one here when the vendor approves an SPA."
                  icon={<Tags size={22} />}
                />
              ) : (
                <DataTable
                  dense
                  rows={specialPrices.data}
                  rowKey={(row) => row.id}
                  columns={[
                    {
                      key: 'product', header: 'Item',
                      render: (row) => (
                        <span>
                          <span className="block font-semibold">{row.product.sku}</span>
                          <span className="block text-[11px] text-muted">{row.vendor?.name ?? 'No vendor'}</span>
                        </span>
                      ),
                    },
                    { key: 'minQuantity', header: 'From', align: 'right', width: '64px', render: (row) => <span className="tabular text-[12px]">{Number(row.minQuantity)}</span> },
                    {
                      key: 'cost', header: 'Special buy', align: 'right', width: '120px',
                      render: (row) => {
                        const list = Number(row.product.listPrice);
                        const off = list > 0 ? ((list - Number(row.cost)) / list) * 100 : null;
                        return (
                          <span className="tabular">
                            <span className="block font-semibold">{money(row.cost)}</span>
                            {off !== null ? <span className="block text-[10px] text-n400">{percent(off, 0)} off list</span> : null}
                          </span>
                        );
                      },
                    },
                    {
                      key: 'validTo', header: 'Valid to', align: 'right', width: '100px',
                      render: (row) => <span className="tabular text-[12px] text-muted">{row.validTo ? date(row.validTo) : 'Open'}</span>,
                    },
                  ]}
                />
              )}
            </Card>
          ) : null}

          <Card>
            <CardHeader title="Files" subtitle="Purchase orders, signed quotes, vendor confirmations" />
            <AttachmentPanel parent="deal" parentId={deal.id} />
          </Card>

          {(deal.quotes.length > 0 || deal.invoices.length > 0) ? (
            <Card>
              <CardHeader title="Quotes & invoices" />
              <div className="divide-y divide-[var(--border-default)]">
                {deal.quotes.map((quote) => (
                  <Link key={quote.id} to={`/quotes/${quote.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-sunken">
                    <span>
                      <span className="block text-[13px] font-semibold">{quote.number}</span>
                      <span className="block text-[11px] text-muted">Issued {date(quote.issueDate)}{quote.validUntil ? ` · valid to ${date(quote.validUntil)}` : ''}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={quote.status === 'ACCEPTED' ? 'secure' : quote.status === 'REJECTED' ? 'accent' : quote.status === 'SENT' ? 'info' : 'neutral'}>{quote.status}</Badge>
                      <span className="tabular text-[13px] font-semibold">{money(quote.total)}</span>
                    </span>
                  </Link>
                ))}
                {deal.invoices.map((invoice) => (
                  <div key={invoice.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span>
                      <span className="block text-[13px] font-semibold">{invoice.number}</span>
                      <span className="block text-[11px] text-muted">{invoice.dueDate ? `Due ${date(invoice.dueDate)}` : 'No due date'}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <Badge tone={invoice.status === 'PAID' ? 'secure' : invoice.status === 'OVERDUE' ? 'accent' : 'neutral'}>{invoice.status}</Badge>
                      <span className="tabular text-[13px] font-semibold">{money(invoice.total)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {deal.stageHistory.length > 1 ? (
            <Card>
              <CardHeader title="Stage history" subtitle="How long this deal spent at each step" />
              <ol className="px-4 py-3">
                {deal.stageHistory.map((entry) => {
                  const stage = stages.find((s) => s.id === entry.toStageId);
                  return (
                    <li key={entry.id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
                      <span className="h-2.5 w-2.5 shrink-0" style={{ background: stage?.color ?? 'var(--neutral-400)' }} />
                      <span className="flex-1 text-[13px]">{stage?.name ?? entry.toStatus}</span>
                      <span className="text-[11px] text-muted">{date(entry.changedAt)}</span>
                      {entry.daysInStage > 0 ? <span className="tabular w-16 text-right text-[11px] text-n400">{entry.daysInStage}d before</span> : null}
                    </li>
                  );
                })}
              </ol>
            </Card>
          ) : null}
        </div>

        <Card>
          <CardHeader title="Timeline" subtitle="Calls, meetings, emails, notes and tasks on this deal" />
          <ActivityPanel
            activities={deal.activities}
            links={{ dealId: deal.id, accountId: deal.account.id, contactId: deal.primaryContact?.id ?? null }}
            invalidate={invalidate}
          />
        </Card>
      </div>

      {editing ? <EditDealModal deal={deal} onClose={() => setEditing(false)} onSaved={invalidate} /> : null}
      {addingPrice ? (
        <PriceModal
          dealId={deal.id}
          registrationId={deal.registrations.find((r) => r.side === 'VENDOR' && r.status === 'APPROVED')?.id ?? null}
          onClose={() => { setAddingPrice(false); void queryClient.invalidateQueries({ queryKey: ['deal-prices', id] }); }}
        />
      ) : null}

      {addingReg ? (
        <RegistrationModal
          dealId={deal.id}
          defaultPartner={deal.partnerAccount}
          onClose={() => setAddingReg(false)}
          onSaved={invalidate}
        />
      ) : null}

      {lostFor ? (
        <LostModal
          onClose={() => setLostFor(null)}
          onConfirm={(lostReason) => { moveStage.mutate({ stageId: lostFor, lostReason }); setLostFor(null); }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        loading={remove.isPending}
        title="Delete this deal?"
        confirmLabel="Delete deal"
        message={<>{deal.reference} will be removed from the pipeline. Quotes and history stay in the audit trail, and an administrator can restore it from the database.</>}
      />
    </>
  );
}

function LostModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="Mark deal lost"
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={!reason} onClick={() => onConfirm(reason)}>Mark lost</Button>
        </>
      }
    >
      <Field label="Lost reason" required hint="Feeds the win/loss report — pick the closest match.">
        <ListSelect listKey="lists.lostReasons" value={reason} onChange={setReason} placeholder="Select a reason" />
      </Field>
    </Modal>
  );
}

function EditDealModal({ deal, onClose, onSaved }: { deal: DealFull; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const { sees } = useAuth();
  const [form, setForm] = useState({
    name: deal.name,
    amount: String(deal.amount),
    cost: String(deal.cost ?? ''),
    closeDate: dateInput(deal.closeDate),
    probability: String(deal.probability),
    type: deal.type,
    source: deal.source,
    ownerId: deal.owner?.id ?? '',
    partnerAccountId: deal.partnerAccount?.id ?? '',
    primaryContactId: deal.primaryContact?.id ?? '',
    nextStep: deal.nextStep ?? '',
    competitor: deal.competitor ?? '',
    description: deal.description ?? '',
  });
  const [custom, setCustom] = useState<CustomValues>(deal.customFields ?? {});
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/deals/${deal.id}`, {
        name: form.name,
        amount: Number(form.amount || 0),
        ...(sees('deals', 'cost') && form.cost !== '' ? { cost: Number(form.cost) } : {}),
        closeDate: form.closeDate,
        probability: Number(form.probability),
        type: form.type,
        source: form.source,
        ownerId: form.ownerId || null,
        partnerAccountId: form.partnerAccountId || null,
        primaryContactId: form.primaryContactId || null,
        nextStep: form.nextStep || null,
        competitor: form.competitor || null,
        description: form.description || null,
        customFields: custom,
      }),
    onSuccess: () => { toast.push('Deal updated.'); onSaved(); onClose(); },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit deal"
      subtitle={deal.reference}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}

        <Field label="Deal name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>

        <div className={cx('grid gap-3', sees('deals', 'cost') ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
          <Field label="Net value (AED)">
            <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </Field>
          {sees('deals', 'cost') ? (
            <Field label="Cost (AED)" hint="Drives the margin figure.">
              <Input type="number" min="0" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
            </Field>
          ) : null}
          <Field label="Probability %">
            <Input type="number" min="0" max="100" value={form.probability} onChange={(e) => setForm({ ...form, probability: e.target.value })} />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Expected close">
            <Input type="date" value={form.closeDate} onChange={(e) => setForm({ ...form, closeDate: e.target.value })} />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={[{ value: 'PRODUCT', label: 'Product reselling' }, { value: 'SERVICE', label: 'Managed service' }, { value: 'MIXED', label: 'Mixed' }]} />
          </Field>
          <Field label="Source">
            <ListSelect listKey="lists.leadSources" value={form.source} onChange={(v) => setForm({ ...form, source: v })} />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Partner">
            <AccountPicker
              value={form.partnerAccountId || null}
              type="PARTNER"
              selectedLabel={deal.partnerAccount?.name}
              onChange={(id) => setForm({ ...form, partnerAccountId: id ?? '' })}
            />
          </Field>
          <Field label="Primary contact">
            <ContactPicker
              value={form.primaryContactId || null}
              accountId={deal.account.id}
              selectedLabel={deal.primaryContact ? `${deal.primaryContact.firstName} ${deal.primaryContact.lastName}` : null}
              onChange={(id) => setForm({ ...form, primaryContactId: id ?? '' })}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Owner">
            <OwnerSelect value={form.ownerId} onChange={(v) => setForm({ ...form, ownerId: v })} />
          </Field>
          <Field label="Competitor">
            <Input value={form.competitor} onChange={(e) => setForm({ ...form, competitor: e.target.value })} placeholder="Who else is bidding?" />
          </Field>
        </div>

        <Field label="Next step">
          <Input value={form.nextStep} onChange={(e) => setForm({ ...form, nextStep: e.target.value })} />
        </Field>
        <Field label="Notes">
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>

        <CustomFieldInputs module="deals" values={custom} onChange={setCustom} />
      </div>
    </Modal>
  );
}

function RegistrationModal({ dealId, defaultPartner, onClose, onSaved }: {
  dealId: string;
  /** The deal's partner, pre-selected so a channel deal is one click to protect. */
  defaultPartner?: { id: string; name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [side, setSide] = useState<'VENDOR' | 'PARTNER'>('VENDOR');
  const [partnerLabel, setPartnerLabel] = useState<string | null>(defaultPartner?.name ?? null);
  const [form, setForm] = useState({
    vendorId: '', partnerId: defaultPartner?.id ?? '', partnerContactId: '',
    regNumber: '', status: 'SUBMITTED', submittedAt: dateInput(new Date()),
    expiresAt: '', approvedDiscount: '', notes: '',
  });
  const [error, setError] = useState<string | null>(null);

  // Both programmes run 90 days here, so the expiry is filled in from the submission
  // date and only touched if this one is different.
  const { data: settings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.get<Record<string, unknown>>('/settings/public'),
    staleTime: 300_000,
  });
  const validDays = Number(settings?.['pipeline.registrationValidDays'] ?? 90);
  const expiryDefault = form.submittedAt
    ? dateInput(new Date(new Date(form.submittedAt).getTime() + validDays * 86_400_000))
    : '';

  const save = useMutation({
    mutationFn: () =>
      api.post(`/deals/${dealId}/registrations`, {
        side,
        vendorId: side === 'VENDOR' ? form.vendorId : null,
        partnerId: side === 'PARTNER' ? form.partnerId : null,
        partnerContactId: side === 'PARTNER' ? form.partnerContactId || null : null,
        regNumber: form.regNumber || null,
        status: form.status,
        submittedAt: form.submittedAt || null,
        expiresAt: form.expiresAt || expiryDefault || null,
        approvedDiscount: form.approvedDiscount ? Number(form.approvedDiscount) : null,
        notes: form.notes || null,
      }),
    onSuccess: () => { toast.push('Registration recorded.'); onSaved(); onClose(); },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.'),
  });

  const counterpartySet = side === 'VENDOR' ? Boolean(form.vendorId) : Boolean(form.partnerId);

  return (
    <Modal
      open
      onClose={onClose}
      title="Deal registration"
      subtitle={`Runs ${validDays} days by default. Zeus warns you before it lapses.`}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!counterpartySet} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}

        <Field label="Which way does this registration point?">
          <div className="grid grid-cols-2 gap-1">
            {([
              { key: 'VENDOR' as const, label: 'With a vendor', hint: 'We registered it, to lock our buy price' },
              { key: 'PARTNER' as const, label: 'For a partner', hint: 'They brought it, we protect them' },
            ]).map((option) => (
              <button
                key={option.key}
                onClick={() => setSide(option.key)}
                className={cx(
                  'border px-3 py-2 text-left transition-colors',
                  side === option.key ? 'border-n950 bg-n950 text-white' : 'border-line bg-card hover:border-n900',
                )}
              >
                <span className="block text-[11px] font-bold uppercase tracking-[0.06em]">{option.label}</span>
                <span className={cx('mt-0.5 block text-[10px]', side === option.key ? 'text-white/70' : 'text-n400')}>{option.hint}</span>
              </button>
            ))}
          </div>
        </Field>

        {side === 'VENDOR' ? (
          <Field label="Vendor" required>
            <AccountPicker value={form.vendorId || null} type="VENDOR" onChange={(id) => setForm({ ...form, vendorId: id ?? '' })} placeholder="Search vendors…" />
          </Field>
        ) : (
          <>
            <Field label="Partner" required>
              <AccountPicker
                value={form.partnerId || null}
                type="PARTNER"
                selectedLabel={partnerLabel}
                onChange={(id, row) => { setPartnerLabel(row?.name ?? null); setForm({ ...form, partnerId: id ?? '', partnerContactId: '' }); }}
                placeholder="Search partners…"
              />
            </Field>
            <Field label="Partner contact" hint="Who Zeus emails before the protection lapses.">
              <ContactPicker
                value={form.partnerContactId || null}
                accountId={form.partnerId || null}
                onChange={(id) => setForm({ ...form, partnerContactId: id ?? '' })}
              />
            </Field>
          </>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Registration number">
            <Input value={form.regNumber} onChange={(e) => setForm({ ...form, regNumber: e.target.value })} placeholder="e.g. CS-2026-8841" />
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} options={['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'].map((s) => ({ value: s, label: s }))} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Submitted">
            <Input type="date" value={form.submittedAt} onChange={(e) => setForm({ ...form, submittedAt: e.target.value })} />
          </Field>
          <Field label="Expires" hint={form.expiresAt ? undefined : `${validDays} days`}>
            <Input
              type="date"
              value={form.expiresAt || expiryDefault}
              onChange={(e) => setForm({ ...form, expiresAt: e.target.value })}
            />
          </Field>
          <Field label="Approved disc %">
            <Input type="number" min="0" max="100" step="0.5" value={form.approvedDiscount} onChange={(e) => setForm({ ...form, approvedDiscount: e.target.value })} />
          </Field>
        </div>
        <Field label="Notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
