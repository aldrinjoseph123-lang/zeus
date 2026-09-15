import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileSpreadsheet, FileUp, Play, Undo2, Upload } from 'lucide-react';
import { api, ApiError, download } from '../lib/api';
import { dateTime } from '../lib/format';
import {
  Badge, Button, Card, CardHeader, ConfirmDialog, DataTable, EmptyState, ErrorNote, Field, Input, Modal, PageHeader, Select, cx, useToast,
} from '../components/ui';
import { AccountPicker, OwnerSelect } from '../components/pickers';
import { useAuth } from '../lib/auth';

interface FieldDef { key: string; label: string; required?: boolean; type?: string }
interface ImportJobRow {
  id: string; module: string; filename: string; status: string; totalRows: number; imported: number; updated: number; skipped: number;
  createdAt: string; createdBy: { name: string } | null;
  /** A committed import inside the undo window that kept a record of what it wrote. */
  undoable: boolean;
}
interface UndoResult { removed: number; restored: number; kept: Array<{ label: string; reason: string }> }
interface UploadResult {
  jobId: string; module: string; filename: string; headers: string[]; totalRows: number;
  sample: Array<Record<string, string>>; fields: FieldDef[]; suggestedMapping: Record<string, string>;
}
interface RunResult {
  dryRun: boolean; totalRows: number; wouldCreate: number; wouldUpdate: number; skipped: number;
  errors: Array<{ row: number; message: string }>;
  preview: Array<{ row: number; action: string; label: string; note?: string }>;
}

type AccountKind = 'CUSTOMER' | 'PARTNER' | 'VENDOR' | 'PROSPECT';

interface AccountReference {
  key: string;
  name: string | null;
  label: string;
  rows: number[];
  examples: string[];
  status: 'found' | 'new' | 'blank';
  found: { id: string; name: string; type: string } | null;
  suggestions: Array<{ id: string; name: string; type: string; reason: string }>;
  suggestedName: string | null;
  domain: string | null;
  type: AccountKind;
}

/** A person's answer for one account, before it is turned into what the server takes. */
interface Choice {
  /** `link:<id>` for a suggestion, or create / other / skip; '' until chosen. */
  pick: string;
  name: string;
  type: AccountKind;
  otherId: string | null;
  otherName: string | null;
}

const KINDS: Array<{ value: AccountKind; label: string }> = [
  { value: 'CUSTOMER', label: 'Customer' },
  { value: 'PARTNER', label: 'Partner' },
  { value: 'PROSPECT', label: 'Prospect' },
  { value: 'VENDOR', label: 'Vendor' },
];

/** The imports whose rows point at an account, and so are screened before they run. */
const SCREENED = new Set(['contacts', 'deals', 'products', 'priceBook']);

/**
 * A starting answer, so the common case is one click: the best suggestion if there is one, a new
 * account under the file's own name if not. A blank row with nothing to suggest starts unanswered
 * — someone has to decide who that contact belongs to.
 */
function initialChoice(ref: AccountReference): Choice {
  const base = { name: ref.name ?? ref.suggestedName ?? '', type: ref.type, otherId: null, otherName: null };
  if (ref.suggestions[0]) return { ...base, pick: `link:${ref.suggestions[0].id}` };
  if (ref.name || ref.suggestedName) return { ...base, pick: 'create' };
  return { ...base, pick: '' };
}

function decisionOf(choice: Choice) {
  if (choice.pick.startsWith('link:')) return { action: 'link' as const, accountId: choice.pick.slice(5) };
  if (choice.pick === 'other' && choice.otherId) return { action: 'link' as const, accountId: choice.otherId };
  if (choice.pick === 'create' && choice.name.trim()) return { action: 'create' as const, name: choice.name.trim(), type: choice.type };
  if (choice.pick === 'skip') return { action: 'skip' as const };
  return null;
}

const MODULES = [
  { value: 'leads', label: 'Leads' },
  { value: 'accounts', label: 'Accounts' },
  { value: 'contacts', label: 'Contacts' },
  { value: 'products', label: 'Catalog items' },
  { value: 'deals', label: 'Deals' },
  { value: 'priceBook', label: 'Vendor price list' },
];

