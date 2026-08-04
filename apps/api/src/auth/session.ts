import { SignJWT, jwtVerify } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, isProd } from '../env.js';
import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';
import type { PermissionMap, SessionUser } from './rbac.js';

const COOKIE_NAME = 'zeus_session';
const secret = new TextEncoder().encode(env.APP_SECRET);

/**
 * The signed session token. Exported so the integration suite can mint a cookie for a
 * fixture user without driving the login endpoint — logging four users in per test
 * would otherwise trip the login rate limit, which is a control worth keeping on.
 */
export async function signSessionToken(userId: string, hours: number): Promise<string> {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer('zeus')
    .setExpirationTime(`${hours}h`)
    .sign(secret);
}

export const SESSION_COOKIE = COOKIE_NAME;

export async function issueSession(reply: FastifyReply, userId: string): Promise<void> {
  const hours = Number(await getSetting<number>('auth.sessionHours', 12));
  const token = await signSessionToken(userId, hours);

  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/',
    maxAge: hours * 3600,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

async function userIdFromRequest(request: FastifyRequest): Promise<string | null> {
  const token = request.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: 'zeus' });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function loadSessionUser(request: FastifyRequest): Promise<SessionUser | null> {
  const userId = await userIdFromRequest(request);
  if (!userId) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });
  if (!user || !user.isActive) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roleId: user.roleId,
    roleName: user.role.name,
    teamId: user.teamId,
    permissions: user.role.permissions as unknown as PermissionMap,
  };
}
