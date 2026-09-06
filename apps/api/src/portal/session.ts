import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { getSetting } from '../lib/settings.js';

/**
 * The portal's own session cookie. Same signing secret as the internal app but a
 * different cookie name and a different JWT issuer, so an internal session can never
 * be presented as a portal one or the other way round — even by accident on a shared
 * hostname. Secure follows PORTAL_URL's scheme, exactly as the internal cookie follows
 * APP_URL's.
 */
export const PORTAL_COOKIE = 'zeus_portal';
const ISSUER = 'zeus-portal';
const secret = new TextEncoder().encode(env.APP_SECRET);

export async function signPortalToken(portalUserId: string, minutes: number): Promise<string> {
  return new SignJWT({ sub: portalUserId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(`${minutes}m`)
    .sign(secret);
}

export async function issuePortalSession(reply: FastifyReply, portalUserId: string): Promise<void> {
  const minutes = Number(await getSetting<number>('portal.session.idleMinutes', 1440));
  const token = await signPortalToken(portalUserId, minutes);
  reply.setCookie(PORTAL_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.PORTAL_URL.startsWith('https://'),
    path: '/',
    maxAge: minutes * 60,
  });
}

export function clearPortalSession(reply: FastifyReply): void {
  reply.clearCookie(PORTAL_COOKIE, { path: '/' });
}

export async function portalUserIdFromRequest(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies?.[PORTAL_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}
