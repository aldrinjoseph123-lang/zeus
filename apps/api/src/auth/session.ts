import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';
import type { PermissionMap, SessionUser } from './rbac.js';
import { createSession, sessionIsLive } from './sessionStore.js';

const COOKIE_NAME = 'zeus_session';
const secret = new TextEncoder().encode(env.APP_SECRET);

/**
 * The signed session token. Exported so the integration suite can mint a cookie for a
 * fixture user without driving the login endpoint — logging four users in per test
 * would otherwise trip the login rate limit, which is a control worth keeping on.
 */
export async function signSessionToken(userId: string, hours: number, sid?: string): Promise<string> {
  return new SignJWT({ sub: userId, ...(sid ? { sid } : {}) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('zeus')
    .setExpirationTime(`${hours}h`)
    .sign(secret);
}

export const SESSION_COOKIE = COOKIE_NAME;

export async function issueSession(reply: FastifyReply, userId: string, request?: FastifyRequest): Promise<void> {
  const hours = Number(await getSetting<number>('auth.sessionHours', 12));
  // The row comes first: its id travels in the token, and every later request checks it.
  const sid = await createSession({ kind: 'internal', userId, expiresAt: new Date(Date.now() + hours * 3_600_000), request });
  const token = await signSessionToken(userId, hours, sid);

  // Secure follows the scheme the browser is actually on, not NODE_ENV. A production
  // install on plain HTTP (the documented LAN mode, ZEUS_DOMAIN=:80) used to issue a
  // Secure cookie the browser silently refused: login 200, every request after 401.
  const secure = env.APP_URL.startsWith('https://');
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: hours * 3600,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

/** The session id this request is carrying, if it has a valid cookie. */
export async function sessionIdFromRequest(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: 'zeus' });
    return typeof payload.sid === 'string' ? payload.sid : null;
  } catch {
    return null;
  }
}

async function userIdFromRequest(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: 'zeus' });
    if (typeof payload.sub !== 'string') return null;
    // A token minted before sessions existed carries no sid. It is honoured until it
    // expires rather than throwing everyone out mid-shift on the deploy that adds this;
    // the next sign-in gets a row. Once one is present it must still be live.
    if (typeof payload.sid === 'string' && !(await sessionIsLive(payload.sid))) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/** Same shape a cookie resolves to, built directly from a user id — for background
 * jobs (a scheduled report, say) that have no request to read a cookie from. */
export async function sessionUserById(userId: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user || !user.isActive) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roleId: user.roleId,
    roleName: user.role.name,
    teamId: user.teamId,
    permissions: user.role.permissions as unknown as PermissionMap,
    totpEnabledAt: user.totpEnabledAt,
  };
}

export async function loadSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  const userId = await userIdFromRequest(request);
  if (!userId) return null;
  return sessionUserById(userId);
}
