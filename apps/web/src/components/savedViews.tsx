import { useEffect, useRef, useState } from 'react';
import { Bookmark, Check, X } from 'lucide-react';
import { Button, cx } from './ui';

/**
 * Named filter sets for a list, saved per browser. A power-user convenience — the
 * common filters someone re-applies every visit, one click away.
 * ponytail: localStorage per-browser; move to a SavedView table if they need to
 * follow a user across devices.
 */

interface View {
  name: string;
  filters: Record<string, unknown>;
}

function load(key: string): View[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function SavedViews({ storageKey, current, onApply }: {
  storageKey: string;
  current: Record<string, unknown>;
  onApply: (filters: Record<string, unknown>) => void;
}) {
  const [views, setViews] = useState<View[]>(() => load(storageKey));
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const persist = (next: View[]) => { setViews(next); localStorage.setItem(storageKey, JSON.stringify(next)); };

  const save = () => {
    const name = window.prompt('Name this view')?.trim();
    if (!name) return;
    persist([...views.filter((v) => v.name !== name), { name, filters: current }]);
  };

  return (
    <div className="relative" ref={ref}>
      <Button size="sm" icon={<Bookmark size={13} />} onClick={() => setOpen((o) => !o)}>
        Views{views.length ? ` (${views.length})` : ''}
      </Button>
      {open ? (
        <div className="absolute right-0 top-9 z-40 w-60 border border-line bg-card shadow-[var(--shadow-lg)]">
          {views.length === 0 ? (
            <p className="px-3 py-3 text-center text-[12px] text-muted">No saved views yet.</p>
          ) : (
            views.map((v) => (
              <div key={v.name} className="flex items-center border-b border-line last:border-b-0">
                <button
                  className="flex flex-1 items-center gap-1.5 px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent-soft"
                  onClick={() => { onApply(v.filters); setOpen(false); }}
                >
                  <Check size={12} className="text-muted" /> <span className="truncate">{v.name}</span>
                </button>
                <button
                  className="px-2 py-2 text-n400 hover:text-accent"
                  aria-label={`Delete view ${v.name}`}
                  onClick={() => persist(views.filter((x) => x.name !== v.name))}
                >
                  <X size={13} />
                </button>
              </div>
            ))
          )}
          <button className={cx('w-full border-t border-line bg-sunken px-3 py-2 text-left text-[12px] font-semibold hover:bg-accent-soft')} onClick={save}>
            + Save current filters
          </button>
        </div>
      ) : null}
    </div>
  );
}
