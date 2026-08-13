import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, Bell, Building2, Check, ChevronDown, Database, GitBranch, HardDrive, KeyRound, ListTree, Plug, ScrollText,
  ShieldHalf, SlidersHorizontal, Target as TargetIcon, Terminal, Trash2, Users as UsersIcon, Plus, RefreshCw, X,
} from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money, quarterOf, relative } from '../lib/format';
import {
  Avatar, Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, CopyButton, DataTable, EmptyState,
  ErrorNote, Field, Input, Loading, Modal, PageHeader, ProgressBar, Select, Textarea, cx, useToast,
} from '../components/ui';
import { Toolbar } from '../components/pickers';
import { AccessDenied } from '../components/Layout';
import { fileSize } from '../components/attachments';
import { UtilizationChart } from '../components/charts';

const SECTIONS = [
  { path: 'company', label: 'Company', icon: Building2, module: 'settings' },
  { path: 'finance', label: 'Finance & VAT', icon: Database, module: 'settings' },
  { path: 'lists', label: 'Dropdown lists', icon: ListTree, module: 'settings' },
  { path: 'fields', label: 'Custom fields', icon: SlidersHorizontal, module: 'settings' },
  { path: 'pipelines', label: 'Pipelines', icon: GitBranch, module: 'settings' },
  { path: 'users', label: 'Users & teams', icon: UsersIcon, module: 'users' },
  { path: 'roles', label: 'Roles & permissions', icon: ShieldHalf, module: 'roles' },
  { path: 'targets', label: 'Targets', icon: TargetIcon, module: 'settings' },
  { path: 'notifications', label: 'Notifications', icon: Bell, module: 'settings' },
  // Named for what the tab holds, not for one of the things in it — Microsoft 365,
  // WhatsApp, backups and sign-in all live here.
  { path: 'integrations', label: 'Integrations', icon: Plug, module: 'integrations' },
  { path: 'backups', label: 'Backups', icon: HardDrive, module: 'backups' },
  { path: 'audit', label: 'Audit trail', icon: ScrollText, module: 'audit' },
  { path: 'status', label: 'System status', icon: Activity, module: 'audit' },
  { path: 'logs', label: 'System log', icon: Terminal, module: 'audit' },
  { path: 'profile', label: 'My account', icon: KeyRound, module: '*' },
];

export default function Settings() {
  const location = useLocation();
  const navigate = useNavigate();
  const { can } = useAuth();

  const available = SECTIONS.filter((section) => section.module === '*' || can(section.module, 'read'));
  const current = location.pathname.split('/settings/')[1]?.split('/')[0] ?? '';

  useEffect(() => {
    if (!current && available.length) navigate(`/settings/${available[0].path}`, { replace: true });
  }, [current, available, navigate]);

  if (available.length === 0) return <AccessDenied module="settings" />;

  const section = available.find((s) => s.path === current);

  return (
    <>
      <PageHeader title="Settings" description="Everything Zeus does by default can be changed here — no redeploy needed." />

      <div className="grid gap-3 lg:grid-cols-[228px_1fr]">
        <Card className="h-fit lg:sticky lg:top-4">
          <nav>
            {available.map((item) => (
              <NavLink
                key={item.path}
                to={`/settings/${item.path}`}
                className={({ isActive }) =>
                  cx(
                    'flex items-center gap-2.5 border-b border-line px-3.5 py-2.5 text-[13px] transition-colors last:border-0',
                    isActive ? 'border-l-[3px] border-l-accent bg-accent-soft font-semibold' : 'text-muted hover:bg-sunken hover:text-ink',
                  )
                }
              >
                <item.icon size={15} />
                {item.label}
              </NavLink>
            ))}
          </nav>
        </Card>

        <div className="min-w-0">
          {!section ? <Loading /> :
            section.path === 'company' ? <SettingsGroup prefix="company." title="Company details" description="Used on quote and invoice letterheads." /> :
            section.path === 'finance' ? (
              <div className="flex flex-col gap-3">
                <SettingsGroup prefix="finance." title="Finance & VAT" description="Currency, VAT rate and default terms." />
                <ExchangeRatesSection />
              </div>
            ) :
            section.path === 'lists' ? <ListsSection /> :
            section.path === 'fields' ? <CustomFieldsSection /> :
            section.path === 'pipelines' ? <PipelinesSection /> :
            section.path === 'users' ? <UsersSection /> :
            section.path === 'roles' ? <RolesSection /> :
            section.path === 'targets' ? <TargetsSection /> :
            section.path === 'notifications' ? <NotificationsSection /> :
            section.path === 'integrations' ? <IntegrationsSection /> :
            section.path === 'backups' ? <BackupsSection /> :
            section.path === 'audit' ? <AuditSection /> :
            section.path === 'status' ? <StatusSection /> :
            section.path === 'logs' ? <SystemLogSection /> :
            <ProfileSection />}
        </div>
      </div>
    </>
  );
}

// ── generic key/value settings ────────────────────────────────────────────────

const LABELS: Record<string, string> = {
  'company.name': 'Trading name', 'company.legalName': 'Legal name', 'company.trn': 'TRN (tax registration number)',
  'company.addressLine1': 'Address line 1', 'company.addressLine2': 'Address line 2', 'company.city': 'City',
  'company.emirate': 'Emirate', 'company.country': 'Country', 'company.poBox': 'P.O. Box', 'company.phone': 'Phone',
  'company.email': 'Email', 'company.website': 'Website', 'company.bankName': 'Bank name',
  'company.bankIban': 'IBAN', 'company.bankSwift': 'SWIFT',
  'finance.currency': 'Currency', 'finance.vatRate': 'VAT rate (%)', 'finance.vatLabel': 'VAT label on documents',
  'finance.quoteValidDays': 'Quote validity (days)', 'finance.paymentTermsDays': 'Payment terms (days)',
  'finance.quoteTerms': 'Default quote terms',
  'pipeline.staleAccountDays': 'Account is stale after (days)', 'pipeline.staleDealDays': 'Deal is stuck after (days)',
  'pipeline.registrationExpiryWarnDays': 'Warn before registration expiry (days)',
  'pipeline.registrationValidDays': 'Registration runs for (days)',
  'pipeline.notifyPartnerOnExpiry': 'Email the partner before their registration lapses',
  'pipeline.partnerReminderDays': 'Partner reminder lead time (days)',
  'pipeline.taskReminderHours': 'Task reminder lead time (hours)',
  'approvals.dealsEnabled': 'Deals need a manager\u2019s approval to close won',
  'approvals.dealMinAmount': 'Deals above this value need approval (0 = all)',
  'approvals.dealMinMarginPct': 'Deals under this margin % need approval (0 = off)',
  'approvals.purchaseOrdersEnabled': 'Purchase orders need approval before they are issued',
  'approvals.purchaseOrderMinAmount': 'Orders above this value need approval (0 = all)',
  'approvals.invoicesEnabled': 'Invoices need approval before they are sent',
  'approvals.invoiceMinAmount': 'Invoices above this value need approval (0 = all)',
  'approvals.allowSelfApproval': 'Let a manager approve their own submission',
  'undo.windowHours': 'Undo reaches back (hours)',
  'audit.logReads': 'Log record views (who opened each record — high volume)',
  'numbering.dealPrefix': 'Deal reference prefix', 'numbering.quotePrefix': 'Quote number prefix',
  'numbering.invoicePrefix': 'Invoice number prefix', 'numbering.padding': 'Number padding',
  'backup.enabled': 'Nightly backup enabled', 'backup.cron': 'Backup schedule (cron)', 'backup.retainLocal': 'Local backups to keep',
  'backup.folder': 'OneDrive folder',
  'syslog.enabled': 'Forward system log to SIEM', 'syslog.host': 'Syslog server host', 'syslog.port': 'Syslog port',
  'syslog.protocol': 'Protocol (udp or tcp)',
  'auth.allowLocalLogin': 'Allow password sign-in', 'auth.allowEntraLogin': 'Allow Microsoft sign-in',
  'auth.autoProvisionEntra': 'Create users automatically on first Microsoft sign-in',
  'auth.defaultRoleName': 'Default role for new users', 'auth.sessionHours': 'Session length (hours)',
  'dedupe.enabled': 'Duplicate detection on', 'dedupe.blockOnExactDomain': 'Block saves on an exact domain match',
  'branding.productName': 'Product name', 'branding.tagline': 'Tagline',
};

function SettingsGroup({ prefix, title, description, extraPrefixes = [] }: {
  prefix: string;
  title: string;
  description: string;
  extraPrefixes?: string[];
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ values: Record<string, unknown> }>('/settings'),
  });

  const save = useMutation({
    mutationFn: () => api.put('/settings', draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['settings-public'] });
      setDraft({});
      toast.push('Settings saved.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not save.', 'error'),
  });

  if (isLoading) return <Loading />;

  const prefixes = [prefix, ...extraPrefixes];
  const keys = Object.keys(data?.values ?? {})
    .filter((key) => prefixes.some((p) => key.startsWith(p)))
    // Lists and rate tables get their own editors; a text box would print [object Object].
    .filter((key) => typeof data!.values[key] !== 'object' || data!.values[key] === null)
    .sort();

  const value = (key: string) => (key in draft ? draft[key] : data!.values[key]);
  const dirty = Object.keys(draft).length > 0;

  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={description}
        actions={can('settings', 'update') ? <Button variant="accent" size="sm" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save</Button> : undefined}
      />
      <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
        {keys.map((key) => {
          const current = value(key);
          const label = LABELS[key] ?? key.split('.')[1];
          const isBool = typeof data!.values[key] === 'boolean';
          const isNumber = typeof data!.values[key] === 'number';
          const isLong = key.endsWith('Terms');

          if (isBool) {
            return (
              <div key={key} className="flex items-center sm:col-span-2">
                <Checkbox
                  label={label}
                  checked={Boolean(current)}
                  disabled={!can('settings', 'update')}
                  onChange={(checked) => setDraft({ ...draft, [key]: checked })}
                />
              </div>
            );
          }

          return (
            <Field key={key} label={label} className={isLong ? 'sm:col-span-2' : undefined}>
              {isLong ? (
                <Textarea
                  rows={3}
                  value={String(current ?? '')}
                  disabled={!can('settings', 'update')}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              ) : (
                <Input
                  type={isNumber ? 'number' : 'text'}
                  value={String(current ?? '')}
                  disabled={!can('settings', 'update')}
                  onChange={(e) => setDraft({ ...draft, [key]: isNumber ? Number(e.target.value) : e.target.value })}
                />
              )}
            </Field>
          );
        })}
      </div>
      {prefix === 'finance.' ? (
        <div className="border-t border-line bg-sunken px-4 py-3 text-[12px] text-muted">
          Changing the VAT rate affects new quotes and deals only — documents already issued keep the rate they were created with.
        </div>
      ) : null}
    </Card>
  );
}

// ── exchange rates ────────────────────────────────────────────────────────────

/**
 * Exchange rates, fetched rather than typed.
 *
 * These are read-only on purpose. They refresh from a public feed every morning and at
 * boot, so there is nothing here to keep up to date by hand — and a number someone
 * typed six months ago is exactly the failure this replaced. What the screen owes the
 * reader is the rate, when it was last confirmed, and where it came from.
 *
 * Only the currencies Zeus actually prices in appear: the ones its price book and
 * catalogue use, plus the dollar. There is no list of currencies nobody trades in.
 */
function ExchangeRatesSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ values: Record<string, unknown> }>('/settings'),
  });

  const refresh = useMutation({
    mutationFn: () => api.post<{ ok: boolean; updated: string[]; skipped: Record<string, string> }>(
      '/settings/exchange-rates/refresh', {},
    ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      const refused = Object.values(result.skipped ?? {});
      if (result.updated?.length) toast.push(`Rates updated: ${result.updated.join(', ')}.`);
      else toast.push(refused[0] ?? 'The rates feed had nothing new. The stored rate stands.', 'error');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not reach the rates feed.', 'error'),
  });

  if (isLoading) return <Loading />;

  const base = String(data?.values['finance.currency'] ?? 'AED');
  const rates = (data?.values['finance.exchangeRates'] ?? {}) as Record<string, number>;
  const codes = Object.keys(rates).sort();
  const updatedAt = String(data?.values['finance.exchangeRatesUpdatedAt'] ?? '');
  const feed = String(data?.values['finance.exchangeRateApi'] ?? '');
  const host = feed ? feed.replace(/^https?:\/\//, '').split('/')[0] : null;

  return (
    <Card>
      <CardHeader
        title="Exchange rates"
        subtitle={`${base} per one unit of the vendor's currency. Fetched daily and applied to vendor costs on quotes and orders.`}
        actions={can('settings', 'update') ? (
          <Button size="sm" icon={<RefreshCw size={13} />} loading={refresh.isPending} onClick={() => refresh.mutate()}>
            Refresh now
          </Button>
        ) : undefined}
      />

      <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
        {codes.length === 0 ? (
          <p className="text-[12px] text-muted sm:col-span-2">
            No rates yet. Vendor prices in another currency are flagged on the line rather than converted.
          </p>
        ) : codes.map((currency) => (
          <div key={currency} className="rounded-sharp border border-line px-3 py-2.5">
            <span className="eyebrow">1 {currency}</span>
            <span className="mt-0.5 block tabular text-[18px] font-semibold">{rates[currency]} {base}</span>
          </div>
        ))}
      </div>

      <div className="border-t border-line bg-sunken px-4 py-3 text-[12px] text-muted">
        {updatedAt ? `Last fetched ${relative(updatedAt)}` : 'Not fetched yet — showing the seeded rate'}
        {host ? ` from ${host}` : null}. Refreshes every morning and at start-up.
        {' '}A rate that arrives more than 25% away from the stored one is refused rather than applied, and someone is told.
        {' '}Lines already saved keep the figure they were given.
      </div>
    </Card>
  );
}

// ── editable dropdown lists ───────────────────────────────────────────────────

function ListsSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [draft, setDraft] = useState<Record<string, string[]>>({});

  const { data, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ values: Record<string, unknown> }>('/settings'),
  });

  const save = useMutation({
    mutationFn: () => api.put('/settings', draft),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      void queryClient.invalidateQueries({ queryKey: ['settings-public'] });
      setDraft({});
      toast.push('Lists saved.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not save.', 'error'),
  });

  if (isLoading) return <Loading />;

  const listKeys = Object.keys(data?.values ?? {}).filter((key) => key.startsWith('lists.') && Array.isArray(data!.values[key])).sort();
  const items = (key: string): string[] => (key in draft ? draft[key] : (data!.values[key] as string[]));
  const setItems = (key: string, next: string[]) => setDraft({ ...draft, [key]: next });

  const pretty = (key: string) =>
    key.replace('lists.', '').replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

  return (
    <Card>
      <CardHeader
        title="Dropdown lists"
        subtitle="Every picklist in Zeus. Add or remove options and they change everywhere at once."
        actions={can('settings', 'update') ? <Button variant="accent" size="sm" disabled={!Object.keys(draft).length} loading={save.isPending} onClick={() => save.mutate()}>Save</Button> : undefined}
      />
      <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
        {listKeys.map((key) => (
          <div key={key}>
            <span className="eyebrow">{pretty(key)}</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {items(key).map((item) => (
                <span key={item} className="flex items-center gap-1 rounded-sharp border border-line bg-card px-2 py-1 text-[12px]">
                  {item}
                  {can('settings', 'update') ? (
                    <button onClick={() => setItems(key, items(key).filter((i) => i !== item))} aria-label={`Remove ${item}`} className="text-n300 hover:text-accent">
                      <X size={11} />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
            {can('settings', 'update') ? (
              <Input
                className="mt-2"
                placeholder="Type and press Enter to add…"
                onKeyDown={(e) => {
                  if (e.key !== 'Enter') return;
                  e.preventDefault();
                  const value = (e.target as HTMLInputElement).value.trim();
                  if (!value || items(key).includes(value)) return;
                  setItems(key, [...items(key), value]);
                  (e.target as HTMLInputElement).value = '';
                }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ── custom fields ─────────────────────────────────────────────────────────────

interface CustomField {
  id: string; module: string; key: string; label: string; type: string;
  options: string[]; required: boolean; order: number; isActive: boolean;
}

const FIELD_MODULES = [
  { value: 'deals', label: 'Deals' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'leads', label: 'Leads' },
  { value: 'products', label: 'Catalog items' },
];

const FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'currency', label: 'Currency (AED)' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Dropdown' },
  { value: 'multiselect', label: 'Multi-select' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'url', label: 'URL' },
  { value: 'email', label: 'Email' },
];

const NEEDS_OPTIONS = new Set(['select', 'multiselect']);

function CustomFieldsSection() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [module, setModule] = useState('deals');
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<CustomField | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['custom-fields-admin', module],
    queryFn: () => api.get<CustomField[]>(`/custom-fields${qs({ module })}`),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/custom-fields/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['custom-fields-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
      setRemoving(null);
      toast.push('Field retired. Existing values are kept.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not remove the field.', 'error'),
  });

  return (
    <>
      <Card>
        <CardHeader
          title="Custom fields"
          subtitle="Add a field to any module without a migration. It appears on the record form and detail page immediately."
          actions={
            <>
              <Select value={module} onChange={(e) => setModule(e.target.value)} options={FIELD_MODULES} className="w-[160px]" />
              {can('settings', 'create') ? <Button variant="accent" size="sm" icon={<Plus size={13} />} onClick={() => setCreating(true)}>Add field</Button> : null}
            </>
          }
        />

        {isLoading ? (
          <Loading />
        ) : (data ?? []).length === 0 ? (
          <EmptyState
            title="No custom fields yet"
            message={`Nothing extra on ${FIELD_MODULES.find((m) => m.value === module)?.label.toLowerCase()}. Add one for anything Zeus does not track out of the box — contract end date, procurement portal, tender reference.`}
            action={can('settings', 'create') ? <Button variant="accent" size="sm" onClick={() => setCreating(true)}>Add field</Button> : undefined}
          />
        ) : (
          <DataTable
            rows={data ?? []}
            rowKey={(row) => row.id}
            onRowClick={can('settings', 'update') ? (row) => setEditing(row) : undefined}
            columns={[
              {
                key: 'label', header: 'Field',
                render: (row) => (
                  <span>
                    <span className="block font-semibold">{row.label}</span>
                    <span className="block font-mono text-[11px] text-muted">{row.key}</span>
                  </span>
                ),
              },
              { key: 'type', header: 'Type', width: '130px', render: (row) => <Badge tone="neutral">{FIELD_TYPES.find((t) => t.value === row.type)?.label ?? row.type}</Badge> },
              {
                key: 'options', header: 'Options',
                render: (row) => row.options.length
                  ? <span className="text-[12px] text-muted">{row.options.join(' · ')}</span>
                  : <span className="text-n400">—</span>,
              },
              { key: 'required', header: 'Required', align: 'center', width: '90px', render: (row) => row.required ? <Check size={14} className="mx-auto text-secure" /> : <span className="text-n400">—</span> },
              { key: 'order', header: 'Order', align: 'right', width: '70px', render: (row) => <span className="tabular text-[12px] text-muted">{row.order}</span> },
              {
                key: 'actions', header: '', width: '50px',
                render: (row) => can('settings', 'delete') ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); setRemoving(row); }}
                    aria-label={`Retire ${row.label}`}
                    className="text-n300 transition-colors hover:text-accent"
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null,
              },
            ]}
          />
        )}

        <p className="border-t border-line bg-sunken px-4 py-2.5 text-[11px] text-muted">
          Values are stored per record and validated against the type on save. Retiring a field hides it
          everywhere but keeps the data, so turning it back on restores the values.
        </p>
      </Card>

      {creating || editing ? (
        <CustomFieldModal field={editing} module={module} onClose={() => { setCreating(false); setEditing(null); }} />
      ) : null}

      <ConfirmDialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        onConfirm={() => remove.mutate(removing!.id)}
        loading={remove.isPending}
        title="Retire this field?"
        confirmLabel="Retire field"
        message={<><strong>{removing?.label}</strong> stops appearing on forms and detail pages. Values already captured stay in the database.</>}
      />
    </>
  );
}

function CustomFieldModal({ field, module, onClose }: { field: CustomField | null; module: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState({
    module: field?.module ?? module,
    key: field?.key ?? '',
    label: field?.label ?? '',
    type: field?.type ?? 'text',
    options: field?.options ?? [],
    required: field?.required ?? false,
    order: field?.order ?? 0,
  });
  const [error, setError] = useState<string | null>(null);

  // Suggest a key from the label until the user has typed one themselves.
  const autoKey = (label: string) =>
    label.trim().toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean)
      .map((word, index) => (index === 0 ? word : word[0].toUpperCase() + word.slice(1)))
      .join('')
      .replace(/^[0-9]+/, '') || '';

  const save = useMutation({
    mutationFn: () => {
      const body = {
        label: form.label.trim(),
        options: NEEDS_OPTIONS.has(form.type) ? form.options : [],
        required: form.required,
        order: Number(form.order),
      };
      return field
        ? api.patch(`/custom-fields/${field.id}`, body)
        : api.post('/custom-fields', { ...body, module: form.module, key: form.key.trim(), type: form.type });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['custom-fields-admin'] });
      void queryClient.invalidateQueries({ queryKey: ['custom-fields'] });
      toast.push(field ? 'Field updated.' : 'Field added.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the field.'),
  });

  const ready = form.label.trim() && form.key.trim() && (!NEEDS_OPTIONS.has(form.type) || form.options.length > 0);

  return (
    <Modal
      open
      onClose={onClose}
      title={field ? `Edit field — ${field.label}` : 'New custom field'}
      subtitle={field ? 'The key and type are fixed once values exist.' : 'Appears on the record form and detail page as soon as you save.'}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>
            {field ? 'Save changes' : 'Add field'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Module" required>
            <Select
              value={form.module}
              disabled={Boolean(field)}
              onChange={(e) => setForm({ ...form, module: e.target.value })}
              options={FIELD_MODULES}
            />
          </Field>
          <Field label="Type" required hint={field ? 'Fixed after creation.' : undefined}>
            <Select
              value={form.type}
              disabled={Boolean(field)}
              onChange={(e) => setForm({ ...form, type: e.target.value })}
              options={FIELD_TYPES}
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Label" required hint="What the sales team sees.">
            <Input
              value={form.label}
              autoFocus
              onChange={(e) => {
                const label = e.target.value;
                setForm((current) => ({
                  ...current,
                  label,
                  key: field || (current.key && current.key !== autoKey(current.label)) ? current.key : autoKey(label),
                }));
              }}
              placeholder="e.g. Tender reference"
            />
          </Field>
          <Field label="Key" required hint={field ? 'Fixed after creation.' : 'Letters, numbers and underscores. Used in exports and the API.'}>
            <Input
              value={form.key}
              disabled={Boolean(field)}
              onChange={(e) => setForm({ ...form, key: e.target.value })}
              className="font-mono"
              placeholder="tenderReference"
            />
          </Field>
        </div>

        {NEEDS_OPTIONS.has(form.type) ? (
          <Field label="Options" required hint="Press Enter to add each one.">
            <div className="mb-2 flex flex-wrap gap-1.5">
              {form.options.map((option) => (
                <span key={option} className="flex items-center gap-1 rounded-sharp border border-line bg-card px-2 py-1 text-[12px]">
                  {option}
                  <button onClick={() => setForm({ ...form, options: form.options.filter((o) => o !== option) })} aria-label={`Remove ${option}`} className="text-n300 hover:text-accent">
                    <X size={11} />
                  </button>
                </span>
              ))}
              {form.options.length === 0 ? <span className="text-[12px] text-n400">No options yet.</span> : null}
            </div>
            <Input
              placeholder="Type an option and press Enter…"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const value = (e.target as HTMLInputElement).value.trim();
                if (!value || form.options.includes(value)) return;
                setForm({ ...form, options: [...form.options, value] });
                (e.target as HTMLInputElement).value = '';
              }}
            />
          </Field>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Display order" hint="Lower numbers appear first.">
            <Input type="number" value={form.order} onChange={(e) => setForm({ ...form, order: Number(e.target.value) })} />
          </Field>
          <div className="flex flex-col justify-end gap-2 pb-2">
            <Checkbox label="Required on create" checked={form.required} onChange={(checked) => setForm({ ...form, required: checked })} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── pipelines & stages ────────────────────────────────────────────────────────

interface Stage { id?: string; name: string; probability: number; isWon: boolean; isLost: boolean; color: string; rotDays: number }
interface Pipeline { id: string; name: string; kind: string; isDefault: boolean; stages: Array<Stage & { id: string; order: number }>; _count: { deals: number } }

function PipelinesSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [editing, setEditing] = useState<Pipeline | null>(null);
  const [stages, setStages] = useState<Stage[]>([]);

  const { data, isLoading } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => api.get<Pipeline[]>('/pipelines'),
  });

  const save = useMutation({
    mutationFn: () => api.put(`/pipelines/${editing!.id}/stages`, stages),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      toast.push('Stages updated.');
      setEditing(null);
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not save stages.', 'error'),
  });

  if (isLoading) return <Loading />;

  const start = (pipeline: Pipeline) => {
    setEditing(pipeline);
    setStages(pipeline.stages.map(({ id, name, probability, isWon, isLost, color, rotDays }) => ({ id, name, probability, isWon, isLost, color, rotDays })));
  };

  return (
    <>
      <Card>
        <CardHeader title="Pipelines" subtitle="Rename stages, change win probabilities, add steps that match how you actually sell." />
        {(data ?? []).map((pipeline) => (
          <div key={pipeline.id} className="border-b border-line last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-semibold">{pipeline.name}</span>
                {pipeline.isDefault ? <Badge tone="dark">Default</Badge> : null}
                <span className="text-[11px] text-muted">{pipeline._count.deals} deal{pipeline._count.deals === 1 ? '' : 's'}</span>
              </span>
              {can('settings', 'update') ? <Button size="sm" onClick={() => start(pipeline)}>Edit stages</Button> : null}
            </div>
            <div className="flex flex-wrap gap-1 px-4 pb-3">
              {pipeline.stages.map((stage) => (
                <span key={stage.id} className="flex items-center gap-1.5 border border-line bg-card px-2 py-1 text-[11px]">
                  <span className="h-2 w-2" style={{ background: stage.color }} />
                  {stage.name}
                  <span className="text-n400">{stage.probability}%</span>
                  {stage.isWon ? <Badge tone="secure">Won</Badge> : stage.isLost ? <Badge tone="accent">Lost</Badge> : null}
                </span>
              ))}
            </div>
          </div>
        ))}
      </Card>

      {editing ? (
        <Modal
          open
          onClose={() => setEditing(null)}
          title={`Stages — ${editing.name}`}
          subtitle="Deals keep their stage when you rename it. A stage holding deals cannot be removed."
          width="lg"
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="accent" loading={save.isPending} onClick={() => save.mutate()}>Save stages</Button>
            </>
          }
        >
          <div className="space-y-2">
            {stages.map((stage, index) => (
              <div key={index} className="grid grid-cols-[1fr_84px_84px_44px_auto] items-end gap-2 border border-line bg-card p-2">
                <Field label={index === 0 ? 'Stage name' : undefined}>
                  <Input value={stage.name} onChange={(e) => setStages(stages.map((s, i) => (i === index ? { ...s, name: e.target.value } : s)))} />
                </Field>
                <Field label={index === 0 ? 'Prob %' : undefined}>
                  <Input type="number" min="0" max="100" value={stage.probability} onChange={(e) => setStages(stages.map((s, i) => (i === index ? { ...s, probability: Number(e.target.value) } : s)))} />
                </Field>
                <Field label={index === 0 ? 'Rot days' : undefined}>
                  <Input type="number" min="1" value={stage.rotDays} onChange={(e) => setStages(stages.map((s, i) => (i === index ? { ...s, rotDays: Number(e.target.value) } : s)))} />
                </Field>
                <Field label={index === 0 ? 'Colour' : undefined}>
                  <input
                    type="color"
                    value={stage.color}
                    onChange={(e) => setStages(stages.map((s, i) => (i === index ? { ...s, color: e.target.value } : s)))}
                    className="h-[38px] w-full cursor-pointer rounded-sharp border border-line"
                  />
                </Field>
                <div className="flex items-center gap-2 pb-2">
                  <label className="flex items-center gap-1 text-[11px]">
                    <input type="checkbox" checked={stage.isWon} onChange={(e) => setStages(stages.map((s, i) => (i === index ? { ...s, isWon: e.target.checked, isLost: false } : s)))} className="h-3.5 w-3.5 accent-[var(--status-secure)]" />
                    Won
                  </label>
                  <label className="flex items-center gap-1 text-[11px]">
                    <input type="checkbox" checked={stage.isLost} onChange={(e) => setStages(stages.map((s, i) => (i === index ? { ...s, isLost: e.target.checked, isWon: false } : s)))} className="h-3.5 w-3.5 accent-[var(--red-500)]" />
                    Lost
                  </label>
                  <button onClick={() => setStages(stages.filter((_, i) => i !== index))} aria-label="Remove stage" className="text-n300 hover:text-accent">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            <Button size="sm" icon={<Plus size={13} />} onClick={() => setStages([...stages, { name: '', probability: 50, isWon: false, isLost: false, color: '#6b6b6b', rotDays: 14 }])}>
              Add stage
            </Button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// ── users & teams ─────────────────────────────────────────────────────────────

interface UserRow {
  id: string; email: string; name: string; jobTitle: string | null; whatsappNumber: string | null; avatarColor: string; isActive: boolean;
  lastLoginAt: string | null; lastLoginIp: string | null; lastLoginDevice: string | null; totpEnabledAt: string | null; entraOid: string | null;
  role: { id: string; name: string }; team: { id: string; name: string } | null; manager: { id: string; name: string } | null;
  _count: { ownedDeals: number; ownedAccounts: number };
}

function UsersSection() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [offboarding, setOffboarding] = useState<UserRow | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ data: UserRow[] }>('/users?pageSize=200'),
  });

  const { data: teams } = useQuery({ queryKey: ['teams'], queryFn: () => api.get<Array<{ id: string; name: string; kind: string; _count: { users: number } }>>('/teams') });

  if (isLoading) return <Loading />;

  return (
    <>
      <Card>
        <CardHeader
          title="Users"
          subtitle="Deactivate rather than delete — record ownership and the audit trail stay intact."
          actions={can('users', 'create') ? <Button variant="accent" size="sm" icon={<Plus size={13} />} onClick={() => setCreating(true)}>Add user</Button> : undefined}
        />
        <DataTable
          rows={data?.data ?? []}
          rowKey={(row) => row.id}
          onRowClick={can('users', 'update') ? (row) => setEditing(row) : undefined}
          columns={[
            {
              key: 'name', header: 'User',
              render: (row) => (
                <span className="flex items-center gap-2">
                  <Avatar name={row.name} color={row.avatarColor} size={26} />
                  <span>
                    <span className="block font-semibold">{row.name}</span>
                    <span className="block text-[11px] text-muted">{row.email}</span>
                  </span>
                </span>
              ),
            },
            { key: 'role', header: 'Role', width: '150px', render: (row) => <Badge tone={row.role.name === 'Administrator' ? 'dark' : 'neutral'}>{row.role.name}</Badge> },
            { key: 'team', header: 'Team', width: '130px', render: (row) => <span className="text-[12px]">{row.team?.name ?? '—'}</span> },
            { key: 'records', header: 'Owns', width: '120px', render: (row) => <span className="tabular text-[12px] text-muted">{row._count.ownedDeals} deals · {row._count.ownedAccounts} accts</span> },
            { key: 'auth', header: 'Sign-in', width: '110px', render: (row) => <span className="text-[11px] text-muted">{row.entraOid ? 'Microsoft' : 'Password'}</span> },
            { key: 'twoFactor', header: '2FA', width: '64px', render: (row) => <Badge tone={row.totpEnabledAt ? 'secure' : 'neutral'}>{row.totpEnabledAt ? 'On' : 'Off'}</Badge> },
            {
              key: 'lastLoginAt', header: 'Last login', width: '200px',
              render: (row) => (
                <div className="text-[12px] text-muted">
                  <div>{relative(row.lastLoginAt)}</div>
                  {row.lastLoginIp || row.lastLoginDevice ? (
                    <div className="text-[10px] text-n400">{[row.lastLoginIp, row.lastLoginDevice].filter(Boolean).join(' · ')}</div>
                  ) : null}
                </div>
              ),
            },
            { key: 'isActive', header: '', width: '80px', render: (row) => row.isActive ? null : <Badge tone="accent">Inactive</Badge> },
            {
              key: 'offboard', header: '', width: '110px', align: 'right',
              render: (row) => can('users', 'update')
                ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setOffboarding(row); }}>Transfer</Button>
                : null,
            },
          ]}
        />
      </Card>

      <Card className="mt-3">
        <CardHeader title="Teams" subtitle="Used by the &quot;team&quot; permission scope — a rep sees their own team's records." />
        <div className="flex flex-wrap gap-2 px-4 py-3">
          {(teams ?? []).map((team) => (
            <span key={team.id} className="flex items-center gap-2 border border-line bg-card px-3 py-1.5 text-[12px]">
              <span className="font-semibold">{team.name}</span>
              <Badge tone={team.kind === 'service' ? 'info' : 'neutral'}>{team.kind}</Badge>
              <span className="text-muted">{team._count.users} member{team._count.users === 1 ? '' : 's'}</span>
            </span>
          ))}
        </div>
      </Card>

      {creating || editing ? <UserModal user={editing} teams={teams ?? []} onClose={() => { setCreating(false); setEditing(null); }} /> : null}
      {offboarding ? <OffboardModal user={offboarding} users={data?.data ?? []} onClose={() => setOffboarding(null)} /> : null}
    </>
  );
}

/** Offboarding wizard: move a leaving user's records to another, per module. */
function OffboardModal({ user, users, onClose }: { user: UserRow; users: UserRow[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [toUserId, setToUserId] = useState('');
  const [modules, setModules] = useState<Set<string>>(new Set());
  const [deactivate, setDeactivate] = useState(true);

  const { data: preview } = useQuery({
    queryKey: ['transfer-preview', user.id],
    queryFn: () => api.get<{ modules: Array<{ key: string; label: string }>; counts: Record<string, number> }>(`/users/${user.id}/transfer/preview`),
  });

  const toggle = (key: string) => setModules((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const recipients = users.filter((u) => u.id !== user.id && u.isActive);

  const transfer = useMutation({
    mutationFn: () => api.post<{ total: number }>(`/users/${user.id}/transfer`, { toUserId, modules: [...modules], deactivate }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      toast.push(`Transferred ${r.total} record(s) from ${user.name}.`);
      onClose();
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Transfer failed.', 'error'),
  });

  const total = [...modules].reduce((sum, k) => sum + (preview?.counts[k] ?? 0), 0);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Transfer ${user.name}'s records`}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={transfer.isPending} disabled={!toUserId || modules.size === 0} onClick={() => transfer.mutate()}>
            Transfer {total} record{total === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[13px]">
        <Field label="Give the records to">
          <Select
            value={toUserId}
            onChange={(e) => setToUserId(e.target.value)}
            placeholder="Choose the recipient…"
            options={recipients.map((u) => ({ value: u.id, label: `${u.name} · ${u.role.name}` }))}
          />
        </Field>

        <div>
          <p className="eyebrow mb-1.5">What to move</p>
          <div className="flex flex-col gap-1.5 border border-line">
            {(preview?.modules ?? []).map((m) => {
              const count = preview?.counts[m.key] ?? 0;
              return (
                <label key={m.key} className={cx('flex items-center gap-2 px-3 py-2', count === 0 && 'opacity-50')}>
                  <input type="checkbox" checked={modules.has(m.key)} disabled={count === 0} onChange={() => toggle(m.key)} />
                  <span className="flex-1">{m.label}</span>
                  <span className="tabular text-muted">{count}</span>
                </label>
              );
            })}
          </div>
        </div>

        <Checkbox label={`Deactivate ${user.name} after transferring`} checked={deactivate} onChange={setDeactivate} />
        <p className="text-[11px] text-muted">Reversible from the audit trail. Recipients must be active users.</p>
      </div>
    </Modal>
  );
}

function UserModal({ user, teams, onClose }: { user: UserRow | null; teams: Array<{ id: string; name: string }>; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data: rolesData } = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ roles: Array<{ id: string; name: string }> }>('/roles') });
  const { data: users } = useQuery({ queryKey: ['users-lookup'], queryFn: () => api.get<Array<{ id: string; name: string }>>('/users/lookup') });

  const [form, setForm] = useState({
    name: user?.name ?? '', email: user?.email ?? '', password: '',
    jobTitle: user?.jobTitle ?? '', roleId: user?.role.id ?? '', teamId: user?.team?.id ?? '',
    managerId: user?.manager?.id ?? '', isActive: user?.isActive ?? true,
    whatsappNumber: user?.whatsappNumber ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name, email: form.email, jobTitle: form.jobTitle || null,
        roleId: form.roleId, teamId: form.teamId || null, managerId: form.managerId || null,
        whatsappNumber: form.whatsappNumber.trim() || null,
        isActive: form.isActive, ...(form.password ? { password: form.password } : {}),
      };
      return user ? api.patch(`/users/${user.id}`, body) : api.post('/users', body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['users-lookup'] });
      toast.push(user ? 'User updated.' : 'User created.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={user ? 'Edit user' : 'Add user'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!form.name || !form.email || !form.roleId} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Full name" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email" required hint="Must match their Microsoft 365 account for SSO.">
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
        </div>
        <Field label={user ? 'Reset password' : 'Password'} hint={user ? 'Leave blank to keep the current password.' : 'Optional — leave blank for Microsoft-only sign-in. Minimum 10 characters.'}>
          <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Role" required>
            <Select value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })} placeholder="Select a role" options={(rolesData?.roles ?? []).map((r) => ({ value: r.id, label: r.name }))} />
          </Field>
          <Field label="Team">
            <Select value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })} placeholder="No team" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="WhatsApp number" hint="International form. Blank means no WhatsApp alerts for this user.">
            <Input value={form.whatsappNumber} onChange={(e) => setForm({ ...form, whatsappNumber: e.target.value })} placeholder="+971 50 123 4567" />
          </Field>
          <Field label="Job title"><Input value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reports to">
            <Select value={form.managerId} onChange={(e) => setForm({ ...form, managerId: e.target.value })} placeholder="Nobody" options={(users ?? []).filter((u) => u.id !== user?.id).map((u) => ({ value: u.id, label: u.name }))} />
          </Field>
        </div>
        <Checkbox label="Account is active" checked={form.isActive} onChange={(checked) => setForm({ ...form, isActive: checked })} />
      </div>
    </Modal>
  );
}

// ── roles ─────────────────────────────────────────────────────────────────────

type Scope = 'all' | 'team' | 'own' | 'none';
interface ModulePermission { read: Scope; create: boolean; update: Scope; delete: Scope; export: boolean; approve?: boolean; fields?: Record<string, 'hidden' | 'read' | 'write'> }
interface Role { id: string; name: string; description: string | null; isSystem: boolean; permissions: Record<string, ModulePermission>; _count: { users: number } }

const SCOPES: Scope[] = ['none', 'own', 'team', 'all'];

function RolesSection() {
  const { can } = useAuth();
  const [editing, setEditing] = useState<Role | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ roles: Role[]; modules: string[]; protectedFields: Record<string, string[]> }>('/roles'),
  });

  if (isLoading || !data) return <Loading />;

  return (
    <>
      <Card>
        <CardHeader title="Roles & permissions" subtitle="Per-module read/create/update/delete scope, plus field-level visibility for cost and margin." />
        <DataTable
          rows={data.roles}
          rowKey={(row) => row.id}
          onRowClick={can('roles', 'update') ? (row) => setEditing(row) : undefined}
          columns={[
            {
              key: 'name', header: 'Role',
              render: (row) => (
                <span>
                  <span className="block font-semibold">{row.name}</span>
                  <span className="block text-[11px] text-muted">{row.description ?? '—'}</span>
                </span>
              ),
            },
            { key: 'users', header: 'Users', align: 'right', width: '80px', render: (row) => <span className="tabular">{row._count.users}</span> },
            {
              key: 'summary', header: 'Highlights', width: '260px',
              render: (row) => (
                <span className="flex flex-wrap gap-1">
                  {row.permissions.settings?.update !== 'none' ? <Badge tone="dark">Settings</Badge> : null}
                  {row.permissions.deals?.delete !== 'none' ? <Badge tone="accent">Can delete deals</Badge> : null}
                  {row.permissions.deals?.fields?.cost === 'hidden' ? <Badge tone="neutral">Cost hidden</Badge> : null}
                  <Badge tone="neutral">Deals: {row.permissions.deals?.read ?? 'none'}</Badge>
                </span>
              ),
            },
            { key: 'isSystem', header: '', width: '80px', render: (row) => row.isSystem ? <Badge tone="neutral">Built-in</Badge> : null },
          ]}
        />
      </Card>

      {editing ? <RoleModal role={editing} modules={data.modules} protectedFields={data.protectedFields} onClose={() => setEditing(null)} /> : null}
    </>
  );
}

