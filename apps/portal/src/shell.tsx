import type { ReactNode } from 'react';
import type { Me } from './api';
import { MeContext } from './me';

export function MeProvider({ me, children }: { me: Me; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

/** The one layout: wordmark top-left, content centred, nothing else. */
export function Shell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between px-6 py-5">
        <span className="text-[13px] font-bold uppercase tracking-[0.3em]">Protect24x7<span className="text-[var(--red)]">.</span></span>
        <span className="text-[11px] uppercase tracking-[0.2em] text-[var(--muted)]">Partner &amp; customer portal</span>
      </header>
      <main className={`mx-auto flex w-full flex-1 flex-col px-6 pb-16 ${wide ? 'max-w-[960px]' : 'max-w-[420px] justify-center'}`}>
        {children}
      </main>
    </div>
  );
}
