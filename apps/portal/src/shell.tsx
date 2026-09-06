import type { ReactNode } from 'react';
import type { Branding, Me } from './api';
import { BrandingContext, MeContext, useBranding } from './me';

export function MeProvider({ me, branding, children }: { me: Me; branding: Branding | null; children: ReactNode }) {
  return <MeContext.Provider value={me}><BrandingContext.Provider value={branding}>{children}</BrandingContext.Provider></MeContext.Provider>;
}

/** The one layout: wordmark top-left, content centred, nothing else. */
export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  const branding = useBranding();
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between gap-4 px-6 py-5">
        {branding?.logo
          ? <img src={branding.logo} alt={branding.companyName} className="h-8 max-w-[180px] object-contain object-left" />
          : <span className="text-[13px] font-bold uppercase tracking-[0.3em]">Protect24x7<span className="text-[var(--red)]">.</span></span>}
        {branding?.accountLogo
          ? <img src={branding.accountLogo} alt="" className="h-8 max-w-[140px] object-contain object-right" />
          : <span className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Partner &amp; customer portal</span>}
      </header>
      <main className={`mx-auto flex w-full flex-1 flex-col px-6 pb-16 ${wide ? 'max-w-[960px]' : 'max-w-[420px] justify-center'}`}>
        {children}
      </main>
    </div>
  );
}
