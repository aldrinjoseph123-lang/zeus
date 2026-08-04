import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { Badge, Button, cx, Select, Spinner, useDebounced } from './ui';

/**
 * Type-ahead picker over any list endpoint. Used for account, partner, vendor,
 * contact and product lookups so none of them need the whole table in memory.
 */
export function Lookup<T extends { id: string }>({
  value, onChange, endpoint, extraParams, render, placeholder = 'Search…', disabled, allowClear = true, selectedLabel,
}: {
  value: string | null;
  onChange: (id: string | null, row: T | null) => void;
  endpoint: string;
  extraParams?: Record<string, unknown>;
  render: (row: T) => { primary: string; secondary?: string };
  placeholder?: string;
  disabled?: boolean;
  allowClear?: boolean;
  /** Shown when the picker mounts with a value already set. */
  selectedLabel?: string | null;
}) {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<string | null>(selectedLabel ?? null);
  const ref = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(term, 250);

  useEffect(() => setLabel(selectedLabel ?? null), [selectedLabel]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const { data, isFetching } = useQuery({
    queryKey: ['lookup', endpoint, debounced, extraParams],
    enabled: open,
    queryFn: () => api.get<{ data: T[] }>(`${endpoint}${qs({ search: debounced, pageSize: 12, ...extraParams })}`),
  });

  if (value && label && !open) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-sharp border border-line bg-white px-3 py-2 text-[13px]">
        <span className="truncate">{label}</span>
        <span className="flex shrink-0 items-center gap-1">
          {allowClear && !disabled ? (
            <button type="button" onClick={() => { onChange(null, null); setLabel(null); }} aria-label="Clear" className="text-n400 hover:text-accent">
              <X size={13} />
            </button>
          ) : null}
          {!disabled ? (
            <button type="button" onClick={() => setOpen(true)} aria-label="Change" className="text-n400 hover:text-ink">
              <ChevronDown size={14} />
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <input
        value={term}
        disabled={disabled}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        className="w-full rounded-sharp border border-line bg-white px-3 py-2 text-[13px] placeholder:text-n400 focus:border-n900 disabled:bg-n50"
      />
      {isFetching ? <span className="absolute right-2.5 top-1/2 -translate-y-1/2"><Spinner size={13} /></span> : null}

      {open ? (
        <div className="absolute left-0 top-[38px] z-30 max-h-64 w-full overflow-y-auto border border-line bg-white shadow-[var(--shadow-lg)]">
          {(data?.data ?? []).length === 0 ? (
            <p className="px-3 py-3 text-center text-xs text-muted">{isFetching ? 'Searching…' : 'No matches.'}</p>
          ) : (
            data!.data.map((row) => {
              const view = render(row);
              return (
                <button
                  type="button"
                  key={row.id}
                  onClick={() => { onChange(row.id, row); setLabel(view.primary); setOpen(false); setTerm(''); }}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent-soft"
                >
                  <span className="truncate text-[13px]">{view.primary}</span>
                  {view.secondary ? <span className="shrink-0 text-[11px] text-muted">{view.secondary}</span> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AccountPicker({ value, onChange, type, selectedLabel, placeholder }: {
  value: string | null;
  onChange: (id: string | null, row: { id: string; name: string } | null) => void;
  type?: 'CUSTOMER' | 'PARTNER' | 'VENDOR' | 'PROSPECT';
  selectedLabel?: string | null;
  placeholder?: string;
}) {
  return (
    <Lookup<{ id: string; name: string; type: string; domain: string | null }>
      value={value}
      onChange={onChange}
      endpoint="/accounts"
      extraParams={type ? { type } : undefined}
      selectedLabel={selectedLabel}
      placeholder={placeholder ?? 'Search accounts…'}
      render={(row) => ({ primary: row.name, secondary: row.domain ?? row.type })}
    />
  );
}

export function ContactPicker({ value, onChange, accountId, selectedLabel }: {
  value: string | null;
  onChange: (id: string | null) => void;
  accountId?: string | null;
  selectedLabel?: string | null;
}) {
  return (
    <Lookup<{ id: string; firstName: string; lastName: string; jobTitle: string | null }>
      value={value}
      onChange={(id) => onChange(id)}
      endpoint="/contacts"
      extraParams={accountId ? { accountId } : undefined}
      selectedLabel={selectedLabel}
      placeholder="Search contacts…"
      render={(row) => ({ primary: `${row.firstName} ${row.lastName}`, secondary: row.jobTitle ?? undefined })}
    />
  );
}

export function OwnerSelect({ value, onChange, includeUnassigned = true, className }: {
  value: string;
  onChange: (id: string) => void;
  includeUnassigned?: boolean;
  className?: string;
}) {
  const { data } = useQuery({
    queryKey: ['users-lookup'],
    queryFn: () => api.get<Array<{ id: string; name: string }>>('/users/lookup'),
    staleTime: 300_000,
  });
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={includeUnassigned ? 'Anyone' : undefined}
      options={(data ?? []).map((u) => ({ value: u.id, label: u.name }))}
      className={className}
      aria-label="Owner"
    />
  );
}

export interface DuplicateMatch {
  module: string;
  id: string;
  label: string;
  sublabel?: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
  ownerName?: string | null;
}

/**
 * The domain-alert panel. Shown before a save whenever the customer domain, email
 * or company name already exists — the user decides whether it is really new.
 */
export function DuplicateWarning({ matches, domain, onProceed, onCancel, busy }: {
  matches: DuplicateMatch[];
  domain?: string | null;
  onProceed: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const path = (m: DuplicateMatch) =>
    m.module === 'accounts' ? `/accounts/${m.id}` : m.module === 'deals' ? `/deals/${m.id}` : m.module === 'leads' ? `/leads/${m.id}` : '/contacts';

  return (
    <div className="border border-[var(--red-300)] bg-accent-soft">
      <div className="flex items-start gap-2 border-b border-[var(--red-300)] px-3 py-2.5">
        <AlertTriangle size={16} className="mt-px shrink-0 text-accent" />
        <div>
          <p className="text-[13px] font-semibold text-[var(--red-700)]">Possible duplicate</p>
          <p className="text-xs text-[var(--red-700)]">
            {domain ? <>Domain <strong>{domain}</strong> already exists in Zeus.</> : 'A matching record already exists.'} Check before creating another.
          </p>
        </div>
      </div>

      <ul className="divide-y divide-[var(--red-300)]/50">
        {matches.map((match) => (
          <li key={`${match.module}-${match.id}`} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="min-w-0">
              <Link to={path(match)} target="_blank" className="block truncate text-[13px] font-semibold underline decoration-dotted underline-offset-2">
                {match.label}
              </Link>
              <span className="block text-[11px] text-[var(--red-700)]">
                {match.reason}
                {match.ownerName ? ` · owned by ${match.ownerName}` : ''}
              </span>
            </span>
            <Badge tone={match.confidence === 'high' ? 'accent' : 'watch'}>{match.confidence}</Badge>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-end gap-2 border-t border-[var(--red-300)] px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" size="sm" onClick={onProceed} loading={busy}>Create anyway</Button>
      </div>
    </div>
  );
}

/** Options sourced from Settings → Lists, so every dropdown stays editable. */
export function useSettingsList(key: string): string[] {
  const { data } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.get<Record<string, unknown>>('/settings/public'),
    staleTime: 300_000,
  });
  const value = data?.[key];
  return Array.isArray(value) ? (value as string[]) : [];
}

export function ListSelect({ listKey, value, onChange, placeholder, className, id }: {
  listKey: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  const options = useSettingsList(listKey);
  return (
    <Select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      options={options.map((option) => ({ value: option, label: option }))}
      className={className}
    />
  );
}

export function Toolbar({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx('flex flex-wrap items-center gap-2 border-b border-line bg-card px-3 py-2.5', className)}>{children}</div>;
}
