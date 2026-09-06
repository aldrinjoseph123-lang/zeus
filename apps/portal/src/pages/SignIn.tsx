import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Shell } from '../shell';

const NEUTRAL = 'If your email is registered with us, you will receive a link shortly.';

/**
 * Email first, then password. Whatever the address is — partner, customer, contact
 * without access, nonsense — the password step looks the same and a wrong answer
 * reads the same, so the sign-in page is not a directory of who deals with us.
 */
export default function SignIn() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<'email' | 'password'>('email');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (step === 'email') { setStep('password'); return; }
    setBusy(true);
    try {
      await api('POST', '/auth/login', { email, password });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status !== 503 ? 'Email or password is incorrect.' : 'The portal is not available right now.');
    } finally {
      setBusy(false);
    }
  };

  const requestLink = async () => {
    setBusy(true); setError(null);
    try { await api('POST', '/auth/link', { email }); } catch { /* same message either way */ }
    setNotice(NEUTRAL);
    setBusy(false);
  };

  return (
    <Shell>
      <h1 className="text-[28px] font-bold leading-none">Sign in</h1>
      <p className="mt-2 text-[13px] text-[var(--muted)]">Use the email address Protect24x7 has on file for you.</p>

      <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">
          Email
          <input
            type="email" required autoFocus autoComplete="username" value={email}
            onChange={(e) => { setEmail(e.target.value); setStep('email'); setNotice(null); }}
            className="border border-[var(--line)] bg-transparent px-3 py-2.5 text-[15px] normal-case tracking-normal text-[var(--ink)] outline-none focus:border-[var(--red)]"
          />
        </label>

        {step === 'password' ? (
          <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.15em] text-[var(--muted)]">
            Password
            <input
              type="password" required autoFocus autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="border border-[var(--line)] bg-transparent px-3 py-2.5 text-[15px] normal-case tracking-normal text-[var(--ink)] outline-none focus:border-[var(--red)]"
            />
          </label>
        ) : null}

        {error ? <p role="alert" className="text-[13px] text-[var(--red)]">{error}</p> : null}
        {notice ? <p role="status" className="text-[13px] text-[var(--secure)]">{notice}</p> : null}

        <button type="submit" disabled={busy || !email} className="mt-2 bg-[var(--red)] px-4 py-3 text-[13px] font-semibold uppercase tracking-[0.15em] text-white hover:bg-[var(--red-hover)] disabled:opacity-50">
          {step === 'email' ? 'Continue' : busy ? 'Signing in…' : 'Sign in'}
        </button>

        {step === 'password' ? (
          <button type="button" onClick={requestLink} disabled={busy || !email} className="text-[12px] text-[var(--muted)] underline underline-offset-4 hover:text-[var(--ink)]">
            First time here, or forgot your password? Email me a link.
          </button>
        ) : null}
      </form>

      <p className="mt-10 text-[11px] leading-relaxed text-[var(--muted)]">
        There is no sign-up. Access is arranged by your Protect24x7 contact — or <Link to="/request-access" className="underline underline-offset-4">ask for it here</Link>. We never ask for this password anywhere but here.
      </p>
    </Shell>
  );
}
