import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Copy, Info, Loader2, Search, X } from 'lucide-react';

/**
 * Class joiner with last-wins resolution for sizing utilities.
 * Without this, a component's base `w-full` and a caller's `w-[170px]` both land in
 * the stylesheet and the winner is decided by Tailwind's ordering, not by intent.
 */
const SIZE_PREFIXES = ['w-', 'h-', 'min-w-', 'max-w-', 'min-h-', 'max-h-'];

export const cx = (...parts: Array<string | false | null | undefined>): string => {
  const classes = parts.filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
  const seen = new Map<string, number>();

  classes.forEach((cls, index) => {
    // Longest prefix first so "min-w-" is not mistaken for "w-".
    const prefix = SIZE_PREFIXES.filter((p) => cls.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (prefix) seen.set(prefix, index);
  });

  return classes
    .filter((cls, index) => {
      const prefix = SIZE_PREFIXES.filter((p) => cls.startsWith(p)).sort((a, b) => b.length - a.length)[0];
      return !prefix || seen.get(prefix) === index;
    })
    .join(' ');
};

// ── button ────────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'accent' | 'ghost' | 'outline' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-n950 text-white hover:bg-n800 border border-n950',
  accent: 'bg-accent text-white hover:bg-accent-hover border border-accent',
  outline: 'bg-card text-ink border border-n900 hover:bg-n50',
  ghost: 'bg-transparent text-muted border border-transparent hover:bg-n100 hover:text-ink',
  danger: 'bg-card text-accent border border-accent hover:bg-accent hover:text-white',
};

export function Button({
  variant = 'outline',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-sharp font-semibold uppercase tracking-[0.08em] transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'px-2.5 py-1.5 text-[10px]' : 'px-4 py-2.5 text-[11px]',
        BUTTON_STYLES[variant],
        className,
      )}
      style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease-mechanical)' }}
    >
      {loading ? <Loader2 size={13} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-sharp border border-transparent text-muted transition-colors hover:bg-n100 hover:text-ink disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

// ── surfaces ──────────────────────────────────────────────────────────────────

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & Record<string, unknown>) {
  return (
    // min-w-0: as a grid child, a card must be allowed to shrink below the
    // intrinsic width of a wide table or chart inside it, or the page scrolls sideways.
    <div {...rest} className={cx('min-w-0 border border-line bg-card', className)}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
      <div className="min-w-0">
        <h3 className="truncate text-[13px] font-semibold uppercase tracking-[0.1em]">{title}</h3>
        {subtitle ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** KPI tile: eyebrow label, big tabular figure, optional delta and footnote. */
export function StatTile({
  label, value, sub, tone = 'default', icon, onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'accent' | 'watch' | 'secure';
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const bar = { default: 'bg-n900', accent: 'bg-accent', watch: 'bg-watch', secure: 'bg-secure' }[tone];
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
      className={cx(
        'relative border border-line bg-card px-4 py-3.5 transition-shadow',
        onClick && 'cursor-pointer hover:shadow-[var(--shadow-md)]',
      )}
    >
      <span className={cx('absolute left-0 top-0 h-full w-[3px]', bar)} />
      <div className="flex items-start justify-between gap-2">
        <span className="eyebrow">{label}</span>
        {icon ? <span className="text-n300">{icon}</span> : null}
      </div>
      <div className="tabular mt-1.5 text-[26px] font-bold leading-none">{value}</div>
      {sub ? <div className="mt-1.5 text-xs text-muted">{sub}</div> : null}
    </div>
  );
}

// ── form controls ─────────────────────────────────────────────────────────────

const CONTROL =
  'w-full rounded-sharp border border-line bg-card px-3 py-2 text-[13px] text-ink placeholder:text-n400 ' +
  'focus:border-ink disabled:bg-sunken disabled:text-muted';

export function Field({
  label, hint, error, required, children, className,
}: {
  label?: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('block', className)}>
      {label ? (
        <span className="eyebrow mb-1.5 block">
          {label}
          {required ? <span className="text-accent"> *</span> : null}
        </span>
      ) : null}
      {children}
      {error ? <span className="mt-1 block text-xs text-accent">{error}</span> : hint ? <span className="mt-1 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export const Input = ({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...props} className={cx(CONTROL, className)} />
);

export const Textarea = ({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea {...props} rows={props.rows ?? 3} className={cx(CONTROL, 'resize-y', className)} />
);

export function Select({
  options, placeholder, className, ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { options: Array<{ value: string; label: string }>; placeholder?: string }) {
  return (
    <select {...props} className={cx(CONTROL, 'appearance-none bg-[url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 12 12%27><path d=%27M2 4l4 4 4-4%27 fill=%27none%27 stroke=%27%236b6b6b%27 stroke-width=%271.5%27/></svg>")] bg-[length:12px] bg-[right_10px_center] bg-no-repeat pr-8', className)}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ label, checked, onChange, disabled }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-center gap-2 text-[13px]', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--red-500)]" />
      {label}
    </label>
  );
}

export function SearchInput({ value, onChange, placeholder = 'Search…', className }: { value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  return (
    <div className={cx('relative', className)}>
      <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-n400" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cx(CONTROL, 'pl-8', value && 'pr-8')}
      />
      {value ? (
        <button onClick={() => onChange('')} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 text-n400 hover:text-ink">
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}

// ── indicators ────────────────────────────────────────────────────────────────

type BadgeTone = 'neutral' | 'accent' | 'watch' | 'secure' | 'info' | 'dark';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-n100 text-n600 border-n200',
  accent: 'bg-accent-soft text-[var(--red-700)] border-[var(--red-300)]',
  watch: 'bg-[#fdf1e4] text-[#8a4a10] border-[#f0cfa8]',
  secure: 'bg-[#e8f5ed] text-[#14653a] border-[#b8dfc8]',
  info: 'bg-[#e9f0f8] text-[#1b4a80] border-[#bcd2e8]',
  dark: 'bg-n950 text-white border-n950',
};

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-sharp border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]', BADGE_TONES[tone], className)}>
      {children}
    </span>
  );
}

export const Dot = ({ color, size = 7 }: { color: string; size?: number }) => (
  <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: color }} />
);

export function Avatar({ name, color, size = 28 }: { name: string; color?: string | null; size?: number }) {
  const text = name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-sharp font-bold text-white"
      style={{ width: size, height: size, background: color || 'var(--neutral-700)', fontSize: size * 0.38 }}
      title={name}
    >
      {text}
    </span>
  );
}

export function ProgressBar({ value, tone = 'accent', height = 6 }: { value: number; tone?: 'accent' | 'secure' | 'watch'; height?: number }) {
  const color = { accent: 'var(--red-500)', secure: 'var(--status-secure)', watch: 'var(--status-watch)' }[tone];
  return (
    <div className="w-full bg-n100" style={{ height }}>
      <div className="h-full transition-[width]" style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color, transitionDuration: 'var(--dur-slow)' }} />
    </div>
  );
}

