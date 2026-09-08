/** Tiny fetch wrapper. Same-origin, cookie-carrying; every error is a plain message. */
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/portal${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? `Request failed (${res.status})`));
  return data as T;
}

export interface Me {
  name: string;
  role?: 'admin' | 'member';
  email: string;
  account: { name: string; type: 'PARTNER' | 'CUSTOMER' };
  /** Present when a Protect24x7 admin is previewing the portal as this person. */
  viewingAs?: string;
}

export interface Branding {
  companyName: string;
  logo: string | null;
  accountLogo: string | null;
  welcome: string;
  banner: string | null;
  contact: string;
}
