import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ApiError, type Me } from './api';
import { MeProvider, Shell } from './shell';
import SignIn from './pages/SignIn';
import SetPassword from './pages/SetPassword';
import Home from './pages/Home';
import ViewAs from './pages/ViewAs';

/**
 * Three screens. Sign-in (email, then password, with "first time / forgot" that only
 * ever says "check your inbox"), set-password (opened from the emailed link), and the
 * signed-in home. Anything else lands on sign-in. There is no sign-up: access is
 * granted by the company, from inside Zeus.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/set-password" element={<SetPassword />} />
      <Route path="/view-as" element={<ViewAs />} />
      <Route path="/" element={<RequireSession><Home /></RequireSession>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Resolves /me once; 401 sends the visitor to sign-in, 503 says the portal is off. */
function RequireSession({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<{ me?: Me; off?: boolean }>({});

  useEffect(() => {
    api<Me>('GET', '/me')
      .then((me) => setState({ me }))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 503) setState({ off: true });
        else navigate('/sign-in', { replace: true });
      });
  }, [navigate]);

  if (state.off) return <Shell><p className="text-[var(--muted)]">The portal is not available right now. Please try again later.</p></Shell>;
  if (!state.me) return <Shell><p className="text-[var(--muted)]">Loading…</p></Shell>;
  return <MeProvider me={state.me}>{children}</MeProvider>;
}
