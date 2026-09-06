import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { Shell } from '../shell';

/** Landing for an admin's "View as" link from Settings. Exchanges the two-minute token once. */
export default function ViewAs() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token') ?? '';
    api('POST', '/auth/view-as', { token })
      .then(() => navigate('/', { replace: true }))
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : 'Could not open the preview.'));
  }, [params, navigate]);

  return (
    <Shell>
      {error ? (
        <>
          <h1 className="text-[28px] font-bold leading-none">Preview not available</h1>
          <p className="mt-3 text-[13px] text-[var(--muted)]">{error}</p>
          <p className="mt-6 text-[12px] text-[var(--muted)]"><Link to="/sign-in" className="underline underline-offset-4">Go to sign-in</Link></p>
        </>
      ) : (
        <p className="text-[var(--muted)]">Opening the preview…</p>
      )}
    </Shell>
  );
}