function RoleModal({ role, modules, protectedFields, onClose }: {
  role: Role;
  modules: string[];
  protectedFields: Record<string, string[]>;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [permissions, setPermissions] = useState<Record<string, ModulePermission>>(
    Object.fromEntries(modules.map((m) => [m, role.permissions[m] ?? { read: 'none', create: false, update: 'none', delete: 'none', export: false }])),
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.patch(`/roles/${role.id}`, { permissions }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      toast.push('Role updated.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  const reset = useMutation({
    mutationFn: () => api.post<Role>(`/roles/${role.id}/reset`, {}),
    onSuccess: (updated) => {
      setPermissions(updated.permissions);
      void queryClient.invalidateQueries({ queryKey: ['roles'] });
      toast.push('Reset to shipped defaults.');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not reset.'),
  });

  const set = (module: string, patch: Partial<ModulePermission>) =>
    setPermissions({ ...permissions, [module]: { ...permissions[module], ...patch } });

  return (
    <Modal
      open
      onClose={onClose}
      title={`Permissions — ${role.name}`}
      subtitle="Scope decides which records; the field toggles decide which columns."
      width="xl"
      footer={
        <>
          {role.isSystem ? <Button variant="ghost" icon={<RefreshCw size={13} />} loading={reset.isPending} onClick={() => reset.mutate()}>Reset to defaults</Button> : null}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" loading={save.isPending} onClick={() => save.mutate()}>Save permissions</Button>
        </>
      }
    >
      {error ? <div className="mb-3"><ErrorNote error={error} /></div> : null}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-[12px]">
          <thead>
            <tr className="bg-n950 text-white">
              {['Module', 'Read', 'Create', 'Update', 'Delete', 'Export', 'Approve', 'Hidden fields'].map((header) => (
                <th key={header} className="px-2 py-2 text-left text-[10px] font-bold uppercase tracking-[0.08em]">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map((module, index) => {
              const perm = permissions[module];
              const fields = protectedFields[module] ?? [];
              return (
                <tr key={module} className={cx('border-b border-line', index % 2 === 1 && 'bg-sunken')}>
                  <td className="px-2 py-1.5 font-semibold capitalize">{module}</td>
                  <td className="px-2 py-1.5">
                    <ScopeSelect value={perm.read} onChange={(v) => set(module, { read: v })} />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={perm.create} onChange={(e) => set(module, { create: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
                  </td>
                  <td className="px-2 py-1.5"><ScopeSelect value={perm.update} onChange={(v) => set(module, { update: v })} /></td>
                  <td className="px-2 py-1.5"><ScopeSelect value={perm.delete} onChange={(v) => set(module, { delete: v })} /></td>
                  <td className="px-2 py-1.5 text-center">
                    <input type="checkbox" checked={perm.export} onChange={(e) => set(module, { export: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {module === 'deals' || module === 'invoices' ? (
                      <input
                        type="checkbox"
                        title="May sign off deals, purchase orders and invoices submitted by others"
                        checked={perm.approve ?? perm.update === 'all'}
                        onChange={(e) => set(module, { approve: e.target.checked })}
                        className="h-4 w-4 accent-[var(--red-500)]"
                      />
                    ) : (
                      <span className="text-n400">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="flex flex-wrap gap-2">
                      {fields.length === 0 ? <span className="text-n400">—</span> : fields.map((field) => (
                        <label key={field} className="flex items-center gap-1 text-[11px]">
                          <input
                            type="checkbox"
                            checked={perm.fields?.[field] === 'hidden'}
                            onChange={(e) => set(module, { fields: { ...perm.fields, [field]: e.target.checked ? 'hidden' : 'write' } })}
                            className="h-3.5 w-3.5 accent-[var(--red-500)]"
                          />
                          {field}
                        </label>
                      ))}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[11px] text-muted">
        <strong>own</strong> = only records they own · <strong>team</strong> = their team and direct reports · <strong>all</strong> = everything.
        <br />
        <strong>Approve</strong> on deals signs off a deal before it can close won; on invoices it covers both purchase orders and invoices before they leave the building.
      </p>
    </Modal>
  );
}

function ScopeSelect({ value, onChange }: { value: Scope; onChange: (value: Scope) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Scope)}
      className="w-full rounded-sharp border border-line bg-card px-1.5 py-1 text-[11px]"
    >
      {SCOPES.map((scope) => (
        <option key={scope} value={scope}>{scope}</option>
      ))}
    </select>
  );
}

// ── targets ───────────────────────────────────────────────────────────────────

function TargetsSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [year, setYear] = useState(new Date().getFullYear());
  const [draft, setDraft] = useState<Record<string, number>>({});

  const { data: targets, isLoading } = useQuery({
    queryKey: ['targets', year],
    queryFn: () => api.get<Array<{ id: string; userId: string | null; year: number; quarter: number; amount: string | number; user: { id: string; name: string } | null }>>(`/targets${qs({ year })}`),
  });
  const { data: users } = useQuery({ queryKey: ['users-lookup'], queryFn: () => api.get<Array<{ id: string; name: string }>>('/users/lookup') });

  const save = useMutation({
    mutationFn: () =>
      api.put('/targets', Object.entries(draft).map(([key, amount]) => {
        const [userId, quarter] = key.split('|');
        return { userId: userId === 'company' ? null : userId, year, quarter: Number(quarter), amount };
      })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['targets'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      setDraft({});
      toast.push('Targets saved.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not save.', 'error'),
  });

  if (isLoading) return <Loading />;

  const valueFor = (userId: string, quarter: number): number => {
    const key = `${userId}|${quarter}`;
    if (key in draft) return draft[key];
    const row = targets?.find((t) => (t.userId ?? 'company') === userId && t.quarter === quarter);
    return row ? Number(row.amount) : 0;
  };

  const rows = [{ id: 'company', name: 'Company-wide' }, ...(users ?? [])];
  const current = quarterOf();

  return (
    <Card>
      <CardHeader
        title="Quarterly targets"
        subtitle="Company-wide drives the dashboard gauge; per-rep drives the leaderboard."
        actions={
          <>
            <Select
              value={String(year)}
              onChange={(e) => setYear(Number(e.target.value))}
              options={[year - 1, year, year + 1].map((y) => ({ value: String(y), label: String(y) }))}
              className="w-[100px]"
            />
            {can('settings', 'update') ? (
              <Button variant="accent" size="sm" disabled={!Object.keys(draft).length} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            ) : null}
          </>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] border-collapse text-[13px]">
          <thead>
            <tr className="bg-n950 text-white">
              <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.08em]">Owner</th>
              {[1, 2, 3, 4].map((quarter) => (
                <th key={quarter} className={cx('px-3 py-2 text-right text-[10px] font-bold uppercase tracking-[0.08em]', year === current.year && quarter === current.quarter && 'text-[var(--red-300)]')}>
                  Q{quarter}
                </th>
              ))}
              <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-[0.08em]">Year</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const total = [1, 2, 3, 4].reduce((sum, quarter) => sum + valueFor(row.id, quarter), 0);
              return (
                <tr key={row.id} className={cx('border-b border-line', index === 0 ? 'bg-accent-soft font-semibold' : index % 2 === 1 && 'bg-sunken')}>
                  <td className="px-3 py-1.5">{row.name}</td>
                  {[1, 2, 3, 4].map((quarter) => (
                    <td key={quarter} className="px-2 py-1.5">
                      <Input
                        className="w-full px-2 py-1 text-right"
                        type="number"
                        min="0"
                        step="1000"
                        disabled={!can('settings', 'update')}
                        value={valueFor(row.id, quarter) || ''}
                        placeholder="0"
                        onChange={(e) => setDraft({ ...draft, [`${row.id}|${quarter}`]: Number(e.target.value || 0) })}
                      />
                    </td>
                  ))}
                  <td className="tabular px-3 py-1.5 text-right font-semibold">{money(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ── notifications ─────────────────────────────────────────────────────────────

interface Rule {
  id: string; event: string; label: string; enabled: boolean; inApp: boolean; email: boolean; teams: boolean; whatsapp: boolean;
  thresholdDays: number | null; audience: string; teamsWebhookId: string | null;
}
interface Webhook { id: string; name: string; url: string; isDefault: boolean; isActive: boolean }

function NotificationsSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const [addingHook, setAddingHook] = useState(false);
  const [deletingHook, setDeletingHook] = useState<Webhook | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['notification-rules'],
    queryFn: () => api.get<{ rules: Rule[]; webhooks: Webhook[] }>('/notification-rules'),
  });

  const update = useMutation({
    mutationFn: (input: { id: string } & Partial<Rule>) => {
      const { id, ...patch } = input;
      return api.patch(`/notification-rules/${id}`, patch);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['notification-rules'] }),
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not update.', 'error'),
  });

  const test = useMutation({
    mutationFn: (id: string) => api.post(`/teams-webhooks/${id}/test`, {}),
    onSuccess: () => toast.push('Test card posted to Teams.'),
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Test failed.', 'error'),
  });

  const removeHook = useMutation({
    mutationFn: (id: string) => api.del(`/teams-webhooks/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification-rules'] });
      setDeletingHook(null);
      toast.push('Webhook removed.');
    },
  });

  // The WhatsApp column stays disabled until the channel is actually connected, so
  // nobody switches on an alert that silently goes nowhere.
  const { data: whatsapp } = useQuery({
    queryKey: ['integration-whatsapp'],
    queryFn: () => api.get<{ isConnected: boolean; recipients: number }>('/integrations/whatsapp'),
    retry: false,
  });

  if (isLoading || !data) return <Loading />;

  const noWebhook = data.webhooks.length === 0;
  const whatsappReady = Boolean(whatsapp?.isConnected);

  return (
    <>
      <Card>
        <CardHeader
          title="Teams channels"
          subtitle="Paste an Incoming Webhook URL from the Teams channel you want alerts in."
          actions={can('settings', 'create') ? <Button size="sm" icon={<Plus size={13} />} onClick={() => setAddingHook(true)}>Add webhook</Button> : undefined}
        />
        {noWebhook ? (
          <EmptyState
            title="No Teams channel connected"
            message="In Teams: channel → ⋯ → Workflows (or Connectors) → Post to a channel when a webhook request is received. Copy the URL here."
            action={can('settings', 'create') ? <Button variant="accent" size="sm" onClick={() => setAddingHook(true)}>Add webhook</Button> : undefined}
          />
        ) : (
          <div className="divide-y divide-[var(--border-default)]">
            {data.webhooks.map((hook) => (
              <div key={hook.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="text-[13px] font-semibold">{hook.name}</span>
                {hook.isDefault ? <Badge tone="dark">Default</Badge> : null}
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{hook.url.slice(0, 60)}…</span>
                {can('settings', 'update') ? (
                  <>
                    <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate(hook.id)}>Test</Button>
                    <button onClick={() => setDeletingHook(hook)} aria-label="Remove webhook" className="text-n300 hover:text-accent"><Trash2 size={14} /></button>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-3">
        <CardHeader title="Alert rules" subtitle="Switch each event on or off per channel, and set the thresholds." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-[13px]">
            <thead>
              <tr className="bg-n950 text-white">
                {['Event', 'On', 'In-app', 'Email', 'Teams', 'WhatsApp', 'Threshold', 'Who gets it'].map((header) => (
                  <th key={header} className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.08em]">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule, index) => (
                <tr key={rule.id} className={cx('border-b border-line', index % 2 === 1 && 'bg-sunken', !rule.enabled && 'opacity-55')}>
                  <td className="px-3 py-2 font-semibold">{rule.label}</td>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={rule.enabled} disabled={!can('settings', 'update')} onChange={(e) => update.mutate({ id: rule.id, enabled: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={rule.inApp} disabled={!can('settings', 'update')} onChange={(e) => update.mutate({ id: rule.id, inApp: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
                  </td>
                  <td className="px-3 py-2">
                    <input type="checkbox" checked={rule.email} disabled={!can('settings', 'update')} onChange={(e) => update.mutate({ id: rule.id, email: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={rule.teams}
                      disabled={!can('settings', 'update') || noWebhook}
                      title={noWebhook ? 'Add a Teams webhook first' : undefined}
                      onChange={(e) => update.mutate({ id: rule.id, teams: e.target.checked })}
                      className="h-4 w-4 accent-[var(--red-500)]"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={rule.whatsapp}
                      disabled={!can('settings', 'update') || !whatsappReady}
                      title={whatsappReady
                        ? 'Sends to each recipient who has a WhatsApp number on their user record'
                        : 'Connect WhatsApp in Settings → Integrations first'}
                      onChange={(e) => update.mutate({ id: rule.id, whatsapp: e.target.checked })}
                      className="h-4 w-4 accent-[var(--red-500)]"
                    />
                  </td>
                  <td className="px-3 py-2">
                    {rule.thresholdDays === null ? (
                      <span className="text-n400">—</span>
                    ) : (
                      <Input
                        className="w-20 px-2 py-1"
                        type="number"
                        min="0"
                        defaultValue={rule.thresholdDays}
                        disabled={!can('settings', 'update')}
                        onBlur={(e) => {
                          const value = Number(e.target.value);
                          if (value !== rule.thresholdDays) update.mutate({ id: rule.id, thresholdDays: value });
                        }}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={rule.audience}
                      disabled={!can('settings', 'update')}
                      onChange={(e) => update.mutate({ id: rule.id, audience: e.target.value })}
                      className="rounded-sharp border border-line bg-card px-2 py-1 text-[12px]"
                    >
                      {['owner', 'manager', 'admins', 'all'].map((audience) => (
                        <option key={audience} value={audience}>{audience}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line bg-sunken px-4 py-2.5 text-[11px] text-muted">
          Stale-account and stuck-deal digests run at 08:30 Gulf time, Monday to Friday. Task reminders run every 15 minutes.
        </p>
      </Card>

      {addingHook ? <WebhookModal onClose={() => setAddingHook(false)} /> : null}

      <ConfirmDialog
        open={Boolean(deletingHook)}
        onClose={() => setDeletingHook(null)}
        onConfirm={() => removeHook.mutate(deletingHook!.id)}
        loading={removeHook.isPending}
        title="Remove this webhook?"
        confirmLabel="Remove"
        message="Rules pointing at it will stop posting to Teams."
      />
    </>
  );
}

function WebhookModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', url: '', isDefault: true });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.post('/teams-webhooks', form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification-rules'] });
      toast.push('Webhook added.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title="Add Teams webhook"
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!form.name || !form.url} loading={save.isPending} onClick={() => save.mutate()}>Add</Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}
        <Field label="Channel name" required hint="Just a label, e.g. Sales alerts">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        </Field>
        <Field label="Webhook URL" required>
          <Textarea rows={3} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…logic.azure.com/…" />
        </Field>
        <Checkbox label="Use as the default channel" checked={form.isDefault} onChange={(checked) => setForm({ ...form, isDefault: checked })} />
      </div>
    </Modal>
  );
}

// ── Microsoft 365 ─────────────────────────────────────────────────────────────

interface M365State {
  isConnected: boolean; status: string; lastError: string | null; connectedAt: string | null;
  config: { tenantId: string; clientId: string; senderUpn?: string; backupDriveUpn?: string; backupDriveId?: string; backupFolder?: string };
  hasSecret: boolean;
  setup: { redirectUri: string; consentRedirectUri: string; requiredApplicationPermissions: string[]; requiredDelegatedPermissions: string[] };
}

interface IntegrationHealth {
  provider: string; label: string; configured: boolean; ok: boolean; message: string; checkedAt: string;
}

/** One shared, polling query — react-query dedupes by key, so every consumer reuses it. */
function useIntegrationHealth(provider: string): IntegrationHealth | null {
  const { data } = useQuery({
    queryKey: ['integrations-health'],
    queryFn: () => api.get<IntegrationHealth[]>('/integrations/health'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return data?.find((h) => h.provider === provider) ?? null;
}

/** Live heartbeat pill for an integration header. */
function HealthBadge({ health }: { health: IntegrationHealth | null }) {
  if (!health) return null;
  const tone = !health.configured ? 'neutral' : health.ok ? 'secure' : 'accent';
  const text = !health.configured ? 'Not set up' : health.ok ? 'Healthy' : 'Error';
  return (
    <span className="flex items-center gap-2" title={health.message}>
      <Badge tone={tone}>{text}</Badge>
      {health.configured ? <span className="hidden text-[10px] text-muted sm:inline">checked {relative(health.checkedAt)}</span> : null}
    </span>
  );
}

/** Card whose body collapses under a clickable header — keeps the page short. */
function CollapsibleCard({
  title, subtitle, status, defaultOpen = false, className, children,
}: {
  title: ReactNode; subtitle?: ReactNode; status?: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cx('flex w-full items-start justify-between gap-4 px-4 py-3 text-left', open && 'border-b border-line')}
        aria-expanded={open}
      >
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold uppercase tracking-[0.1em]">{title}</h3>
          {subtitle ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{subtitle}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status}
          <ChevronDown size={16} className={cx('text-n400 transition-transform', open && 'rotate-180')} />
        </div>
      </button>
      {open ? children : null}
    </Card>
  );
}

function BackupsSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();

  const { data: backups } = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.get<{ runs: Array<{ id: string; status: string; filename: string | null; sizeBytes: number | null; error: string | null; startedAt: string }>; local: { count: number; bytes: number } }>('/backups'),
  });

  const backupNow = useMutation({
    mutationFn: () => api.post<{ filename: string; uploaded: boolean; error?: string }>('/backups/run', { uploadToOneDrive: true }),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
      toast.push(r.uploaded ? `${r.filename} uploaded to OneDrive.` : `${r.filename} saved locally. ${r.error ?? ''}`, r.uploaded ? 'success' : 'error');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Backup failed.', 'error'),
  });

  const validate = useMutation({
    mutationFn: () => api.post<{ ok: boolean; filename: string | null; tables: number; note: string }>('/backups/validate', {}),
    onSuccess: (r) => toast.push(r.ok ? `Valid — ${r.note}` : `Invalid: ${r.note}`, r.ok ? 'success' : 'error'),
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Validate failed.', 'error'),
  });

  const verify = useMutation({
    mutationFn: () => api.post<{ ok: boolean; filename: string | null; tables: number; note: string }>('/backups/verify', {}),
    onSuccess: (r) => toast.push(r.ok ? `Restorable — ${r.note}` : `Verify failed: ${r.note}`, r.ok ? 'success' : 'error'),
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Verify failed.', 'error'),
  });

  return (
    <>
      <Card>
        <CardHeader
          title="Backups"
          subtitle={`${backups?.local.count ?? 0} local copies (${fileSize(backups?.local.bytes ?? 0)}). Nightly pg_dump, gzipped, uploaded to the OneDrive folder set in Integrations.`}
          actions={
            <span className="flex flex-wrap gap-2">
              {can('backups', 'read') ? <Button size="sm" loading={validate.isPending} onClick={() => validate.mutate()}>Validate</Button> : null}
              {can('backups', 'delete') ? <Button size="sm" loading={verify.isPending} onClick={() => verify.mutate()}>Verify (restore)</Button> : null}
              {can('backups', 'update') ? <Button size="sm" variant="accent" loading={backupNow.isPending} onClick={() => backupNow.mutate()}>Back up now</Button> : null}
            </span>
          }
        />
        <div className="border-b border-line bg-sunken px-4 py-2 text-[11px] text-muted">
          <strong>Validate</strong> checks the file is a genuine gzip’d dump — no database touched.{' '}
          <strong>Verify (restore)</strong> restores it into a throwaway database to prove it is genuinely restorable, then drops it. Restore needs the privileged Backups permission.
        </div>
        {(backups?.runs ?? []).length === 0 ? (
          <EmptyState title="No backups yet" message="Run one now, or enable the nightly schedule below." />
        ) : (
          <DataTable
            dense
            rows={backups!.runs}
            rowKey={(row) => row.id}
            columns={[
              { key: 'startedAt', header: 'When', width: '180px', render: (row) => <span className="text-[12px]">{dateTime(row.startedAt)}</span> },
              { key: 'status', header: 'Status', width: '100px', render: (row) => <Badge tone={row.status === 'success' ? 'secure' : row.status === 'failed' ? 'accent' : 'neutral'}>{row.status}</Badge> },
              { key: 'filename', header: 'File', render: (row) => <span className="text-[12px]">{row.filename ?? '—'}</span> },
              { key: 'sizeBytes', header: 'Size', align: 'right', width: '90px', render: (row) => <span className="tabular text-[12px]">{row.sizeBytes ? fileSize(row.sizeBytes) : '—'}</span> },
              { key: 'error', header: 'Note', render: (row) => row.error ? <span className="text-[11px] text-accent">{row.error}</span> : null },
            ]}
          />
        )}
      </Card>

      {can('settings', 'update') ? (
        <div className="mt-3">
          <SettingsGroup prefix="backup." title="Backup schedule" description="Cron runs on Gulf time. Backups upload to the OneDrive folder set in Integrations." />
        </div>
      ) : null}
    </>
  );
}

function IntegrationsSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const health = useIntegrationHealth('microsoft365');
  const [testEmail, setTestEmail] = useState('');
  const [secret, setSecret] = useState('');
  const [form, setForm] = useState<M365State['config'] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['m365'],
    queryFn: () => api.get<M365State>('/integrations/microsoft365'),
  });

  useEffect(() => { if (data && !form) setForm(data.config); }, [data, form]);

  const save = useMutation({
    mutationFn: () => api.put<{ consentUrl: string | null }>('/integrations/microsoft365', { ...form, clientSecret: secret || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['m365'] });
      setSecret('');
      toast.push('Saved. Grant admin consent next.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not save.', 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; token: boolean; mailbox: { ok: boolean; message: string } | null; drive: { ok: boolean; message: string } | null; error?: string }>('/integrations/microsoft365/test', {}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['m365'] });
      toast.push(result.ok ? 'Connection healthy.' : result.error ?? result.mailbox?.message ?? 'Connection test failed.', result.ok ? 'success' : 'error');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Test failed.', 'error'),
  });

  const sendTest = useMutation({
    mutationFn: () => api.post('/integrations/microsoft365/test-email', { to: testEmail }),
    onSuccess: () => toast.push(`Test email sent to ${testEmail}.`),
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Send failed.', 'error'),
  });

  const consent = async () => {
    try {
      const { url } = await api.get<{ url: string }>('/integrations/microsoft365/consent-url');
      window.location.href = url;
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Save the tenant and client ID first.', 'error');
    }
  };

  if (isLoading || !data || !form) return <Loading />;

  const editable = can('integrations', 'update');

  return (
    <>
      <CollapsibleCard
        title="Microsoft 365"
        subtitle="One app registration powers sign-in, Outlook email, Teams cards and OneDrive backup."
        status={<HealthBadge health={health} />}
        defaultOpen={!health?.configured || !health?.ok}
      >
        <div className="border-b border-line bg-sunken px-4 py-3">
          <p className="eyebrow mb-1.5">Before you start — in the Entra admin centre</p>
          <ol className="list-decimal space-y-1 pl-4 text-[12px] leading-relaxed text-n600">
            <li>App registrations → New registration → name it <strong>Zeus CRM</strong>, single tenant.</li>
            <li>Authentication → Add a Web platform with redirect URI <code className="bg-card px-1">{data.setup.redirectUri}</code> and <code className="bg-card px-1">{data.setup.consentRedirectUri}</code>.</li>
            <li>Certificates &amp; secrets → New client secret → copy the <em>value</em>.</li>
            <li>API permissions → Microsoft Graph → Application permissions → add <strong>{data.setup.requiredApplicationPermissions.join(', ')}</strong>.</li>
            <li>Paste the three IDs below, save, then press <strong>Grant admin consent</strong>.</li>
          </ol>
        </div>

        <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
          <Field label="Directory (tenant) ID" required>
            <Input value={form.tenantId} disabled={!editable} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" />
          </Field>
          <Field label="Application (client) ID" required>
            <Input value={form.clientId} disabled={!editable} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
          </Field>
          <Field label="Client secret" hint={data.hasSecret ? 'A secret is stored. Type a new one to replace it.' : 'Required — stored encrypted.'} className="sm:col-span-2">
            <Input type="password" value={secret} disabled={!editable} onChange={(e) => setSecret(e.target.value)} placeholder={data.hasSecret ? '•••••••••••• (stored)' : ''} autoComplete="off" />
          </Field>
          <Field label="Sending mailbox" hint="Shared mailbox Zeus sends quotes and alerts from.">
            <Input value={form.senderUpn ?? ''} disabled={!editable} onChange={(e) => setForm({ ...form, senderUpn: e.target.value })} placeholder="crm@protect24x7.ae" />
          </Field>
          <Field label="Backup OneDrive account" hint="Whose OneDrive receives the nightly database backup.">
            <Input value={form.backupDriveUpn ?? ''} disabled={!editable} onChange={(e) => setForm({ ...form, backupDriveUpn: e.target.value })} placeholder="it@protect24x7.ae" />
          </Field>
          <Field label="Backup folder" hint="Created automatically if it does not exist.">
            <Input value={form.backupFolder ?? ''} disabled={!editable} onChange={(e) => setForm({ ...form, backupFolder: e.target.value })} placeholder="Zeus CRM Backups" />
          </Field>
          <Field label="SharePoint drive ID" hint="Optional — use instead of a personal OneDrive.">
            <Input value={form.backupDriveId ?? ''} disabled={!editable} onChange={(e) => setForm({ ...form, backupDriveId: e.target.value })} />
          </Field>
        </div>

        {data.lastError ? <div className="px-4 pb-3"><ErrorNote error={data.lastError} /></div> : null}

        {editable ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line bg-sunken px-4 py-3">
            <Button variant="accent" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            <Button icon={<Check size={13} />} onClick={consent}>Grant admin consent</Button>
            <Button loading={test.isPending} onClick={() => test.mutate()}>Test connection</Button>
            <span className="ml-auto flex items-center gap-2">
              <Input className="w-56" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@protect24x7.ae" />
              <Button size="sm" disabled={!testEmail} loading={sendTest.isPending} onClick={() => sendTest.mutate()}>Send test email</Button>
            </span>
          </div>
        ) : null}
      </CollapsibleCard>

      <div className="mt-3">
        <WhatsappPanel />
      </div>

      <div className="mt-3">
        <SettingsGroup prefix="auth." title="Sign-in" description="Control which sign-in methods are accepted." />
      </div>

      <div className="mt-3">
        <WebhooksPanel />
      </div>
    </>
  );
}

interface WebhookRow {
  id: string; name: string; url: string; events: string[]; isActive: boolean;
  failureCount: number; disabledAt: string | null; lastError: string | null;
  deliveries: Array<{ id: string; event: string; ok: boolean; responseCode: number | null; error: string | null; durationMs: number | null; createdAt: string }>;
}

/**
 * Outbound webhooks.
 *
 * The secret is shown once, at creation, because that is the only moment Zeus has it in
 * the clear — after that it is encrypted and there is nothing to display.
 */
function WebhooksPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const health = useIntegrationHealth('webhooks');
  const editable = can('integrations', 'update');

  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: hooks } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.get<WebhookRow[]>('/webhooks'),
  });

  const { data: catalogue } = useQuery({
    queryKey: ['notification-events'],
    queryFn: () => api.get<{ events: Array<{ event: string; label: string }> }>('/notification-rules'),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['webhooks'] });
  const reset = () => { setAdding(false); setName(''); setUrl(''); setEvents([]); setError(null); };

  const create = useMutation({
    mutationFn: () => api.post<{ secret: string }>('/webhooks', { name, url, events }),
    onSuccess: (created) => { setNewSecret(created.secret); reset(); void refresh(); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save it.'),
  });

  const toggle = useMutation({
    mutationFn: (hook: WebhookRow) => api.patch(`/webhooks/${hook.id}`, { isActive: !hook.isActive || Boolean(hook.disabledAt) }),
    onSuccess: () => void refresh(),
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not change it.', 'error'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/webhooks/${id}`),
    onSuccess: () => { void refresh(); toast.push('Webhook removed.'); },
  });

  const test = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; responseCode: number | null; error: string | null }>(`/webhooks/${id}/test`, {}),
    onSuccess: (result) => {
      void refresh();
      toast.push(
        result.ok ? `The endpoint answered ${result.responseCode}.` : result.error ?? 'The call did not get through.',
        result.ok ? 'success' : 'error',
      );
    },
  });

  return (
    <Card>
      <CardHeader
        title="Outbound webhooks"
        subtitle="Tell another system when something happens here. Signed, so the receiver can prove it came from Zeus."
        actions={
          <span className="flex items-center gap-2">
            <HealthBadge health={health} />
            {editable && !adding ? <Button size="sm" icon={<Plus size={13} />} onClick={() => setAdding(true)}>Add webhook</Button> : null}
          </span>
        }
      />

      {newSecret ? (
        <div className="border-b border-line bg-sunken px-4 py-3">
          <p className="text-[12px] font-semibold text-accent">Signing secret — copy it now</p>
          <p className="mt-1 text-[12px] text-n600">
            The receiving end needs this to check the signature. It is encrypted from here on,
            so this is the only time Zeus can show it.
          </p>
          <Input readOnly value={newSecret} className="mt-2 font-mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
          <Button size="sm" className="mt-2" onClick={() => setNewSecret(null)}>Done</Button>
        </div>
      ) : null}

      {adding ? (
        <div className="space-y-3 border-b border-line px-4 py-4">
          {error ? <ErrorNote error={error} /> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ops channel" /></Field>
            <Field label="URL" hint="https only, and not an address inside your own network.">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/zeus" />
            </Field>
          </div>
          <div>
            <span className="eyebrow">Events</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(catalogue?.events ?? []).map((e) => (
                <button
                  key={e.event}
                  type="button"
                  onClick={() => setEvents((current) => current.includes(e.event) ? current.filter((x) => x !== e.event) : [...current, e.event])}
                  className={cx(
                    'rounded-sharp border px-2 py-1 text-[11px] transition-colors',
                    events.includes(e.event) ? 'border-n950 bg-n950 text-white' : 'border-line bg-card text-muted hover:border-n900 hover:text-ink',
                  )}
                >
                  {e.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={reset}>Cancel</Button>
            <Button variant="accent" size="sm" disabled={!name || !url || events.length === 0} loading={create.isPending} onClick={() => create.mutate()}>
              Add webhook
            </Button>
          </div>
        </div>
      ) : null}

      {(hooks ?? []).length === 0 && !adding ? (
        <EmptyState title="No webhooks" message="Nothing outside Zeus is being told when things happen." icon={<Plug size={22} />} />
      ) : null}

      {(hooks ?? []).map((hook) => (
        <div key={hook.id} className="border-b border-line px-4 py-3 last:border-b-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="flex items-center gap-2">
                <span className="text-[13px] font-semibold">{hook.name}</span>
                {hook.disabledAt ? <Badge tone="accent">Switched off</Badge>
                  : hook.isActive ? <Badge tone="secure">On</Badge>
                  : <Badge>Paused</Badge>}
              </span>
              <span className="block truncate font-mono text-[11px] text-muted">{hook.url}</span>
              <span className="block text-[11px] text-muted">{hook.events.length} event{hook.events.length === 1 ? '' : 's'}</span>
              {hook.lastError ? <span className="block text-[11px] text-accent">{hook.lastError}</span> : null}
            </div>
            {editable ? (
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="ghost" loading={test.isPending} onClick={() => test.mutate(hook.id)}>Send test</Button>
                <Button size="sm" variant="ghost" onClick={() => toggle.mutate(hook)}>
                  {hook.disabledAt || !hook.isActive ? 'Turn on' : 'Pause'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setExpanded(expanded === hook.id ? null : hook.id)}>
                  {expanded === hook.id ? 'Hide log' : 'Log'}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(hook.id)}><Trash2 size={13} /></Button>
              </div>
            ) : null}
          </div>

          {expanded === hook.id ? (
            <div className="mt-2 border-t border-line pt-2">
              {hook.deliveries.length === 0 ? (
                <p className="text-[11px] text-muted">Nothing sent yet.</p>
              ) : (
                <ul className="space-y-1">
                  {hook.deliveries.map((d) => (
                    <li key={d.id} className="flex items-baseline justify-between gap-3 text-[11px]">
                      <span className="truncate">
                        <span className={cx('font-semibold', d.ok ? 'text-secure' : 'text-accent')}>{d.ok ? 'sent' : 'failed'}</span>
                        {' · '}{d.event}{d.error ? ` · ${d.error}` : ''}
                      </span>
                      <span className="shrink-0 tabular text-muted">
                        {d.responseCode ?? '—'}{d.durationMs !== null ? ` · ${d.durationMs}ms` : ''} · {relative(d.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ))}
    </Card>
  );
}

interface WhatsappState {
  isConnected: boolean;
  status: string;
  lastError: string | null;
  hasToken: boolean;
  recipients: number;
  config: { phoneNumberId: string; templateName: string; languageCode: string; isTestNumber: boolean };
  setup: { freeTierRecipientLimit: number; templateBodyExample: string; notes: string[] };
}

/**
 * WhatsApp is the one channel with a bill attached, so the panel leads with the cost
 * rather than burying it — a production number meters every alert, a test number does
 * not but only reaches numbers verified in Meta.
 */
function WhatsappPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useAuth();
  const health = useIntegrationHealth('whatsapp');
  const [token, setToken] = useState('');
  const [testTo, setTestTo] = useState('');
  const [form, setForm] = useState<WhatsappState['config'] | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['integration-whatsapp'],
    queryFn: () => api.get<WhatsappState>('/integrations/whatsapp'),
  });

  const config = form ?? data?.config ?? null;
  const set = (patch: Partial<WhatsappState['config']>) => config && setForm({ ...config, ...patch });

  const save = useMutation({
    mutationFn: () => api.put('/integrations/whatsapp', { ...config, accessToken: token || undefined }),
    onSuccess: () => {
      setToken('');
      void queryClient.invalidateQueries({ queryKey: ['integration-whatsapp'] });
      toast.push('WhatsApp settings saved.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not save.', 'error'),
  });

  const test = useMutation({
    mutationFn: () => api.post('/integrations/whatsapp/test', { to: testTo }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['integration-whatsapp'] });
      toast.push('Test message sent — check the handset.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Test failed.', 'error'),
  });

  if (isLoading || !data || !config) return <Card><Loading /></Card>;

  return (
    <CollapsibleCard
      title="WhatsApp alerts"
      subtitle="Meta Cloud API. Sends the same events as Teams and email, to a handset."
      status={<HealthBadge health={health} />}
      defaultOpen={!health?.configured || !health?.ok}
    >
      <div className="border-b border-line bg-sunken px-4 py-3">
        <p className="eyebrow mb-1.5">What this costs</p>
        <ul className="space-y-1 pl-4 text-[12px] leading-relaxed text-n600" style={{ listStyleType: 'disc' }}>
          {data.setup.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      </div>

      <div className="grid gap-3 px-4 py-4 sm:grid-cols-2">
        <Field label="Phone number ID" required hint="Meta → WhatsApp → API setup. A long number, not the phone number.">
          <Input value={config.phoneNumberId} onChange={(e) => set({ phoneNumberId: e.target.value })} placeholder="123456789012345" />
        </Field>
        <Field label="Access token" hint={data.hasToken ? 'Stored and encrypted. Leave blank to keep it.' : 'Permanent token from a Meta system user, or the temporary one for testing.'}>
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={data.hasToken ? '••••••••' : 'EAAG…'} />
        </Field>
        <Field label="Template name" required hint={`Approved template with one body parameter, e.g. "${data.setup.templateBodyExample}".`}>
          <Input value={config.templateName} onChange={(e) => set({ templateName: e.target.value })} placeholder="zeus_alert" />
        </Field>
        <Field label="Template language" required hint="Exactly as Meta lists it — en and en_US are different templates.">
          <Input value={config.languageCode} onChange={(e) => set({ languageCode: e.target.value })} placeholder="en" />
        </Field>
        <div className="sm:col-span-2">
          <Checkbox
            label={`This is a Meta test number — free, but only reaches the ${data.setup.freeTierRecipientLimit} numbers verified in Meta`}
            checked={config.isTestNumber}
            onChange={(v) => set({ isTestNumber: v })}
          />
        </div>
      </div>

      {data.lastError ? (
        <div className="border-t border-line bg-accent-soft px-4 py-2.5 text-[12px] text-[var(--red-700)]">
          Last error from Meta: {data.lastError}
        </div>
      ) : null}

      <div className="flex flex-wrap items-end gap-3 border-t border-line px-4 py-3">
        <Field label="Send a test to" className="max-w-[220px] flex-1">
          <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="+971 50 123 4567" />
        </Field>
        <Button
          disabled={!can('integrations', 'update') || !testTo.trim() || !data.hasToken}
          loading={test.isPending}
          onClick={() => test.mutate()}
        >
          Test
        </Button>
        <span className="text-[11px] text-muted">
          {data.recipients} user{data.recipients === 1 ? '' : 's'} have a WhatsApp number on file.
          {config.isTestNumber && data.recipients > data.setup.freeTierRecipientLimit
            ? ` A test number only delivers to ${data.setup.freeTierRecipientLimit} of them.`
            : ''}
        </span>
        {can('integrations', 'update') ? (
          <Button variant="accent" className="ml-auto" loading={save.isPending} disabled={!config.phoneNumberId.trim()} onClick={() => save.mutate()}>
            Save
          </Button>
        ) : null}
      </div>
    </CollapsibleCard>
  );
}

// ── audit ─────────────────────────────────────────────────────────────────────

function AuditSection() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['audit', page, entity, action],
    queryFn: () =>
      api.get<{ data: Array<{ id: string; action: string; entity: string; entityId: string | null; summary: string | null; changes: Record<string, { from: unknown; to: unknown }> | null; ip: string | null; at: string; user: { name: string; avatarColor: string } | null }>; total: number; totalPages: number }>(
        `/audit${qs({ page, entity, action, pageSize: 40 })}`,
      ),
  });

  return (
    <div className="flex flex-col gap-3">
    {can('settings', 'update') ? (
      <SettingsGroup prefix="audit." title="Read logging" description="Off by default. When on, opening a deal, account, contact, lead, quote or invoice is recorded as a 'read' entry below — useful for compliance, but high volume." />
    ) : null}
    <Card>
      <CardHeader title="Audit trail" subtitle="Every create, update, delete, export, sign-in and integration change." />
      <Toolbar>
        <Select
          value={entity}
          onChange={(e) => { setEntity(e.target.value); setPage(1); }}
          placeholder="All records"
          options={['Deal', 'Account', 'Contact', 'Lead', 'Quote', 'Invoice', 'Product', 'User', 'Role', 'Setting', 'Integration', 'Report'].map((v) => ({ value: v, label: v }))}
          className="w-[160px]"
        />
        <Select
          value={action}
          onChange={(e) => { setAction(e.target.value); setPage(1); }}
          placeholder="All actions"
          options={['read', 'create', 'update', 'delete', 'merge', 'convert', 'export', 'import', 'send', 'login', 'login_failed', 'integration', 'backup'].map((v) => ({ value: v, label: v }))}
          className="w-[150px]"
        />
      </Toolbar>

      {isLoading ? (
        <Loading />
      ) : (
        <>
          <ol className="max-h-[560px] overflow-y-auto">
            {(data?.data ?? []).map((entry) => (
              <li key={entry.id} className="flex gap-3 border-b border-line px-4 py-2.5">
                <Avatar name={entry.user?.name ?? 'System'} color={entry.user?.avatarColor} size={24} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px]">
                    <strong>{entry.user?.name ?? 'System'}</strong>{' '}
                    <span className="text-muted">{entry.action}</span>{' '}
                    <Badge tone="neutral">{entry.entity}</Badge>{' '}
                    {entry.summary ? <span>{entry.summary}</span> : null}
                  </p>
                  {entry.changes ? (
                    <p className="mt-0.5 text-[11px] text-muted">
                      {Object.entries(entry.changes).slice(0, 4).map(([field, change]) => (
                        <span key={field} className="mr-3">
                          {field}: <s>{String(change.from ?? '—')}</s> → <strong>{String(change.to ?? '—')}</strong>
                        </span>
                      ))}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-n400">{dateTime(entry.at)}{entry.ip ? ` · ${entry.ip}` : ''}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between border-t border-line px-3 py-2">
            <span className="text-xs text-muted">{data?.total ?? 0} entries</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" variant="ghost" disabled={page >= (data?.totalPages ?? 1)} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </Card>
    </div>
  );
}

// ── system status ───────────────────────────────────────────────────────────────

interface SystemStatus {
  ok: boolean;
  time: string;
  process: { uptimeSeconds: number; startedAt: string; node: string; pid: number; rssMb: number; heapUsedMb: number };
  components: Array<{ key: string; label: string; ok: boolean; detail: string; latencyMs?: number; uptime: { day: number; week: number } | null }>;
  resources: {
    current: { cpuPct: number; memPct: number; diskPct: number; totalMemMb: number };
    history: Array<{ at: string; cpuPct: number; memPct: number; diskPct: number }>;
  };
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

function StatusSection() {
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['system-status'],
    queryFn: () => api.get<SystemStatus>('/system/status'),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  if (isLoading || !data) return <Card><Loading /></Card>;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="System status"
          subtitle={`Live component health · refreshed ${relative(new Date(dataUpdatedAt).toISOString())}`}
          actions={<Badge tone={data.ok ? 'secure' : 'accent'}>{data.ok ? 'All systems operational' : 'Degraded'}</Badge>}
        />
        <ul>
          {data.components.map((c) => (
            <li key={c.key} className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0">
              <span className={cx('h-2.5 w-2.5 shrink-0 rounded-full', c.ok ? 'bg-[#22a559]' : 'bg-[var(--red-500,#e11d2e)]')} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold">{c.label}</p>
                <p className="truncate text-[11px] text-muted">{c.detail}</p>
              </div>
              {c.uptime ? <span className="hidden tabular text-[11px] text-muted sm:inline" title="Uptime — last 24h / 7d">{c.uptime.day}% · {c.uptime.week}%</span> : null}
              {typeof c.latencyMs === 'number' ? <span className="tabular text-[11px] text-n400">{c.latencyMs} ms</span> : null}
              <Badge tone={c.ok ? 'secure' : 'accent'}>{c.ok ? 'Up' : 'Down'}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader title="Compute utilisation" subtitle="CPU, memory and disk on the server — sampled every 5 minutes." />
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-3">
          {([
            { label: 'CPU', pct: data.resources.current.cpuPct },
            { label: 'RAM', pct: data.resources.current.memPct, sub: `of ${(data.resources.current.totalMemMb / 1024).toFixed(1)} GB` },
            { label: 'Disk', pct: data.resources.current.diskPct },
          ] as Array<{ label: string; pct: number; sub?: string }>).map(({ label, pct, sub }) => (
            <div key={label}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="eyebrow">{label}</span>
                <span className="tabular text-[13px] font-semibold">{pct}%</span>
              </div>
              <ProgressBar value={pct} tone={pct >= 90 ? 'accent' : pct >= 75 ? 'watch' : 'secure'} />
              {sub ? <p className="mt-1 text-[10px] text-muted">{sub}</p> : null}
            </div>
          ))}
        </div>
        <div className="border-t border-line px-2 py-3">
          <UtilizationChart data={data.resources.history} />
        </div>
      </Card>

      <Card>
        <CardHeader title="Runtime" subtitle="The API process serving this app." />
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-4">
          {[
            ['Uptime', uptime(data.process.uptimeSeconds)],
            ['Node', data.process.node],
            ['Memory (RSS)', `${data.process.rssMb} MB`],
            ['Heap used', `${data.process.heapUsedMb} MB`],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="eyebrow mb-0.5">{k}</dt>
              <dd className="tabular text-[13px] font-semibold">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

// ── system log ──────────────────────────────────────────────────────────────────

const LOG_TONE: Record<string, 'accent' | 'watch' | 'neutral'> = { error: 'accent', warn: 'watch', info: 'neutral' };

function SystemLogSection() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [level, setLevel] = useState('');
  const [source, setSource] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['system-logs', page, level, source],
    queryFn: () => api.get<{ data: Array<{ id: string; level: string; source: string; message: string; context: unknown; at: string }>; total: number; totalPages: number }>(
      `/system/logs${qs({ page, level, source, pageSize: 50 })}`,
    ),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col gap-3">
    <Card>
      <CardHeader
        title="System log"
        subtitle="Technical events — errors, failed jobs, backup and integration trouble. Kept 30 days."
        actions={
          <Button size="sm" disabled={!data?.data.length} onClick={() => download(`/system/logs/export${qs({ level, source })}`, 'zeus-system-log.xlsx')}>
            Export
          </Button>
        }
      />
      <Toolbar>
        <Select value={level} onChange={(e) => { setLevel(e.target.value); setPage(1); }} placeholder="All levels"
          options={['info', 'warn', 'error'].map((v) => ({ value: v, label: v }))} className="w-[140px]" />
        <Select value={source} onChange={(e) => { setSource(e.target.value); setPage(1); }} placeholder="All sources"
          options={['http', 'backup', 'cron', 'integration', 'auth', 'app'].map((v) => ({ value: v, label: v }))} className="w-[150px]" />
      </Toolbar>

      {isLoading ? (
        <Loading />
      ) : (data?.data ?? []).length === 0 ? (
        <EmptyState title="Nothing logged" message="No system events match. A quiet log is a healthy sign." />
      ) : (
        <>
          <ol className="max-h-[560px] overflow-y-auto">
            {(data?.data ?? []).map((e) => (
              <li key={e.id} className="flex items-start gap-3 border-b border-line px-4 py-2.5">
                <Badge tone={LOG_TONE[e.level] ?? 'neutral'}>{e.level}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[13px]"><span className="text-muted">[{e.source}]</span> {e.message}</p>
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-n400">{dateTime(e.at)}</p>
                </div>
                <CopyButton value={`[${e.source}] ${e.message}`} label="" className="mt-0.5 shrink-0" />
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between border-t border-line px-3 py-2">
            <span className="text-xs text-muted">{data?.total ?? 0} entries</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" variant="ghost" disabled={page >= (data?.totalPages ?? 1)} onClick={() => setPage(page + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </Card>

    {can('settings', 'update') ? (
      <SettingsGroup
        prefix="syslog."
        title="Forward to SIEM"
        description="Stream every system-log event to a syslog server (RFC5424 over UDP or TCP) for central monitoring. Protocol accepts udp or tcp."
      />
    ) : null}
    </div>
  );
}

// ── my account ────────────────────────────────────────────────────────────────

function ProfileSection() {
  const { user } = useAuth();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: () => { setCurrent(''); setNext(''); setError(null); toast.push('Password changed.'); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not change the password.'),
  });

  return (
    <Card>
      <CardHeader title="My account" subtitle={user?.email} />
      <div className="px-4 py-4">
        <div className="mb-5 flex items-center gap-3">
          <Avatar name={user?.name ?? '?'} color={user?.avatarColor} size={44} />
          <div>
            <p className="text-[15px] font-semibold">{user?.name}</p>
            <p className="text-[12px] text-muted">{user?.role.name}{user?.team ? ` · ${user.team.name}` : ''}</p>
          </div>
        </div>

        <div className="max-w-sm space-y-3 border-t border-line pt-4">
          <span className="eyebrow">Change password</span>
          {error ? <ErrorNote error={error} /> : null}
          <Field label="Current password">
            <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          </Field>
          <Button variant="accent" disabled={!current || next.length < 10} loading={change.isPending} onClick={() => change.mutate()}>
            Change password
          </Button>
          <p className="text-[11px] text-muted">If you sign in with Microsoft, your password is managed by Microsoft, not here.</p>
        </div>

        <TwoFactorPanel />
      </div>
    </Card>
  );
}

/**
 * Two-factor sign-in for this account.
 *
 * The recovery codes are shown once and never again, so the screen has to be blunt about
 * that: the realistic failure here is not an attacker, it is the owner replacing a phone
 * and finding nobody can get into the CRM.
 */
function TwoFactorPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [enrolment, setEnrolment] = useState<{ secret: string; otpauth: string; recoveryCodes: string[] } | null>(null);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: state } = useQuery({
    queryKey: ['two-factor'],
    queryFn: () => api.get<{ enabled: boolean; recoveryCodesLeft: number }>('/auth/2fa'),
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['two-factor'] });

  const start = useMutation({
    mutationFn: () => api.post<{ secret: string; otpauth: string; recoveryCodes: string[] }>('/auth/2fa/enrol', {}),
    onSuccess: (data) => { setEnrolment(data); setSaved(false); setError(null); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not start enrolment.'),
  });

  const confirm = useMutation({
    mutationFn: () => api.post('/auth/2fa/confirm', { code: code.trim() }),
    onSuccess: () => { setEnrolment(null); setCode(''); setError(null); void refresh(); toast.push('Two-factor sign-in is on.'); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'That code did not match.'),
  });

  const turnOff = useMutation({
    mutationFn: () => api.post('/auth/2fa/disable', { password }),
    onSuccess: () => { setPassword(''); setError(null); void refresh(); toast.push('Two-factor sign-in is off.'); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not turn it off.'),
  });

  return (
    <div className="mt-6 max-w-lg space-y-3 border-t border-line pt-4">
      <span className="eyebrow">Two-factor sign-in</span>
      {error ? <ErrorNote error={error} /> : null}

      {state?.enabled && !enrolment ? (
        <>
          <p className="text-[13px] text-n600">
            On. Signing in asks for a code after your password.
            {' '}
            <b>{state.recoveryCodesLeft}</b> recovery {state.recoveryCodesLeft === 1 ? 'code' : 'codes'} left.
          </p>
          {state.recoveryCodesLeft <= 2 ? (
            <p className="text-[12px] text-accent">
              Almost out of recovery codes. Turn two-factor off and on again to get a fresh set.
            </p>
          ) : null}
          <Field label="Password" hint="Confirms it is you, not just an open session.">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
          <Button disabled={!password} loading={turnOff.isPending} onClick={() => turnOff.mutate()}>
            Turn two-factor off
          </Button>
        </>
      ) : null}

      {!state?.enabled && !enrolment ? (
        <>
          <p className="text-[13px] text-n600">
            Off. A password on its own is all anyone needs to get in.
          </p>
          <Button variant="accent" loading={start.isPending} onClick={() => start.mutate()}>
            Set up two-factor
          </Button>
        </>
      ) : null}

      {enrolment ? (
        <div className="space-y-3">
          <p className="text-[13px] text-n600">
            Add this to your authenticator app, then enter the code it shows to switch it on.
          </p>

          <Field label="Setup key" hint="Type this into the app, or paste the link below into a QR generator.">
            <Input readOnly value={enrolment.secret} className="font-mono" onFocus={(e) => e.currentTarget.select()} />
          </Field>
          <Input readOnly value={enrolment.otpauth} className="font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />

          <div className="border border-accent bg-sunken px-3 py-3">
            <p className="text-[12px] font-semibold text-accent">Save these recovery codes now</p>
            <p className="mt-1 text-[12px] text-n600">
              This is the only time they are shown. Each works once, and they are the only way
              back in if you lose the authenticator — without them, nobody can reach this
              account and only database access will recover it.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-[13px]">
              {enrolment.recoveryCodes.map((c) => <span key={c}>{c}</span>)}
            </div>
            <div className="mt-3">
              <Checkbox label="I have saved these somewhere safe" checked={saved} onChange={setSaved} />
            </div>
          </div>

          <Field label="Code from the app">
            <Input value={code} inputMode="numeric" placeholder="123456" onChange={(e) => setCode(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { setEnrolment(null); setCode(''); setError(null); }}>Cancel</Button>
            <Button variant="accent" disabled={!saved || code.trim().length < 6} loading={confirm.isPending} onClick={() => confirm.mutate()}>
              Turn two-factor on
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
