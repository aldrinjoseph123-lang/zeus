import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { getSetting } from '../lib/settings.js';
import { createSession, sessionIsLive } from '../auth/sessionStore.js';

/**
 * The portal's own session cookie. Same signing secret as the internal app but a
 * different cookie name and a different JWT issuer, so an internal session can never
 * be presented as a portal one or the other way round — even by accident on a shared
 * hostname. Secure follows PORTAL_URL's scheme, exactly as the internal cookie follows
 * APP_URL's.
 *
 * "View as": an admin previewing the portal as a contact gets a session that carries
 * the admin's identity in `act`. It is read-only like every portal session, short, and
 * every read it makes is logged against both names.
 */
export const PORTAL_COOKIE = 'zeus_portal';
const ISSUER = 'zeus-portal';
const VIEW_AS_ISSUER = 'zeus-portal-view-as';
const secret = new TextEncoder().encode(env.APP_SECRET);

export interface ViewingAs { userId: string; name: string }
export interface PortalClaims { portalUserId: string; viewingAs?: ViewingAs; sessionId?: string }

export async function signPortalToken(portalUserId: string, minutes: number, viewingAs?: ViewingAs, sid?: string): Promise<string> {
  const jwt = new SignJWT({ sub: portalUserId, ...(viewingAs ? { act: viewingAs } : {}), ...(sid ? { sid } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(`${minutes}m`);
  return jwt.sign(secret);
}

export async function issuePortalSession(reply: FastifyReply, portalUserId: string, viewingAs?: ViewingAs, request?: FastifyRequest): Promise<void> {
  // A preview is short by design; a real session runs to the configured idle time.
  const minutes = viewingAs ? 30 : Number(await getSetting<number>('portal.session.idleMinutes', 1440));
  // A preview is a session too — listed and revocable, attributed to the admin behind it.
  const sid = await createSession({
    kind: 'portal', portalUserId, viewingAsId: viewingAs?.userId,
    expiresAt: new Date(Date.now() + minutes * 60_000), request,
  });
  const token = await signPortalToken(portalUserId, minutes, viewingAs, sid);
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

export async function portalClaimsFromRequest(request: FastifyRequest): Promise<PortalClaims | null> {
  const token = request.cookies?.[PORTAL_COOKIE];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (typeof payload.sub !== 'string') return null;
    // As on the internal side: a token from before sessions existed still works until
    // it expires, but one carrying a session id must have a live row behind it.
    const sid = typeof payload.sid === 'string' ? payload.sid : undefined;
    if (sid && !(await sessionIsLive(sid))) return null;
    const act = payload.act as ViewingAs | undefined;
    return {
      portalUserId: payload.sub,
      viewingAs: act && typeof act.userId === 'string' ? { userId: act.userId, name: String(act.name ?? '') } : undefined,
      sessionId: sid,
    };
  } catch {
    return null;
  }
}

/** Hand-off from the internal app to the portal host: two minutes, one purpose. */
export async function signViewAsToken(portalUserId: string, admin: ViewingAs): Promise<string> {
  return new SignJWT({ sub: portalUserId, act: admin })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(VIEW_AS_ISSUER)
    .setExpirationTime('2m')
    .sign(secret);
}

export async function verifyViewAsToken(token: string): Promise<{ portalUserId: string; admin: ViewingAs } | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: VIEW_AS_ISSUER });
    const act = payload.act as ViewingAs | undefined;
    if (typeof payload.sub !== 'string' || !act || typeof act.userId !== 'string') return null;
    return { portalUserId: payload.sub, admin: { userId: act.userId, name: String(act.name ?? '') } };
  } catch {
    return null;
  }
}