export default function Imports() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [module, setModule] = useState('leads');
  const [upload, setUpload] = useState<UploadResult | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [onDuplicate, setOnDuplicate] = useState<'skip' | 'update' | 'create'>('skip');
  const [ownerId, setOwnerId] = useState('');
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [references, setReferences] = useState<AccountReference[] | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  const { data: templateFields } = useQuery({
    queryKey: ['import-fields', module],
    queryFn: () => api.get<FieldDef[]>(`/imports/fields/${module}`),
    staleTime: 300_000,
  });

  const getTemplate = (format: 'xlsx' | 'csv') =>
    download(`/imports/template/${module}?format=${format}`, `zeus-${module}-template.${format}`)
      .catch((err) => toast.push(err instanceof Error ? err.message : 'Could not build the template.', 'error'));

  const { data: history } = useQuery({
    queryKey: ['import-jobs'],
    queryFn: () => api.get<ImportJobRow[]>('/imports'),
  });

  const { can } = useAuth();
  const [undoing, setUndoing] = useState<ImportJobRow | null>(null);
  const [undone, setUndone] = useState<{ job: ImportJobRow; result: UndoResult } | null>(null);
  const undo = useMutation({
    mutationFn: (job: ImportJobRow) => api.post<UndoResult>(`/imports/${job.id}/undo`, {}),
    onSuccess: (result, job) => {
      setUndoing(null);
      setUndone({ job, result });
      void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
      void queryClient.invalidateQueries({ queryKey: [job.module] });
    },
    onError: (err) => { setUndoing(null); toast.push(err instanceof Error ? err.message : 'Could not undo the import.', 'error'); },
  });

  const pickFile = async (file: File) => {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      const body = new FormData();
      body.append('module', module);
      body.append('file', file);
      const res = await fetch('/api/imports/upload', { method: 'POST', credentials: 'include', body });
      const json = await res.json();
      if (!res.ok) throw new ApiError(res.status, json.error ?? 'Upload failed.');
      setUpload(json as UploadResult);
      setMapping((json as UploadResult).suggestedMapping);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const toSettle = (references ?? []).filter((r) => r.status !== 'found');
  const decisions = Object.fromEntries(toSettle.flatMap((r) => {
    const d = choices[r.key] ? decisionOf(choices[r.key]) : null;
    return d ? [[r.key, d]] : [];
  }));
  const allSettled = toSettle.every((r) => decisions[r.key]);

  /** Ask which accounts the file names; if Zeus has every one already, go straight to the preview. */
  const screen = useMutation({
    mutationFn: () => api.post<{ references: AccountReference[] }>(`/imports/${upload!.jobId}/accounts`, { mapping }),
    onSuccess: ({ references: refs }) => {
      setReferences(refs);
      setChoices(Object.fromEntries(refs.filter((r) => r.status !== 'found').map((r) => [r.key, initialChoice(r)])));
      setResult(null);
      setError(null);
      if (refs.every((r) => r.status === 'found')) run.mutate(true);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not check the accounts.'),
  });

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post<RunResult>(`/imports/${upload!.jobId}/run`, { mapping, dryRun, onDuplicate, ownerId: ownerId || undefined, accounts: decisions }),
    onSuccess: (res) => {
      setResult(res);
      setError(null);
      if (!res.dryRun) {
        void queryClient.invalidateQueries({ queryKey: ['import-jobs'] });
        void queryClient.invalidateQueries({ queryKey: [upload!.module] });
        toast.push(`${res.wouldCreate} created, ${res.wouldUpdate} updated, ${res.skipped} skipped.`);
      }
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Import failed.'),
  });

  const missingRequired = (upload?.fields ?? []).filter((f) => f.required && !mapping[f.key]);

  const reset = () => {
    setUpload(null);
    setMapping({});
    setResult(null);
    setError(null);
    setReferences(null);
    setChoices({});
  };

  // A different column mapping can name different accounts; screen again rather than trust the old answers.
  const remap = (next: Record<string, string>) => {
    setMapping(next);
    setReferences(null);
    setResult(null);
  };
  const screening = SCREENED.has(upload?.module ?? '') && references !== null && toSettle.length > 0 && !result;

  return (
    <>
      <PageHeader
        title="Import"
        description="Bring a CSV or Excel file in. Zeus previews exactly what it would do before writing anything."
      />

      {error ? <div className="mb-3"><ErrorNote error={error} /></div> : null}

      {!upload ? (
        <Card>
          <CardHeader title="1. Choose a file" subtitle="CSV or XLSX, first row must be the header, 20 MB maximum" />
          <div className="px-4 py-5">
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <Field label="Import into" className="max-w-xs flex-1">
                <Select value={module} onChange={(e) => setModule(e.target.value)} options={MODULES} />
              </Field>
              <Button
                icon={<FileSpreadsheet size={14} />}
                onClick={() => getTemplate('xlsx')}
              >
                Excel template
              </Button>
              <Button variant="ghost" icon={<Download size={14} />} onClick={() => getTemplate('csv')}>
                CSV
              </Button>
            </div>

            <div className="mb-4 border border-line bg-sunken px-3 py-2.5">
              <p className="text-[12px] text-n600">
                Send this template to whoever is giving you the data. Its headers are the ones Zeus recognises, so a file
                filled in from it maps itself — nothing to match up by hand. Required columns are marked in red.
              </p>
              {templateFields?.length ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {templateFields.map((field) => (
                    <span
                      key={field.key}
                      title={field.required ? 'Required' : 'Optional'}
                      className={cx(
                        'border px-1.5 py-0.5 text-[11px]',
                        field.required ? 'border-[var(--red-300)] bg-accent-soft font-semibold text-[var(--red-700)]' : 'border-line bg-card text-muted',
                      )}
                    >
                      {field.label}
                      {field.required ? ' *' : ''}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <label
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) void pickFile(file);
              }}
              className="hatch flex cursor-pointer flex-col items-center justify-center gap-2 border border-dashed border-line px-6 py-12 text-center transition-colors hover:border-n900"
            >
              <FileUp size={26} className="text-n300" />
              <span className="text-[13px] font-semibold uppercase tracking-[0.08em]">
                {busy ? 'Reading file…' : 'Drop a file here, or click to browse'}
              </span>
              <span className="text-xs text-muted">.csv, .xlsx</span>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void pickFile(file);
                }}
              />
            </label>
          </div>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
          <Card>
            <CardHeader
              title="2. Map the columns"
              subtitle={`${upload.filename} · ${upload.totalRows} rows`}
              actions={<Button size="sm" variant="ghost" onClick={reset}>Start over</Button>}
            />
            <div className="max-h-[440px] space-y-2 overflow-y-auto px-4 py-4">
              {upload.fields.map((field) => (
                <div key={field.key} className="grid grid-cols-[1fr_1fr] items-center gap-3">
                  <span className="text-[13px]">
                    {field.label}
                    {field.required ? <span className="text-accent-ink"> *</span> : null}
                  </span>
                  <Select
                    value={mapping[field.key] ?? ''}
                    onChange={(e) => remap({ ...mapping, [field.key]: e.target.value })}
                    placeholder="— not mapped —"
                    options={upload.headers.map((header) => ({ value: header, label: header }))}
                  />
                </div>
              ))}
            </div>

            <div className="grid gap-3 border-t border-line px-4 py-3 sm:grid-cols-2">
              <Field label="When a duplicate is found">
                <Select
                  value={onDuplicate}
                  onChange={(e) => setOnDuplicate(e.target.value as typeof onDuplicate)}
                  options={[
                    { value: 'skip', label: 'Skip the row' },
                    { value: 'update', label: 'Update the existing record' },
                    { value: 'create', label: 'Create anyway' },
                  ]}
                />
              </Field>
              <Field label="Assign records to">
                <OwnerSelect value={ownerId} onChange={setOwnerId} />
              </Field>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-line bg-sunken px-4 py-3">
              <span className="text-[11px] text-muted">
                {missingRequired.length ? `Map: ${missingRequired.map((f) => f.label).join(', ')}` : 'All required columns mapped.'}
              </span>
              <div className="flex gap-2">
                <Button
                  size="sm" icon={<Play size={13} />} disabled={missingRequired.length > 0}
                  loading={screen.isPending || (run.isPending && run.variables === true)}
                  onClick={() => (SCREENED.has(upload.module) && references === null ? screen.mutate() : run.mutate(true))}
                >
                  Preview
                </Button>
                <Button
                  size="sm"
                  variant="accent"
                  icon={<Upload size={13} />}
                  disabled={missingRequired.length > 0 || !result?.dryRun}
                  loading={run.isPending && run.variables === false}
                  onClick={() => run.mutate(false)}
                >
                  Import
                </Button>
              </div>
            </div>
          </Card>

          {screening ? (
            <AccountScreening
              references={references!}
              choices={choices}
              onChoose={(key, choice) => setChoices({ ...choices, [key]: choice })}
              onAllNew={(type) => setChoices(Object.fromEntries(Object.entries(choices).map(([k, c]) => [k, { ...c, type }])))}
              settled={allSettled}
              loading={run.isPending}
              onContinue={() => run.mutate(true)}
            />
          ) : (
          <Card>
            <CardHeader title="3. Preview" subtitle={result ? (result.dryRun ? 'Nothing has been written yet' : 'Import complete') : 'Run a preview to see what happens'} />
            {!result ? (
              <div className="px-4 py-4">
                <p className="mb-3 text-[12px] text-muted">First rows of your file:</p>
                <div className="overflow-x-auto border border-line">
                  <table className="w-full border-collapse text-[12px]">
                    <thead>
                      <tr className="bg-n950 text-white">
                        {upload.headers.slice(0, 6).map((header) => (
                          <th key={header} className="whitespace-nowrap px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-[0.08em]">{header}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {upload.sample.map((row, index) => (
                        <tr key={index} className={cx('border-b border-line', index % 2 === 1 && 'bg-sunken')}>
                          {upload.headers.slice(0, 6).map((header) => (
                            <td key={header} className="max-w-[160px] truncate px-2 py-1.5">{row[header]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-px border-b border-line bg-line">
                  {[
                    ['Rows', result.totalRows, 'default'],
                    [result.dryRun ? 'Will create' : 'Created', result.wouldCreate, 'secure'],
                    [result.dryRun ? 'Will update' : 'Updated', result.wouldUpdate, 'default'],
                    ['Skipped', result.skipped, result.skipped ? 'watch' : 'default'],
                  ].map(([label, value, tone]) => (
                    <div key={String(label)} className="bg-card px-3 py-2.5">
                      <span className="eyebrow">{String(label)}</span>
                      <p className={cx('tabular mt-0.5 text-[18px] font-bold', tone === 'secure' && 'text-secure', tone === 'watch' && 'text-watch')}>{String(value)}</p>
                    </div>
                  ))}
                </div>

                {result.errors.length > 0 ? (
                  <div className="border-b border-line bg-accent-soft px-4 py-2.5">
                    <p className="text-[12px] font-semibold text-[var(--red-700)]">{result.errors.length} row(s) had problems</p>
                    <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto text-[11px] text-[var(--red-700)]">
                      {result.errors.slice(0, 20).map((issue) => (
                        <li key={issue.row}>Row {issue.row}: {issue.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <DataTable
                  dense
                  rows={result.preview}
                  rowKey={(row) => String(row.row)}
                  empty={<EmptyState title="Nothing to do" message="Every row was skipped." />}
                  columns={[
                    { key: 'row', header: 'Row', width: '56px', render: (row) => <span className="tabular text-[11px] text-muted">{row.row}</span> },
                    {
                      key: 'action', header: 'Action', width: '130px',
                      render: (row) => <Badge tone={row.action.startsWith('create') ? 'secure' : row.action === 'update' ? 'info' : 'watch'}>{row.action}</Badge>,
                    },
                    {
                      key: 'label', header: 'Record',
                      render: (row) => (
                        <span>
                          <span className="block truncate">{row.label}</span>
                          {row.note ? <span className="block text-[11px] text-muted">{row.note}</span> : null}
                        </span>
                      ),
                    },
                  ]}
                />

                {!result.dryRun ? (
                  <div className="flex items-center gap-2 border-t border-line bg-[#e8f5ed] px-4 py-3 text-[13px] text-[#14653a]">
                    <CheckCircle2 size={15} />
                    Import finished.
                    <Button size="sm" variant="ghost" className="ml-auto" onClick={reset}>Import another file</Button>
                  </div>
                ) : toSettle.length > 0 ? (
                  <div className="border-t border-line px-4 py-2.5 text-[12px]">
                    <button className="text-muted underline decoration-dotted underline-offset-2 hover:text-ink" onClick={() => setResult(null)}>
                      Change how the {toSettle.length} account{toSettle.length === 1 ? ' was' : 's were'} settled
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </Card>
          )}
        </div>
      )}

      {history && history.length > 0 ? (
        <Card className="mt-3">
          <CardHeader title="Import history" />
          <DataTable
            dense
            rows={history}
            rowKey={(row) => row.id}
            columns={[
              { key: 'filename', header: 'File', render: (row) => <span className="font-semibold">{row.filename}</span> },
              { key: 'module', header: 'Into', width: '100px', render: (row) => <Badge>{row.module}</Badge> },
              { key: 'status', header: 'Status', width: '96px', render: (row) => <Badge tone={row.status === 'done' ? 'secure' : row.status === 'failed' ? 'accent' : row.status === 'undone' ? 'watch' : 'neutral'}>{row.status}</Badge> },
              { key: 'counts', header: 'Result', width: '190px', render: (row) => <span className="tabular text-[12px] text-muted">{row.imported} created · {row.updated} updated · {row.skipped} skipped</span> },
              { key: 'createdAt', header: 'When', width: '160px', render: (row) => <span className="text-[12px] text-muted">{dateTime(row.createdAt)}</span> },
              { key: 'by', header: 'By', width: '130px', render: (row) => <span className="text-[12px]">{row.createdBy?.name ?? '—'}</span> },
              {
                key: 'undo', header: '', width: '92px', align: 'right',
                render: (row) => (row.undoable && can('imports', 'create')
                  ? <Button size="sm" variant="ghost" icon={<Undo2 size={12} />} onClick={() => setUndoing(row)}>Undo</Button>
                  : null),
              },
            ]}
          />
        </Card>
      ) : null}

      <ConfirmDialog
        open={Boolean(undoing)}
        onClose={() => setUndoing(null)}
        onConfirm={() => undoing && undo.mutate(undoing)}
        loading={undo.isPending}
        title={`Undo ${undoing?.filename ?? 'this import'}?`}
        confirmLabel="Undo import"
        message={
          <>
            Removes the {undoing?.imported ?? 0} record{undoing?.imported === 1 ? '' : 's'} it created
            {undoing?.updated ? ` and puts the ${undoing.updated} it updated back as they were` : ''}.
            Anything worked on since — put on a quote, given an activity, edited — is kept, and you will see which.
          </>
        }
      />

      {undone ? (
        <Modal
          open
          onClose={() => setUndone(null)}
          title="Import undone"
          subtitle={`${undone.job.filename} · ${undone.result.removed} removed${undone.result.restored ? ` · ${undone.result.restored} restored` : ''}`}
          footer={<Button variant="accent" onClick={() => setUndone(null)}>Done</Button>}
        >
          {undone.result.kept.length === 0 ? (
            <p className="text-[13px]">Everything the import wrote has been taken back.</p>
          ) : (
            <>
              <p className="mb-2 text-[13px]">
                {undone.result.kept.length} record{undone.result.kept.length === 1 ? ' was' : 's were'} kept, because {undone.result.kept.length === 1 ? 'it has' : 'they have'} been worked on since:
              </p>
              <ul className="max-h-72 divide-y divide-line overflow-y-auto border border-line text-[13px]">
                {undone.result.kept.map((k, i) => (
                  <li key={`${k.label}-${i}`} className="px-3 py-2">
                    <span className="font-semibold">{k.label}</span>
                    <span className="block text-[11px] text-muted">{k.reason}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Modal>
      ) : null}
    </>
  );
}

/**
 * Settle the accounts a file names that Zeus does not have by exactly that name — link each to
 * one Zeus has, create it as the right kind of account, or leave its rows out. Nothing is
 * imported until every one has an answer.
 */
function AccountScreening({ references, choices, onChoose, onAllNew, settled, loading, onContinue }: {
  references: AccountReference[];
  choices: Record<string, Choice>;
  onChoose: (key: string, choice: Choice) => void;
  onAllNew: (type: AccountKind) => void;
  settled: boolean;
  loading: boolean;
  onContinue: () => void;
}) {
  const open = references.filter((r) => r.status !== 'found');
  const found = references.length - open.length;
  const answered = open.filter((r) => choices[r.key] && decisionOf(choices[r.key])).length;

  return (
    <Card>
      <CardHeader
        title="3. Settle the accounts"
        subtitle={`${open.length} account${open.length === 1 ? '' : 's'} in this file need${open.length === 1 ? 's' : ''} an answer${found ? ` · ${found} matched exactly` : ''}. Nothing is imported until each is settled.`}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-sunken px-4 py-2.5 text-[12px]">
        <span className="text-muted">Create every new account as</span>
        <Select className="w-32 py-1" aria-label="Type for every new account" value="" placeholder="choose…" options={KINDS} onChange={(e) => e.target.value && onAllNew(e.target.value as AccountKind)} />
      </div>

      <ul className="max-h-[520px] divide-y divide-line overflow-y-auto">
        {open.map((ref) => {
          const choice = choices[ref.key];
          const set = (patch: Partial<Choice>) => onChoose(ref.key, { ...choice, ...patch });
          const rows = `${ref.rows.length} row${ref.rows.length === 1 ? '' : 's'}`;
          return (
            <li key={ref.key} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_1.2fr]">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-[13px] font-semibold">
                  {ref.name ?? <span className="text-accent-ink">No {ref.label.toLowerCase()} given</span>}
                  <Badge className="shrink-0 whitespace-nowrap" tone={ref.status === 'blank' ? 'accent' : 'watch'}>{ref.status === 'blank' ? `row ${ref.rows[0]}` : 'not in Zeus'}</Badge>
                </p>
                <p className="truncate text-[11px] text-muted">
                  {ref.label} · {rows}{ref.examples.length ? `: ${ref.examples.join(', ')}` : ''}{ref.domain ? ` · ${ref.domain}` : ''}
                </p>
              </div>
              <div className="grid gap-1.5">
                <Select
                  aria-label={`What to do with ${ref.name ?? `row ${ref.rows[0]}`}`}
                  value={choice.pick}
                  placeholder={choice.pick === '' ? 'Choose…' : undefined}
                  onChange={(e) => set({ pick: e.target.value })}
                  options={[
                    ...ref.suggestions.map((sg) => ({ value: `link:${sg.id}`, label: `Link to ${sg.name} — ${sg.reason}` })),
                    { value: 'create', label: 'Create a new account' },
                    { value: 'other', label: 'Link to another account…' },
                    { value: 'skip', label: `Leave ${ref.rows.length === 1 ? 'this row' : `these ${ref.rows.length} rows`} out` },
                  ]}
                />
                {choice.pick === 'create' ? (
                  <div className="grid grid-cols-[1fr_auto] gap-1.5">
                    <Input className="py-1" aria-label="New account name" value={choice.name} placeholder="Account name" onChange={(e) => set({ name: e.target.value })} />
                    <Select className="w-32 py-1" aria-label="New account type" value={choice.type} options={KINDS} onChange={(e) => set({ type: e.target.value as AccountKind })} />
                  </div>
                ) : null}
                {choice.pick === 'other' ? (
                  <AccountPicker value={choice.otherId} selectedLabel={choice.otherName} onChange={(id, row) => set({ otherId: id, otherName: row?.name ?? null })} />
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center justify-between gap-2 border-t border-line bg-sunken px-4 py-3">
        <span className="text-[11px] text-muted">{answered} of {open.length} settled</span>
        <Button size="sm" icon={<Play size={13} />} disabled={!settled} loading={loading} onClick={onContinue}>Continue to preview</Button>
      </div>
    </Card>
  );
}
