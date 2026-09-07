import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, forbidden, notFound, requirePermission } from '../lib/http.js';
import { describeWhere } from '../lib/whereFrom.js';
import { can } from '../auth/rbac.js';
import { revokeAllFor, revokeSession } from '../auth/sessionStore.js';
import { sessionIdFromRequest } from '../auth/session.js';

/**
 * Who is signed in, on what, from where — and the power to end any of it.
 *
 * Two audiences, one shape. An administrator sees everyone under Settings → Security;
 * everyone sees their own devices under My account and can sign the others out. The
 * row making the request is marked, so nobody signs themselves out by mistake.
 */

/** A session is "active now" if it has been used recently; older ones are idle, not gone. */
const ACTIVE_WINDOW_MS = 15 * 60_000;

const SELECT = {
  id: true, kind: true, createdAt: true, lastSeenAt: true, expiresAt: true, revokedAt: true, revokedBy: true,
  ip: true, device: true, city: true, region: true, country: true, isp: true,
  user: { select: { id: true, name: true, email: true } },
  portalUser: { select: { id: true, email: true, contact: { select: { firstName: true, lastName: true, account: { select: { name: true } } } } } },
  viewingAs: { select: { id: true, name: true } },
} as const;

type Row = Awaited<ReturnType<typeof prisma.session.findMany<{ select: typeof SELECT }>>>[number];

function shape(row: Row, currentSessionId: string | null) {
  const contact = row.portalUser?.contact;
  return {
    id: row.id,
    kind: row.kind,
    who: row.user?.name ?? (contact ? `${contact.firstName} ${contact.lastName}` : row.portalUser?.email ?? 'Unknown'),
    email: row.user?.email ?? row.portalUser?.email ?? null,
    account: contact?.account?.name ?? null,
    device: row.device,
    where: describeWhere(row),
    country: row.country,
    ip: row.ip,
    startedAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    active: !row.revokedAt && row.expiresAt > new Date() && Date.now() - row.lastSeenAt.getTime() < ACTIVE_WINDOW_MS,
    /** A portal preview: this is an administrator looking, not the contact themselves. */
    previewBy: row.viewingAs?.name ?? null,
    isCurrent: row.id === currentSessionId,
  };
}

export default async function sessionRoutes(app: FastifyInstance): Promise<void> {
  /** Everyone's sessions. Live ones first, then whatever ended recently. */
  app.get('/api/sessions', { preHandler: requirePermission('users', 'read') }, async (request) => {
    const q = request.query as Record<string, string | undefined>;
    const where: Record<string, unknown> = {};
    if (q.kind) where.kind = q.kind;
    if (q.userId) where.userId = q.userId;
    // Default to what is still open; "all" also shows what has ended in the last month.
    if (q.state !== 'all') Object.assign(where, { revokedAt: null, expiresAt: { gt: new Date() } });

    const rows = await prisma.session.findMany({ where, select: SELECT, orderBy: [{ revokedAt: 'asc' }, { lastSeenAt: 'desc' }], take: 200 });
    const current = await sessionIdFromRequest(request);
    return rows.map((r) => shape(r, current));
  });

  /** My own devices — no permission needed beyond being signed in. */
  app.get('/api/sessions/mine', async (request) => {
    const current = await sessionIdFromRequest(request);
    const rows = await prisma.session.findMany({
      where: { userId: request.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: SELECT,
      orderBy: { lastSeenAt: 'desc' },
    });
    return rows.map((r) => shape(r, current));
  });

  /** Sign out everywhere else in one go. Deliberately cannot touch the session asking. */
  app.post('/api/sessions/mine/sign-out-others', async (request) => {
    const current = await sessionIdFromRequest(request);
    const ended = await revokeAllFor({ userId: request.user.id }, 'self', current);
    if (ended) {
      await audit({ user: request.user, action: 'update', entity: 'Session', entityId: request.user.id, summary: `Signed out ${ended} other device(s)`, ip: clientIp(request) });
    }
    return { ok: true, ended };
  });

  /**
   * End one session. Your own needs nothing; anyone else's needs the roster permission,
   * which is the same bar as deactivating them.
   */
  app.delete('/api/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = await prisma.session.findUnique({ where: { id }, select: { id: true, userId: true, revokedAt: true, user: { select: { name: true } }, portalUser: { select: { email: true } } } });
    if (!row) throw notFound('That session is not here — it may already have ended.');

    const mine = row.userId === request.user.id;
    // can(), not the raw permission: the scopes are strings, and 'none' is truthy — a
    // rep would have sailed straight through a plain truthiness check.
    if (!mine && !can(request.user, 'users', 'update')) {
      throw forbidden('Only an administrator can sign out someone else.');
    }
    if (row.revokedAt) throw badRequest('That session has already ended.');
    if (id === (await sessionIdFromRequest(request))) throw badRequest('That is this session — use Sign out instead.');

    await revokeSession(id, mine ? 'self' : 'admin');
    const whose = row.user?.name ?? row.portalUser?.email ?? 'a session';
    await audit({ user: request.user, action: 'update', entity: 'Session', entityId: id, summary: mine ? 'Signed out one of their own devices' : `Signed out ${whose}`, ip: clientIp(request) });
    return { ok: true };
  });
}
