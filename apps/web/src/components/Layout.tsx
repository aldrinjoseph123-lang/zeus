import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Building2, CalendarClock, ClipboardList, Contact2, FileText, Gauge, LayoutGrid, LogOut, Menu, Package, Undo2,
  Receipt, ScrollText, Settings as SettingsIcon, ShieldCheck, Target, Upload, UserRound, Users, } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import { Avatar, Badge, Button, cx, Spinner } from './ui';
import { useRecentUndo } from '../lib/undo';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Gauge;
  module: string;
  end?: boolean;
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Sell',
    items: [
      { to: '/', label: 'Dashboard', icon: Gauge, module: 'dashboard', end: true },
      { to: '/deals', label: 'Deals', icon: LayoutGrid, module: 'deals' },
      { to: '/leads', label: 'Leads', icon: Target, module: 'leads' },
      { to: '/activities', label: 'Tasks', icon: ClipboardList, module: 'activities' },
    ],
  },
  {
    section: 'Relationships',
    items: [
      { to: '/accounts', label: 'Accounts', icon: Building2, module: 'accounts' },
      { to: '/contacts', label: 'Contacts', icon: Contact2, module: 'contacts' },
    ],
  },
  {
    section: 'Commercial',
    items: [
      { to: '/quotes', label: 'Quotes', icon: FileText, module: 'quotes' },
      { to: '/purchase-orders', label: 'Purchase orders', icon: ScrollText, module: 'invoices' },
      { to: '/invoices', label: 'Invoices', icon: Receipt, module: 'invoices' },
      { to: '/renewals', label: 'Renewals', icon: CalendarClock, module: 'deals' },
      { to: '/products', label: 'Catalog', icon: Package, module: 'products' },
    ],
  },
  {
    section: 'Insight',
    items: [
      { to: '/reports', label: 'Reports', icon: ShieldCheck, module: 'reports' },
      { to: '/imports', label: 'Import', icon: Upload, module: 'imports' },
    ],
  },
];

/**
 * Undo panel — the last few reversible things this user did.
 *
 * The toast is the fast path; this is for when it has already faded, or when the
 * mistake only becomes obvious two screens later.
 */
function UndoMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { entries, refetch, undo } = useRecentUndo();

  useEffect(() => {
    // The list is only interesting the moment it is opened, so it is fetched then
    // rather than polled in the background all day.
    if (!open) return;
    void refetch();
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open, refetch]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Undo recent changes${entries.length ? `, ${entries.length} available` : ''}`}
        title="Recent changes you can undo"
        className="relative flex h-9 w-9 items-center justify-center text-n400 transition-colors hover:text-white"
      >
        <Undo2 size={17} />
        {entries.length > 0 ? <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" /> : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-40 w-[360px] border border-line bg-white shadow-[var(--shadow-lg)]">
          <div className="border-b border-line px-3 py-2">
            <span className="eyebrow">Undo a recent change</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {entries.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted">Nothing to undo. Deletions and edits appear here for 72 hours.</p>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2 border-b border-line px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold leading-snug">{entry.label}</p>
                    <p className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-n400">{relative(entry.at)}</p>
                  </div>
                  <button
                    disabled={undo.isPending}
                    onClick={() => undo.mutate(entry.id)}
                    className="shrink-0 rounded-sharp border border-n900 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors hover:bg-n950 hover:text-white disabled:opacity-40"
                  >
                    Undo
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NotificationBell() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['notifications', 'recent'],
    queryFn: () => api.get<{ data: Array<{ id: string; title: string; body: string | null; link: string | null; severity: string; readAt: string | null; createdAt: string }>; unread: number }>('/notifications?pageSize=12'),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const markRead = async () => {
    await api.post('/notifications/read');
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };

  const unread = data?.unread ?? 0;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}
        className="relative flex h-9 w-9 items-center justify-center text-n400 transition-colors hover:text-white"
      >
        <Bell size={17} />
        {unread > 0 ? (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 top-11 z-40 w-[360px] border border-line bg-white shadow-[var(--shadow-lg)]">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="eyebrow">Notifications</span>
            {unread > 0 ? (
              <button onClick={markRead} className="text-[11px] font-semibold uppercase tracking-[0.08em] text-accent hover:underline">
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="max-h-[400px] overflow-y-auto">
            {(data?.data ?? []).length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted">Nothing needs your attention.</p>
            ) : (
              data!.data.map((n) => (
                <Link
                  key={n.id}
                  to={n.link ?? '#'}
                  onClick={() => setOpen(false)}
                  className={cx('block border-b border-line px-3 py-2.5 transition-colors hover:bg-sunken', !n.readAt && 'bg-accent-soft/40')}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: n.severity === 'critical' ? 'var(--red-500)' : n.severity === 'warn' ? 'var(--status-watch)' : 'var(--neutral-300)' }}
                    />
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold leading-snug">{n.title}</p>
                      {n.body ? <p className="mt-0.5 line-clamp-2 text-xs text-muted">{n.body}</p> : null}
                      <p className="mt-1 text-[10px] uppercase tracking-[0.08em] text-n400">{relative(n.createdAt)}</p>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Layout() {
  const { user, can, loading } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  const signOut = async () => {
    await api.post('/auth/logout');
    queryClient.clear();
    navigate('/login');
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-inverse">
        <Spinner size={24} />
      </div>
    );
  }

  const sidebar = (
    <aside className="flex h-full w-[212px] shrink-0 flex-col bg-n950 text-white">
      <div className="flex items-center gap-2 border-b border-n800 px-4 py-4">
        <span className="text-[19px] font-bold tracking-[0.22em]">ZEUS</span>
        <span className="text-[19px] font-bold leading-none text-accent">.</span>
        <span className="ml-auto text-[9px] uppercase tracking-[0.12em] text-n500">Protect24x7</span>
      </div>

      <nav className="flex-1 overflow-y-auto py-3">
        {NAV.map((group) => {
          const items = group.items.filter((item) => can(item.module, 'read'));
          if (items.length === 0) return null;
          return (
            <div key={group.section} className="mb-4">
              <p className="px-4 pb-1.5 text-[9px] font-bold uppercase tracking-[0.16em] text-n600">{group.section}</p>
              {items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setMobileOpen(false)}
                  className={({ isActive }) =>
                    cx(
                      'relative flex items-center gap-2.5 px-4 py-2 text-[13px] transition-colors',
                      isActive ? 'bg-n900 font-semibold text-white' : 'text-n400 hover:bg-n900 hover:text-white',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive ? <span className="absolute left-0 top-0 h-full w-[3px] bg-accent" /> : null}
                      <item.icon size={15} />
                      {item.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>

      {can('settings', 'read') || can('users', 'read') || can('integrations', 'read') ? (
        <NavLink
          to="/settings"
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            cx('flex items-center gap-2.5 border-t border-n800 px-4 py-2.5 text-[13px] transition-colors',
              isActive ? 'bg-n900 font-semibold text-white' : 'text-n400 hover:bg-n900 hover:text-white')
          }
        >
          <SettingsIcon size={15} />
          Settings
        </NavLink>
      ) : null}

      <div className="border-t border-n800 px-3 py-3">
        <div className="flex items-center gap-2">
          <Avatar name={user?.name ?? '?'} color={user?.avatarColor} size={30} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-semibold">{user?.name}</p>
            <p className="truncate text-[10px] uppercase tracking-[0.08em] text-n500">{user?.role.name}</p>
          </div>
          <button onClick={signOut} aria-label="Sign out" title="Sign out" className="text-n500 transition-colors hover:text-accent">
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <div className="flex h-full">
      <div className="hidden lg:block">{sidebar}</div>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="absolute inset-0" style={{ background: 'var(--surface-overlay)' }} onClick={() => setMobileOpen(false)} />
          <div className="relative">{sidebar}</div>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-n800 bg-n950 px-3 sm:px-4">
          <button onClick={() => setMobileOpen(true)} aria-label="Open menu" className="text-n400 hover:text-white lg:hidden">
            <Menu size={19} />
          </button>

          <GlobalSearch />

          <div className="ml-auto flex items-center gap-1">
            {can('deals', 'create') ? (
              <Button variant="accent" size="sm" onClick={() => navigate('/deals?new=1')} className="hidden sm:inline-flex">
                New deal
              </Button>
            ) : null}
            <UndoMenu />
            <NotificationBell />
          </div>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto bg-sunken p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** One search box across deals, accounts, leads and contacts. */
function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { can } = useAuth();
  const ref = useRef<HTMLDivElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ['global-search', term],
    enabled: term.trim().length >= 2,
    queryFn: async () => {
      const search = encodeURIComponent(term.trim());
      const [deals, accounts, leads, contacts] = await Promise.all([
        can('deals', 'read') ? api.get<{ data: Array<{ id: string; reference: string; name: string; account: { name: string } }> }>(`/deals?search=${search}&pageSize=5`) : { data: [] },
        can('accounts', 'read') ? api.get<{ data: Array<{ id: string; name: string; type: string }> }>(`/accounts?search=${search}&pageSize=5`) : { data: [] },
        can('leads', 'read') ? api.get<{ data: Array<{ id: string; firstName: string; lastName: string; company: string }> }>(`/leads?search=${search}&pageSize=5`) : { data: [] },
        can('contacts', 'read') ? api.get<{ data: Array<{ id: string; firstName: string; lastName: string; account: { name: string } | null }> }>(`/contacts?search=${search}&pageSize=5`) : { data: [] },
      ]);
      return { deals: deals.data, accounts: accounts.data, leads: leads.data, contacts: contacts.data };
    },
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const go = (path: string) => {
    setOpen(false);
    setTerm('');
    navigate(path);
  };

  const groups = [
    { label: 'Deals', rows: (data?.deals ?? []).map((d) => ({ id: d.id, primary: `${d.reference} · ${d.name}`, secondary: d.account.name, path: `/deals/${d.id}` })) },
    { label: 'Accounts', rows: (data?.accounts ?? []).map((a) => ({ id: a.id, primary: a.name, secondary: a.type, path: `/accounts/${a.id}` })) },
    { label: 'Leads', rows: (data?.leads ?? []).map((l) => ({ id: l.id, primary: `${l.firstName} ${l.lastName}`, secondary: l.company, path: `/leads/${l.id}` })) },
    { label: 'Contacts', rows: (data?.contacts ?? []).map((c) => ({ id: c.id, primary: `${c.firstName} ${c.lastName}`, secondary: c.account?.name ?? '—', path: `/contacts?search=${encodeURIComponent(c.firstName)}` })) },
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="relative w-full max-w-md" ref={ref}>
      <input
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search deals, accounts, leads…"
        className="w-full rounded-sharp border border-n800 bg-n900 px-3 py-1.5 text-[13px] text-white placeholder:text-n500 focus:border-accent"
      />
      {isFetching ? <span className="absolute right-2.5 top-1/2 -translate-y-1/2"><Spinner size={13} /></span> : null}

      {open && term.trim().length >= 2 ? (
        <div className="absolute left-0 top-10 z-40 w-full border border-line bg-white shadow-[var(--shadow-lg)]">
          {groups.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted">{isFetching ? 'Searching…' : 'No matches.'}</p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <p className="eyebrow border-b border-line bg-sunken px-3 py-1.5">{group.label}</p>
                {group.rows.map((row) => (
                  <button key={row.id} onClick={() => go(row.path)} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-accent-soft">
                    <span className="truncate text-[13px]">{row.primary}</span>
                    <span className="shrink-0 text-[11px] text-muted">{row.secondary}</span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export function AccessDenied({ module }: { module: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
      <UserRound size={30} className="text-n300" />
      <h2 className="text-[15px] font-semibold uppercase tracking-[0.1em]">No access to {module}</h2>
      <p className="max-w-sm text-[13px] text-muted">Your role does not include this area. An administrator can grant it in Settings → Roles.</p>
      <Badge tone="neutral">
        <Users size={11} /> Ask an administrator
      </Badge>
    </div>
  );
}
