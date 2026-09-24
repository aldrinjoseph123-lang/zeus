import type { FastifyRequest } from 'fastify';
import { sessionIdFromRequest } from './session.js';
import { portalSidFromRequest } from '../portal/session.js';

/**
 * What the rate limit counts against.
 *
 * The office shares one public address, so a limit keyed on the address is one budget for
 * everyone in it — a colleague's search spends yours, and the 429 lands on whoever clicks
 * next. A signed-in person is keyed on their session instead, a portal visitor on theirs.
 * Only anonymous traffic — the sign-in form, a stranger — shares the address's budget,
 * which is where a limit on strangers belongs. The token is verified, not merely read, so
 * an invented cookie is still a stranger.
 */
export async function rateLimitKey(request: FastifyRequest): Promise<string> {
  const sid = await sessionIdFromRequest(request);
  if (sid) return `session:${sid}`;
  const portal = await portalSidFromRequest(request);
  if (portal) return `portal:${portal}`;
  return `ip:${request.ip}`;
}
