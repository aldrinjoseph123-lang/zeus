import type { FastifyInstance } from 'fastify';
import { getSetting } from '../lib/settings.js';
import { portalClaimsFromRequest } from './session.js';
import { resolvePortalSession, type PortalSession } from './access.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the portal gate for every request under /api/portal/ that is not an auth route. */
    portal: PortalSession;
  }
}

/**
 * One gate for everything under /api/portal/, independent of the internal one.
 *
 *   - Kill switch first: portal.enabled off → 503 for every portal call, auth included.
 *     The one exception is an admin's "view as" preview, so the portal can be set up and
 *     looked at before it is switched on for outsiders.
 *   - /api/portal/auth/* are the only routes an outsider may POST to, each rate-limited.
 *   - Everything else is read-only by construction: any non-GET is 405 before a route
 *     runs. Lifting that later is a deliberate act, one route at a time.
 *   - A session is resolved fresh on every request, so revocation is immediate.
 */
export function registerPortalGate(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/portal/')) return;

    const claims = await portalClaimsFromRequest(request);
    const previewing = Boolean(claims?.viewingAs) || path === '/api/portal/auth/view-as';
    if (!previewing && !(await getSetting<boolean>('portal.enabled', false))) {
      return reply.status(503).send({ error: 'The portal is not available right now.' });
    }
    if (path.startsWith('/api/portal/auth/')) return;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.status(405).send({ error: 'The portal is read-only.' });
    }

    const session = claims ? await resolvePortalSession(claims.portalUserId, claims.viewingAs) : null;
    if (!session) return reply.status(401).send({ error: 'Sign in required.' });
    request.portal = session;
  });
}
