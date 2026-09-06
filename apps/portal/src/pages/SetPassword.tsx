import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Shell } from '../shell';

/** Opened from the emailed link. The token in the URL is single-use and expires. */
export default function SetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      await api('POST', '/auth/set-password', { token, password });
      navigate('/sign-in', { replace: true, state: { justSet: true } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try the link again.');
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <Shell>
        <h1 className="text-[28px] font-bold leading-none">This link is incomplete</h1>
        <p className="mt-3 text-[13px] text-[var(--muted)]">Open the link from your email again, or <Link to="/sign-in" className="underline underline-offset-4">ask for a new one</Link>.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="text-[28px] font-bold leading-none">Choose a password</h1>
      <p className="mt-2 text-[13px] text-[var(--muted)]">At least 12 characters. A sentence you will remember beats a word you will forget.</p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">
          New password
          <input type="password" required minLength={12} autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="border border-[var(--line)] bg-transparent px-3 py-2.5 text-[15px] normal-case tracking-normal text-[var(--ink)] outline-none focus:border-[var(--red)]" />
        </label>
        <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">
          Again
          <input type="password" required minLength={12} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            className="border border-[var(--line)] bg-transparent px-3 py-2.5 text-[15px] normal-case tracking-normal text-[var(--ink)] outline-none focus:border-[var(--red)]" />
        </label>
        {error ? <p role="alert" className="text-[13px] text-[var(--red)]">{error}</p> : null}
        <button type="submit" disabled={busy} className="mt-2 bg-[var(--red)] px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.15em] text-white hover:bg-[var(--red-hover)] disabled:opacity-50">
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </Shell>
  );
}
