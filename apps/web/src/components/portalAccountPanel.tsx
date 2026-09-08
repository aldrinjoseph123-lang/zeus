import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { relative } from '../lib/format';
import { Badge, Button, Select, useToast } from './ui';
import { LogoField } from '../pages/Settings';

/**
 * One partner's (or customer's) portal, in one place: what their people see, the logo
 * over it, and who those people are. Used from Settings → Portal access (the control
 * panel) and from the account page (the same thing, where sales already are).
 *
 * Each switch is Default / Shown / Hidden. Default follows Settings → Portal access;
 * the other two override it for this account only — and only within what the code
 * allows out at all.
 */
export type PortalAccountView = {
  id: string;
  name: string;
  type: string;
  logo: string | null;
  overrides: Record<string, boolean>;
  global: Record<string, boolean>;
  effective: Record<string, boolean>;
  switches: Array<{ key: string; label: string }>;
  users: Array<{ id: string; email: string; disabledAt: string | null; lastLoginAt: string | null; hasPassword: boolean; contact?: { firstName: string; lastName: string } }>;
};

export function PortalAccountPanel({ accountId, editable, onGrant }: { accountId: string; editable: boolean; onGrant?: () => void }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const key = ['portal-account', accountId];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.get<PortalAccountView>(`/portal-admin/accounts/${accountId}`) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: ['portal-users'] });
  };

  const save = useMutation({
    mutationFn: (body: { overrides?: Record<string, boolean | null>; logo?: string | null }) => api.patch(`/portal-admin/accounts/${accountId}`, body),
    onSuccess: () => { refresh(); toast.push('Saved.'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not save.', 'error'),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'link' | 'revoke' | 'restore' }) => { setBusyUser(id); return api.post<{ to?: string }>(`/portal-admin/users/${id}/${action}`, {}); },
    onSuccess: (r, v) => { refresh(); toast.push(v.action === 'link' ? `Set-password link sent to ${r.to}.` : v.action === 'revoke' ? 'Access revoked — their open sessions end now.' : 'Access restored — send them a link to sign in.'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not do that.', 'error'),
    onSettled: () => setBusyUser(null),
  });
  const viewAs = useMutation({
    mutationFn: (id: string) => api.post<{ url: string }>(`/portal-admin/users/${id}/view-as`, {}),
    onSuccess: (r) => { window.open(r.url, '_blank', 'noopener'); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not open the preview.', 'error'),
  });

  if (!data) return null;
  const who = (u: PortalAccountView['users'][number]) => u.contact ? `${u.contact.firstName} ${u.contact.lastName}` : u.email;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <p className="mb-2 text-[11px] uppercase tracking-[0.08em] text-muted">Their logo on the portal</p>
        <LogoField value={data.logo} disabled={!editable} onChange={(logo) => save.mutate({ logo })} />
      </div>

      <div>
        <p className="mb-2 text-[11px] uppercase tracking-[0.08em] text-muted">What their people see</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {data.switches.map((sw) => {
            const override = data.overrides[sw.key];
            return (
              <label key={sw.key} className="flex flex-col gap-1 text-[12px]">
                <span>{sw.label}</span>
                <Select
                  value={override === undefined ? 'default' : override ? 'on' : 'off'}
                  disabled={!editable}
                  onChange={(e) => save.mutate({ overrides: { [sw.key]: e.target.value === 'default' ? null : e.target.value === 'on' } })}
                  options={[
                    { value: 'default', label: `Default (${data.global[sw.key] ? 'shown' : 'hidden'})` },
                    { value: 'on', label: 'Shown for this account' },
                    { value: 'off', label: 'Hidden for this account' },
                  ]}
                />
              </label>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted">People with access</p>
          {editable && onGrant ? <Button size="sm" variant="ghost" onClick={onGrant}>Grant access</Button> : null}
        </div>
        {data.users.length === 0 ? (
          <p className="text-[12px] text-muted">Nobody yet. Grant access to a contact at this account and they get a set-password link.</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {data.users.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[13px]">
                <div className="min-w-0">
                  <p className="truncate font-semibold">{who(u)} <span className="font-normal text-muted">· {u.email}</span></p>
                  <p className="text-[12px] text-muted">
                    <Badge tone={u.disabledAt ? 'neutral' : u.hasPassword ? 'secure' : 'watch'}>{u.disabledAt ? 'Revoked' : u.hasPassword ? 'Active' : 'Invited'}</Badge>
                    <span className="ml-2">{u.lastLoginAt ? `last sign-in ${relative(u.lastLoginAt)}` : 'never signed in'}</span>
                  </p>
                </div>
                {editable ? (
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" onClick={() => viewAs.mutate(u.id)}>View as</Button>
                    {!u.disabledAt ? <Button size="sm" variant="ghost" loading={busyUser === u.id} onClick={() => act.mutate({ id: u.id, action: 'link' })}>Send link</Button> : null}
                    {u.disabledAt
                      ? <Button size="sm" loading={busyUser === u.id} onClick={() => act.mutate({ id: u.id, action: 'restore' })}>Restore</Button>
                      : <Button size="sm" variant="ghost" loading={busyUser === u.id} onClick={() => act.mutate({ id: u.id, action: 'revoke' })}>Revoke</Button>}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
