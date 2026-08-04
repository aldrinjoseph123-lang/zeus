/** Thin fetch wrapper. Cookies carry the session, so nothing here touches tokens. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path.startsWith('/api') ? path : `/api${path}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError(401, 'Sign in required.');
  }

  const isJson = res.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const message = typeof payload === 'object' && payload && 'error' in payload ? String(payload.error) : `Request failed (${res.status})`;
    throw new ApiError(res.status, message, typeof payload === 'object' && payload && 'details' in payload ? payload.details : undefined);
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

/** Build a query string, dropping empty values so the URL stays readable. */
export function qs(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, String(value));
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

/** Trigger a browser download for an export endpoint. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(path.startsWith('/api') ? path : `/api${path}`, { credentials: 'include' });
  if (!res.ok) {
    const detail = res.headers.get('content-type')?.includes('json') ? (await res.json()).error : `Download failed (${res.status})`;
    throw new ApiError(res.status, detail);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const name = /filename="?([^"]+)"?/.exec(disposition)?.[1] ?? fallbackName;

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
