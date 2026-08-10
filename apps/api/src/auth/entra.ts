import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHmac, randomBytes } from 'node:crypto';
import { env } from '../env.js';
import { getM365 } from '../services/graph.js';

/**
 * Interactive Microsoft sign-in (authorization code flow) on the same app
 * registration used for the tenant integration. No MSAL dependency — the flow is
 * three fetches and one JWKS verification.
 */

const REDIRECT_PATH = '/api/auth/microsoft/callback';
export const redirectUri = (): string => `${env.APP_URL.replace(/\/$/, '')}${REDIRECT_PATH}`;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(tenantId: string) {
  let set = jwksCache.get(tenantId);
  if (!set) {
    set = createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`));
    jwksCache.set(tenantId, set);
  }
  return set;
}


/** State is HMAC-signed rather than stored server-side — stateless CSRF protection. */
function signState(nextPath = '/'): string {
  const nonce = randomBytes(12).toString('hex');
  const payload = `${nonce}|${Date.now()}|${nextPath}`;
  const mac = createHmac('sha256', env.APP_SECRET).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

export function verifyState(state: string | undefined): { ok: boolean; nextPath: string } {
  if (!state) return { ok: false, nextPath: '/' };
  const [payloadB64, mac] = state.split('.');
  if (!payloadB64 || !mac) return { ok: false, nextPath: '/' };
  const payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  const expected = createHmac('sha256', env.APP_SECRET).update(payload).digest('base64url');
  if (mac !== expected) return { ok: false, nextPath: '/' };
  const [, tsRaw, nextPath = '/'] = payload.split('|');
  if (Date.now() - Number(tsRaw) > 10 * 60 * 1000) return { ok: false, nextPath: '/' };
  return { ok: true, nextPath };
}

export async function authorizeUrl(nextPath = '/'): Promise<string> {
  const m365 = await getM365();
  if (!m365) throw new Error('Microsoft 365 is not configured.');
  const params = new URLSearchParams({
    client_id: m365.config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: 'openid profile email offline_access User.Read',
    state: signState(nextPath),
    prompt: 'select_account',
  });
  return `https://login.microsoftonline.com/${m365.config.tenantId}/oauth2/v2.0/authorize?${params}`;
}

/** One-click admin consent link for the tenant-wide application permissions. */
export async function adminConsentUrl(): Promise<string> {
  const m365 = await getM365();
  if (!m365) throw new Error('Microsoft 365 is not configured.');
  const params = new URLSearchParams({
    client_id: m365.config.clientId,
    // v2.0 adminconsent requires scope; .default consents to all app permissions on the registration.
    scope: 'https://graph.microsoft.com/.default',
    redirect_uri: `${env.APP_URL.replace(/\/$/, '')}/api/auth/microsoft/consent-callback`,
    state: signState('/settings/integrations'),
  });
  return `https://login.microsoftonline.com/${m365.config.tenantId}/v2.0/adminconsent?${params}`;
}

export interface EntraProfile {
  oid: string;
  email: string;
  name: string;
  tenantId: string;
}

export async function exchangeCode(code: string): Promise<EntraProfile> {
  const m365 = await getM365();
  if (!m365?.secrets?.clientSecret) throw new Error('Microsoft 365 client secret is missing.');

  const res = await fetch(`https://login.microsoftonline.com/${m365.config.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: m365.config.clientId,
      client_secret: m365.secrets.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      scope: 'openid profile email offline_access User.Read',
    }),
  });
  const json = (await res.json()) as { id_token?: string; error_description?: string };
  if (!res.ok || !json.id_token) throw new Error(json.error_description ?? `Token exchange failed (${res.status})`);

  const { payload } = await jwtVerify(json.id_token, jwks(m365.config.tenantId), {
    audience: m365.config.clientId,
    issuer: `https://login.microsoftonline.com/${m365.config.tenantId}/v2.0`,
  });

  const email = (payload.preferred_username ?? payload.email ?? '') as string;
  if (!email) throw new Error('Microsoft did not return an email address for this account.');

  return {
    oid: payload.oid as string,
    email: email.toLowerCase(),
    name: (payload.name as string) ?? email,
    tenantId: payload.tid as string,
  };
}
