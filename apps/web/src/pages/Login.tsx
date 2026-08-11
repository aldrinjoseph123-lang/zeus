import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Button, ErrorNote, Field, Input, Loading } from '../components/ui';

export default function Login() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = params.get('next') ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(params.get('error'));
  const [busy, setBusy] = useState(false);

  /** Set once the password is accepted and a second factor is owed. */
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');

  const { data: config, isLoading, error: configError } = useQuery({
    queryKey: ['auth-config'],
    queryFn: () => api.get<{ localLogin: boolean; microsoftLogin: boolean; productName: string }>('/auth/config'),
  });

  // Already signed in? Skip the form.
  useEffect(() => {
    api.get('/auth/me').then(() => navigate(next, { replace: true })).catch(() => {});
  }, [navigate, next]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ ok: boolean; twoFactorRequired?: boolean; challenge?: string }>(
        '/auth/login', { email, password },
      );
      // The password was right but it is not a session yet.
      if (result.twoFactorRequired && result.challenge) {
        setChallenge(result.challenge);
        return;
      }
      navigate(next, { replace: true });
      location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/2fa/verify', { challenge, code: code.trim() });
      navigate(next, { replace: true });
      location.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That code was not accepted.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full lg:grid-cols-2">
      {/* Brand panel — the hero treatment from the Protect24x7 site. */}
      <div className="hatch relative hidden flex-col justify-between bg-n950 p-10 text-white lg:flex">
        <div className="flex items-center gap-2">
          <span className="text-[22px] font-bold tracking-[0.22em]">ZEUS</span>
          <span className="text-[22px] font-bold leading-none text-accent">.</span>
        </div>

        <div>
          <p className="eyebrow text-accent">Dubai Silicon Oasis · UAE</p>
          <h1 className="mt-3 text-[42px] font-bold leading-[1.05]">
            Revenue,
            <br />
            under watch.
          </h1>
          <p className="mt-4 max-w-sm text-[14px] leading-relaxed text-n400">
            Every lead, deal, quote and partner registration in one place — with the pipeline
            maths already done for you.
          </p>
          <div className="mt-8 grid max-w-sm grid-cols-3 gap-3 border-t border-n800 pt-6">
            {[
              ['AED', 'Dirhams, 5% VAT'],
              ['RBAC', 'Role-scoped data'],
              ['M365', 'Teams & Outlook'],
            ].map(([big, small]) => (
              <div key={big}>
                <p className="text-[18px] font-bold">{big}</p>
                <p className="mt-0.5 text-[10px] uppercase tracking-[0.1em] text-n500">{small}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="text-[10px] uppercase tracking-[0.14em] text-n600">Protect24x7 · Internal system</p>
      </div>

      {/* Form panel */}
      <div className="flex items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 lg:hidden">
            <span className="text-[22px] font-bold tracking-[0.22em]">ZEUS</span>
            <span className="text-[22px] font-bold text-accent">.</span>
          </div>

          <h2 className="text-[18px] font-bold uppercase tracking-[0.1em]">Sign in</h2>
          <p className="mt-1 text-[13px] text-muted">Use your Protect24x7 account.</p>

          {isLoading ? (
            <Loading label="Checking sign-in options" />
          ) : (
            <div className="mt-6 space-y-4">
              {error ? <ErrorNote error={error} /> : null}

              {config?.microsoftLogin ? (
                <>
                  <a
                    href={`/api/auth/microsoft/start?next=${encodeURIComponent(next)}`}
                    className="flex w-full items-center justify-center gap-2.5 rounded-sharp border border-n900 bg-card px-4 py-2.5 text-[12px] font-semibold uppercase tracking-[0.08em] transition-colors hover:bg-n50"
                  >
                    <svg width="15" height="15" viewBox="0 0 23 23" aria-hidden="true">
                      <path fill="#f35325" d="M1 1h10v10H1z" />
                      <path fill="#81bc06" d="M12 1h10v10H12z" />
                      <path fill="#05a6f0" d="M1 12h10v10H1z" />
                      <path fill="#ffba08" d="M12 12h10v10H12z" />
                    </svg>
                    Continue with Microsoft
                  </a>

                  {config.localLogin ? (
                    <div className="flex items-center gap-3">
                      <span className="h-px flex-1 bg-line" />
                      <span className="text-[10px] uppercase tracking-[0.14em] text-n400">or</span>
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  ) : null}
                </>
              ) : null}

              {challenge ? (
                <form onSubmit={submitCode} className="space-y-3">
                  <p className="text-[13px] leading-relaxed text-n600">
                    Enter the six-digit code from your authenticator app. If you have lost your
                    phone, one of your recovery codes works instead — each one only once.
                  </p>
                  <Field label="Code">
                    <Input
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      // A phone keypad for the common case, and the browser's own
                      // one-time-code autofill where the platform offers it.
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                      required
                      autoFocus
                    />
                  </Field>
                  <Button type="submit" variant="accent" loading={busy} className="w-full">
                    Verify
                  </Button>
                  <button
                    type="button"
                    onClick={() => { setChallenge(null); setCode(''); setError(null); setPassword(''); }}
                    className="w-full text-[12px] text-muted underline decoration-dotted underline-offset-2 hover:text-ink"
                  >
                    Start again
                  </button>
                </form>
              ) : config?.localLogin ? (
                <form onSubmit={submit} className="space-y-3">
                  <Field label="Email">
                    <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
                  </Field>
                  <Field label="Password">
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                  </Field>
                  <Button type="submit" variant="accent" loading={busy} className="w-full">
                    Sign in
                  </Button>
                </form>
              ) : null}

              {configError ? (
                // An unreachable API reads as "no sign-in methods" if you only look at
                // the payload, which sends people hunting for a setting that is fine.
                <ErrorNote error="Zeus cannot reach its server. The API or the database is down — sign-in settings are not the problem. Start them and reload." />
              ) : config && !config.localLogin && !config.microsoftLogin ? (
                <ErrorNote error="No sign-in method is enabled. An administrator must re-enable password sign-in on the server." />
              ) : null}

              <p className="flex items-center gap-1.5 pt-2 text-[11px] text-muted">
                <ShieldCheck size={13} className="text-secure" />
                Sessions are cookie-based and expire automatically.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
