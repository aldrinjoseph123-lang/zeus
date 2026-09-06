import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp, limit } from '../lib/http.js';
import { recordAccessRequest, turnstileConfig, verifyTurnstile } from '../portal/requests.js';

/**
 * The portal's request-access form, from the public side. Two routes, both open, both
 * outside /api/portal/ so that prefix stays read-only. The answer to a request is the
 * same sentence for every address — known, unknown, already granted, or nonsense.
 */
const NEUTRAL = { ok: true, message: 'Thanks. If your details match a company we work with, someone will be in touch.' };

export default async function accessRequestRoutes(app: FastifyInstance): Promise<void> {
  /** The Turnstile site key, so the form can render the widget when it is configured. */
  app.get('/api/access-requests/config', async () => {
    const { siteKey, configured } = await turnstileConfig();
    return { turnstileSiteKey: configured ? siteKey : null };
  });

  app.post('/api/access-requests', { config: limit(5, '1 hour') }, async (request) => {
    const parsed = z.object({
      email: z.string().email().max(200),
      company: z.string().trim().min(1).max(200),
      note: z.string().max(500).optional(),
      turnstileToken: z.string().max(4000).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return NEUTRAL;

    const ip = clientIp(request) || null;
    const { configured } = await turnstileConfig();
    if (configured && !(await verifyTurnstile(parsed.data.turnstileToken ?? '', ip))) return NEUTRAL;

    await recordAccessRequest({ ...parsed.data, ip });
    return NEUTRAL;
  });
}
