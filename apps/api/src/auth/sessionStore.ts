import type { FastifyRequest } from 'fastify';
import { prisma } from '../db.js';
import { whereFrom } from '../lib/whereFrom.js';
import { alertOnNewSignIn } from './loginAlerts.js';

/**
 * The session store: one row per sign-in, checked on every request.
 *
 * Before this existed a signed cookie was good until it expired, so "sign out" only
 * deleted the browser's copy — a stolen token kept working for its full life, and
 * deactivating someone left their open tabs signed in. The row is what makes revoking
 * real, and what makes a session listable.
 *
 * Two costs are kept small on purpose. The lookup is a primary-key read behind a
 * short in-process cache, so the common path rarely touches the database; and
 * `lastSeenAt` is written at most once every few minutes per session rather than on
 * every request, so an open tab does not turn reads into a write storm.
 */

export type SessionKind = 'internal' | 'portal';
export type RevokedBy = 'self' | 'admin' | 'password_change' | 'deactivated' | 'portal_revoked';

/** How long a resolved session is trusted from cache before the row is read again. */
const CACHE_MS = 60_000;
/** How stale lastSeenAt may get before a request bothers to write it. */
const TOUCH_MS = 5 * 60_000;

interface Cached { live: boolean; expiresAt: number; lastSeenAt: number; checkedAt: number }
const cache = new Map<string, Cached>();

/** Drop a session from the cache so the next request re-reads it — used the moment one is revoked. */
export function forgetCached(sessionId: string): void {
  cache.delete(sessionId);
}
export function clearSessionCache(): void {
  cache.clear();
}

/** A readable "Chrome on macOS" from the user agent — the same shape the login log uses. */
export function deviceFromUA(ua?: string): string {
  if (!ua) return 'Unknown device';
  const browser =
    /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox'
          : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os =
    /iPhone/.test(ua) ? 'iPhone'
      : /iPad/.test(ua) ? 'iPad'
        : /Android/.test(ua) ? 'Android'
          : /Windows/.test(ua) ? 'Windows'
            : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
              : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
  return `${browser} on ${os}`;
}

export interface CreateSessionInput {
  kind: SessionKind;
  userId?: string;
  portalUserId?: string;
  viewingAsId?: string;
  expiresAt: Date;
  request?: FastifyRequest;
}

/**
 * Record a sign-in and return the id that goes into the token.
 *
 * Where-from is resolved after the row exists, not before: behind Cloudflare it is
 * free, but the fallback is an external lookup, and nobody should wait on a third
 * party to finish signing in. A slow or unreachable provider leaves the location
 * blank on a row that is otherwise complete.
 */
export async function createSession(input: CreateSessionInput): Promise<string> {
  const request = input.request;
  const row = await prisma.session.create({
    data: {
      kind: input.kind,
      userId: input.userId ?? null,
      portalUserId: input.portalUserId ?? null,
      viewingAsId: input.viewingAsId ?? null,
      expiresAt: input.expiresAt,
      device: deviceFromUA(request?.headers['user-agent']),
    },
    select: { id: true },
  });

  if (request) {
    const settled = whereFrom(request)
      .then((w) => prisma.session.update({
        where: { id: row.id },
        data: { ip: w.ip, city: w.city, region: w.region, country: w.country, isp: w.isp },
      }))
      // Only once the place is known — judging "new country" before it lands would call
      // every sign-in unfamiliar.
      .then(() => alertOnNewSignIn(row.id))
      .catch(() => undefined);
    // Fire-and-forget in production: neither the lookup nor an alert may hold up the
    // door. Awaited under test, or the work outlives its request and lands in the middle
    // of the next test's reset.
    if (process.env.NODE_ENV === 'test') await settled;
  }
  return row.id;
}

/**
 * Is this session still good? Cached briefly, so revocation lands within a minute for
 * a session someone else ended — and immediately for one ended here, because every
 * revoke path drops its cache entry.
 */
export async function sessionIsLive(sessionId: string): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(sessionId);
  if (hit && now - hit.checkedAt < CACHE_MS) {
    if (!hit.live || hit.expiresAt <= now) return false;
    void touch(sessionId, hit, now);
    return true;
  }

  const row = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { revokedAt: true, expiresAt: true, lastSeenAt: true },
  });
  const live = Boolean(row && !row.revokedAt && row.expiresAt.getTime() > now);
  const entry: Cached = {
    live,
    expiresAt: row?.expiresAt.getTime() ?? 0,
    lastSeenAt: row?.lastSeenAt.getTime() ?? 0,
    checkedAt: now,
  };
  cache.set(sessionId, entry);
  if (live) void touch(sessionId, entry, now);
  return live;
}

/** Write lastSeenAt only when it has gone properly stale. Never blocks the request. */
async function touch(sessionId: string, entry: Cached, now: number): Promise<void> {
  if (now - entry.lastSeenAt < TOUCH_MS) return;
  entry.lastSeenAt = now; // claim it before awaiting, so parallel requests do not all write
  await prisma.session.update({ where: { id: sessionId }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
}

/** End one session. Returns false when it was not there or was already over. */
export async function revokeSession(sessionId: string, by: RevokedBy): Promise<boolean> {
  const { count } = await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedBy: by },
  });
  forgetCached(sessionId);
  return count > 0;
}

/**
 * End every live session belonging to someone — optionally sparing the one making the
 * request, which is what "change my password" and "sign out my other devices" want.
 */
export async function revokeAllFor(
  who: { userId?: string; portalUserId?: string },
  by: RevokedBy,
  except?: string | null,
): Promise<number> {
  const where = {
    revokedAt: null,
    ...(who.userId ? { userId: who.userId } : {}),
    ...(who.portalUserId ? { portalUserId: who.portalUserId } : {}),
    ...(except ? { id: { not: except } } : {}),
  };
  const doomed = await prisma.session.findMany({ where, select: { id: true } });
  if (doomed.length === 0) return 0;
  const { count } = await prisma.session.updateMany({ where, data: { revokedAt: new Date(), revokedBy: by } });
  for (const s of doomed) forgetCached(s.id);
  return count;
}

/**
 * Clear out sessions long past their expiry. Kept for a month after they end so the
 * Active sessions screen can still show where someone signed in from last week.
 */
export async function pruneSessions(keepDays = 30): Promise<number> {
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date(Date.now() - keepDays * 86_400_000) } },
  });
  return count;
}
