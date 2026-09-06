import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp } from '../lib/http.js';
import { loginWithPassword, requestLink, setPasswordFromLink } from '../portal/auth.js';
import { clearPortalSession, issuePortalSession } from '../portal/session.js';

/**
 * What an outsider can call. Auth routes are the only writes; everything else is a
 * GET scoped to the account on the session, serialised through an explicit allowlist,
 * and logged. Phase 1 ships the auth surface and /me; the partner and customer views
 * arrive in later phases.
 */
const NEUTRAL = { ok: true, message: 'If your email is registered with us, you will receive a link shortly.' };

export default async function portalRoutes(app: FastifyInstance): Promise<void> {
  // ── auth ────────────────────────────────────────────────────────────────────

  /** First time or forgot: same answer whatever the address is. */
  app.post('/api/portal/auth/link', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async (request) => {
    const parsed = z.object({ email: z.string().email() }).safeParse(request.body);
    if (parsed.success) await requestLink(parsed.data.email);
    return NEUTRAL;
  });

  app.post('/api/portal/auth/set-password', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (request) => {
    const parsed = z.object({ token: z.string().min(32), password: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) throw badRequest('This link is not valid any more. Ask for a new one from the sign-in page.');
    const result = await setPasswordFromLink(parsed.data.token, parsed.data.password);
    if (!result.ok) throw badRequest(result.reason);
    return { ok: true };
  });

  app.post('/api/portal/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const parsed = z.object({ email: z.string().email(), password: z.string().min(1) }).safeParse(request.body);
    // Wrong shape, wrong password, unknown address, locked out: one answer.
    const result = parsed.success ? await loginWithPassword(parsed.data.email, parsed.data.password) : ({ ok: false } as const);
    if (!result.ok) return reply.status(401).send({ error: 'Email or password is incorrect.' });
    await issuePortalSession(reply, result.portalUserId);
    await audit({ user: null, action: 'login', entity: 'PortalUser', entityId: result.portalUserId, summary: `portal sign-in ${parsed.success ? parsed.data.email : ''}`, ip: clientIp(request) });
    return { ok: true };
  });

  app.post('/api/portal/auth/logout', async (_request, reply) => {
    clearPortalSession(reply);
    return { ok: true };
  });

  // ── the signed-in outsider ─────────────────────────────────────────────────

  app.get('/api/portal/me', async (request) => {
    const s = request.portal;
    await audit({ user: null, action: 'portal_read', entity: 'PortalUser', entityId: s.portalUserId, summary: `${s.email} · me`, ip: clientIp(request) });
    // Allowlist: what leaves is named here and nowhere else.
    return { name: s.name, email: s.email, account: { name: s.accountName, type: s.accountType } };
  });
}
