import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Shell } from '../shell';

/**
 * The one thing a visitor without access can do. Three fields and a bot check; the
 * answer is the same sentence whatever they type, so this page is not a way to learn
 * who deals with Protect24x7. Nothing they enter becomes a record until someone inside
 * matches it to a contact sales created.
 */
const DONE = 'Thanks. If your details match a company we work with, someone will be in touch.';

declare global {
  interface Window { turnstile?: { render: (el: HTMLElement, opts: { sitekey: string; theme?: string; callback: (token: string) => void; 'expired-callback'?: () => void }) => string } }
}

export default function RequestAccess() {
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [note, setNote] = useState('');
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const widget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/access-requests/config').then((r) => r.json()).then((c: { turnstileSiteKey: string | null }) => setSiteKey(c.turnstileSiteKey)).catch(() => setSiteKey(null));
  }, []);

  // Load Turnstile only when a key is configured; render into our own box.
  useEffect(() => {
    if (!siteKey || !widget.current) return;
    const mount = () => { if (window.turnstile && widget.current) window.turnstile.render(widget.current, { sitekey: siteKey, theme: 'dark', callback: setToken, 'expired-callback': () => setToken(null) }); };
    if (window.turnstile) { mount(); return; }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true; s.onload = mount;
    document.head.appendChild(s);
  }, [siteKey]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await fetch('/api/access-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, company, note: note || undefined, turnstileToken: token ?? undefined }) });
    } catch { /* the answer is the same either way */ }
    setDone(true); setBusy(false);
  };

  if (done) {
    return (
      <Shell>
        <h1 className="text-[28px] font-bold leading-none">Request received</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-[var(--muted)]">{DONE}</p>
        <p className="mt-8 text-[12px] text-[var(--muted)]"><Link to="/sign-in" className="underline underline-offset-4">Back to sign-in</Link></p>
      </Shell>
    );
  }

  const field = 'border border-[var(--line)] bg-transparent px-3 py-2.5 text-[15px] normal-case tracking-normal text-[var(--ink)] outline-none focus:border-[var(--red)]';
  return (
    <Shell>
      <h1 className="text-[28px] font-bold leading-none">Request access</h1>
      <p className="mt-2 text-[13px] text-[var(--muted)]">For partners and customers of Protect24x7. Use your work email — the one we already have on file.</p>
      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">Work email
          <input type="email" required maxLength={200} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={field} /></label>
        <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">Company
          <input type="text" required maxLength={200} autoComplete="organization" value={company} onChange={(e) => setCompany(e.target.value)} className={field} /></label>
        <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">Anything we should know (optional)
          <textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} className={field} /></label>
        {siteKey ? <div ref={widget} className="min-h-[65px]" /> : null}
        <button type="submit" disabled={busy || (Boolean(siteKey) && !token)} className="mt-2 bg-[var(--red)] px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.15em] text-white hover:bg-[var(--red-hover)] disabled:opacity-50">
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </form>
      <p className="mt-10 text-[11px] leading-relaxed text-[var(--muted)]">Already have access? <Link to="/sign-in" className="underline underline-offset-4">Sign in</Link>.</p>
    </Shell>
  );
}