export const Spinner = ({ size = 18 }: { size?: number }) => <Loader2 size={size} className="animate-spin text-n400" />;

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-14 text-sm text-muted">
      <Spinner /> {label}…
    </div>
  );
}

export function EmptyState({ title, message, action, icon }: { title: string; message?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="hatch flex flex-col items-center justify-center gap-2 border border-dashed border-line px-6 py-14 text-center">
      {icon ? <div className="text-n300">{icon}</div> : null}
      <h3 className="text-[13px] font-semibold uppercase tracking-[0.1em]">{title}</h3>
      {message ? <p className="max-w-md text-xs text-muted">{message}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error ?? 'Something went wrong.');
  return (
    <div className="flex items-start gap-2 border border-[var(--red-300)] bg-accent-soft px-3 py-2.5 text-[13px] text-[var(--red-700)]">
      <AlertTriangle size={15} className="mt-px shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <CopyButton value={message} label="" className="shrink-0 text-[var(--red-700)]" />
    </div>
  );
}

/**
 * Copy a value to the clipboard with a moment's "copied" acknowledgement. Handy for
 * long, error-prone strings — references, IDs, and the Microsoft AADSTS/correlation
 * codes support teams ask to be read back verbatim.
 */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch { /* clipboard blocked (insecure context) — nothing to do */ }
      }}
      className={cx('inline-flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-n700', className)}
      title={copied ? 'Copied' : label || 'Copy'}
      aria-label={copied ? 'Copied' : label || 'Copy'}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {label ? <span>{copied ? 'Copied' : label}</span> : null}
    </button>
  );
}

// ── overlays ──────────────────────────────────────────────────────────────────

export function Modal({
  open, onClose, title, subtitle, children, footer, width = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  const maxWidth = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }[width];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8" style={{ background: 'var(--surface-overlay)' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('w-full bg-card shadow-[var(--shadow-lg)]', maxWidth)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-line bg-n950 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-[14px] font-bold uppercase tracking-[0.1em] text-white">{title}</h2>
            {subtitle ? <p className="mt-0.5 truncate text-xs text-n400">{subtitle}</p> : null}
          </div>
          <button onClick={onClose} aria-label="Close" className="text-n400 transition-colors hover:text-white">
            <X size={18} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-line bg-sunken px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger = true, loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'accent'} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed text-n600">{message}</div>
    </Modal>
  );
}

// ── table ─────────────────────────────────────────────────────────────────────

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
  sortable?: boolean;
  className?: string;
}

