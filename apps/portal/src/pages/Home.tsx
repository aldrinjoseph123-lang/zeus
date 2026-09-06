import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Shell } from '../shell';
import { useMe } from '../me';
import PartnerHome from './PartnerHome';

/**
 * The signed-in home. Phase 1 is deliberately empty: it proves who you are and which
 * company you are here for. The partner view (registered deals and their protection)
 * and the customer view (services and renewals) arrive in the next phases.
 */
export default function Home() {
  const me = useMe();
  const navigate = useNavigate();
  const signOut = async () => {
    await api('POST', '/auth/logout').catch(() => undefined);
    navigate('/sign-in', { replace: true });
  };

  return (
    <Shell wide>
      {me.viewingAs ? (
        <div role="status" className="mb-6 border border-[var(--red)] px-4 py-2.5 text-[12px] uppercase tracking-[0.15em] text-[var(--ink)]">
          Preview · you are {me.viewingAs}, seeing the portal as {me.name}. Read-only; every view here is logged.
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline justify-between gap-4 border-b border-[var(--line)] pb-5">
        <div>
          <p className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">{me.account.type === 'PARTNER' ? 'Channel partner' : 'Customer'}</p>
          <h1 className="mt-1 text-[26px] font-bold leading-none">{me.account.name}</h1>
          <p className="mt-2 text-[13px] text-[var(--muted)]">Signed in as {me.name} · {me.email}</p>
        </div>
        <button onClick={signOut} className="text-[12px] uppercase tracking-[0.15em] text-[var(--muted)] underline underline-offset-4 hover:text-[var(--ink)]">Sign out</button>
      </div>

      {me.account.type === 'PARTNER' ? <PartnerHome /> : (
        <section className="mt-10 border border-dashed border-[var(--line)] px-6 py-12 text-center">
          <p className="text-[13px] uppercase tracking-[0.2em] text-[var(--muted)]">Nothing to show yet</p>
          <p className="mx-auto mt-3 max-w-[48ch] text-[14px] leading-relaxed text-[var(--muted)]">Your services, what each includes, and their renewal dates will appear here.</p>
        </section>
      )}
    </Shell>
  );
}
