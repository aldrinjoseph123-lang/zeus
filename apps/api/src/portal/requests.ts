import { prisma } from '../db.js';
import { decryptJson, encryptJson } from '../lib/crypto.js';
import { notify } from '../services/notify.js';
import { logSystem } from '../services/systemLog.js';

/**
 * Request access — the portal's only unauthenticated write.
 *
 * Lives outside /api/portal/ so that prefix stays read-only for everyone. Writes to a
 * quarantine table, never to Contact or Account: a stranger's typed company name must
 * not become an Account by way of a convenience button. The caller answers every
 * request identically, whatever the address is; the only thing that varies is whether
 * a row lands in the admin's queue.
 *
 * Cloudflare Turnstile is optional. When a site key and secret are stored, a request
 * without a valid token is dropped silently — same neutral answer, no row.
 */

export interface TurnstileConfig { siteKey: string | null; configured: boolean }

export async function turnstileConfig(): Promise<TurnstileConfig> {
  const row = await prisma.integration.findUnique({ where: { provider: 'turnstile' } });
  const siteKey = (row?.config as { siteKey?: string } | null)?.siteKey ?? null;
  const secret = decryptJson<{ secret: string }>(row?.secrets)?.secret ?? null;
  return { siteKey: siteKey || null, configured: Boolean(siteKey && secret) };
}

export async function saveTurnstile(siteKey: string, secret?: string): Promise<void> {
  const existing = await prisma.integration.findUnique({ where: { provider: 'turnstile' } });
  const secrets = secret ? encryptJson({ secret }) : existing?.secrets ?? null;
  await prisma.integration.upsert({
    where: { provider: 'turnstile' },
    create: { provider: 'turnstile', config: { siteKey }, secrets, status: 'configured' },
    update: { config: { siteKey }, secrets },
  });
}

/**
 * Three outcomes, not two.
 *
 * "Cloudflare said no" and "Cloudflare could not be reached" are different facts, and
 * treating them the same is how a bot check locks the staff out of their own CRM during
 * somebody else's outage. A rejection is refused; an outage is allowed through and
 * logged, because the password, the lockout and the rate limit are all still standing
 * behind it.
 */
export type TurnstileResult = 'ok' | 'rejected' | 'unavailable' | 'not-configured';

/** Server-side check with Cloudflare. Injectable so the tests never leave the machine. */
export async function verifyTurnstile(token: string, ip: string | null, fetchImpl: typeof fetch = fetch): Promise<TurnstileResult> {
  const row = await prisma.integration.findUnique({ where: { provider: 'turnstile' } });
  const secret = decryptJson<{ secret: string }>(row?.secrets)?.secret;
  if (!secret) return 'not-configured';
  // No token at all is a rejection, not an outage — nothing was even attempted.
  if (!token) return 'rejected';
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    // "Unreachable" covers a refusal to answer as much as a silence — say which, or
    // the alert leaves you guessing between an outage and our own probe being throttled.
    if (!res.ok) {
      logSystem('warn', 'auth', `Turnstile siteverify answered HTTP ${res.status} — treating the bot check as unavailable`);
      return 'unavailable';
    }
    const body = (await res.json()) as { success?: boolean };
    return body.success === true ? 'ok' : 'rejected';
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    logSystem('warn', 'auth', `Turnstile siteverify could not be reached (${why}) — treating the bot check as unavailable`);
    return 'unavailable';
  }
}

const DEDUPE_HOURS = 24;

/**
 * Store the request unless the same address already asked in the last day. Returns
 * nothing on purpose: the route's answer must not depend on what happened here.
 */
export async function recordAccessRequest(input: { email: string; company: string; note?: string | null; ip: string | null }): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const recent = await prisma.accessRequest.findFirst({ where: { email, createdAt: { gt: new Date(Date.now() - DEDUPE_HOURS * 3_600_000) } } });
  if (recent) return;
  const row = await prisma.accessRequest.create({ data: { email, company: input.company.trim().slice(0, 200), note: input.note?.trim().slice(0, 500) || null, ip: input.ip } });
  await notify({
    event: 'portal_access_requested',
    title: `Portal access requested — ${row.company}`,
    body: `${row.email}${row.note ? ` · “${row.note.slice(0, 120)}”` : ''}`,
    link: '/settings/portal',
    severity: 'info',
    facts: [{ title: 'Email', value: row.email }, { title: 'Company', value: row.company }],
  });
}