export function DataTable<T>({
  columns, rows, rowKey, onRowClick, sortBy, sortDir, onSort, empty, dense, selection,
}: {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  onSort?: (key: string) => void;
  empty?: ReactNode;
  dense?: boolean;
  /** Optional row selection — pass to get a leading checkbox column with select-all. */
  selection?: { selected: Set<string>; onToggle: (id: string) => void; onToggleAll: (ids: string[]) => void };
}) {
  if (rows.length === 0 && empty) return <>{empty}</>;

  const ids = rows.map((r, i) => rowKey(r, i));
  const allChecked = selection ? ids.length > 0 && ids.every((id) => selection.selected.has(id)) : false;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-[13px]">
        <thead>
          <tr className="bg-n950 text-white">
            {selection ? (
              <th className="w-9 px-3 py-2">
                <input type="checkbox" checked={allChecked} onChange={() => selection.onToggleAll(ids)} aria-label="Select all rows" />
              </th>
            ) : null}
            {columns.map((column) => (
              <th
                key={column.key}
                style={{ width: column.width }}
                className={cx(
                  'px-3 py-2 text-left text-[10px] font-bold uppercase tracking-[0.1em] whitespace-nowrap',
                  column.align === 'right' && 'text-right',
                  column.align === 'center' && 'text-center',
                  column.sortable && onSort && 'cursor-pointer select-none hover:text-[var(--red-300)]',
                )}
                onClick={column.sortable && onSort ? () => onSort(column.key) : undefined}
              >
                {column.header}
                {column.sortable && sortBy === column.key ? <span className="ml-1 text-accent">{sortDir === 'asc' ? '↑' : '↓'}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cx(
                'border-b border-line transition-colors',
                index % 2 === 1 && 'bg-sunken',
                onRowClick && 'cursor-pointer hover:bg-accent-soft',
              )}
            >
              {selection ? (
                <td className="px-3" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selection.selected.has(rowKey(row, index))}
                    onChange={() => selection.onToggle(rowKey(row, index))}
                    aria-label="Select row"
                  />
                </td>
              ) : null}
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={cx(
                    dense ? 'px-3 py-1.5' : 'px-3 py-2.5',
                    column.align === 'right' && 'text-right',
                    column.align === 'center' && 'text-center',
                    column.className,
                  )}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, totalPages, total, onPage }: { page: number; totalPages: number; total: number; onPage: (page: number) => void }) {
  if (totalPages <= 1) return <div className="px-3 py-2 text-xs text-muted">{total} record{total === 1 ? '' : 's'}</div>;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-3 py-2">
      <span className="text-xs text-muted">
        Page {page} of {totalPages} · {total} record{total === 1 ? '' : 's'}
      </span>
      <div className="flex items-center gap-1">
        <IconButton label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft size={15} />
        </IconButton>
        <IconButton label="Next page" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          <ChevronRight size={15} />
        </IconButton>
      </div>
    </div>
  );
}

// ── tabs ──────────────────────────────────────────────────────────────────────

export function Tabs({ tabs, active, onChange }: { tabs: Array<{ key: string; label: string; count?: number }>; active: string; onChange: (key: string) => void }) {
  return (
    <div className="flex gap-0 overflow-x-auto border-b border-line">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={cx(
            'relative whitespace-nowrap px-4 py-2.5 text-[11px] font-semibold uppercase tracking-[0.1em] transition-colors',
            active === tab.key ? 'text-ink' : 'text-muted hover:text-ink',
          )}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="ml-1.5 text-n400">{tab.count}</span> : null}
          {active === tab.key ? <span className="absolute inset-x-0 bottom-0 h-[2px] bg-accent" /> : null}
        </button>
      ))}
    </div>
  );
}

// ── toasts ────────────────────────────────────────────────────────────────────

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error' | 'info';
  /** Shown as an inline action — how "Deleted. Undo?" reaches the user. */
  action?: { label: string; onClick: () => void };
}

const ToastContext = createContext<{
  push: (message: string, tone?: Toast['tone'], action?: Toast['action']) => void;
}>({ push: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((message: string, tone: Toast['tone'] = 'success', action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone, action }]);
    // A toast offering an undo stays long enough to actually read and click.
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), action ? 9000 : 5000);
  }, []);

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={cx(
              'pointer-events-auto flex items-start gap-2 border px-3 py-2.5 text-[13px] shadow-[var(--shadow-lg)]',
              toast.tone === 'error' ? 'border-[var(--red-300)] bg-card text-[var(--red-700)]'
                : toast.tone === 'info' ? 'border-line bg-card text-ink'
                : 'border-[#b8dfc8] bg-card text-[#14653a]',
            )}
          >
            {toast.tone === 'error' ? <AlertTriangle size={15} className="mt-px shrink-0" /> : toast.tone === 'info' ? <Info size={15} className="mt-px shrink-0" /> : <Check size={15} className="mt-px shrink-0" />}
            <span className="flex-1">{toast.message}</span>
            {toast.action ? (
              <button
                onClick={() => { toast.action?.onClick(); setToasts((c) => c.filter((t) => t.id !== toast.id)); }}
                className="shrink-0 rounded-sharp border border-n900 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] text-ink transition-colors hover:bg-n950 hover:text-white"
              >
                {toast.action.label}
              </button>
            ) : null}
            <button onClick={() => setToasts((c) => c.filter((t) => t.id !== toast.id))} aria-label="Dismiss" className="text-n400 hover:text-ink">
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** Page header used by every screen — title, description and right-hand actions. */
export function PageHeader({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold uppercase leading-none tracking-[0.04em]">{title}</h1>
          {description ? <p className="mt-1.5 text-[13px] text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

/** Two-column definition list used on every record detail page. */
export function DefinitionList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="eyebrow">{item.label}</dt>
          <dd className="mt-0.5 truncate text-[13px]">{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

