import { prisma } from '../src/db.js';

/** Staging only: what the Active sessions screen will show, before that screen exists. */
const rows = await prisma.session.findMany({
  orderBy: { createdAt: 'desc' }, take: 6,
  select: { kind: true, device: true, ip: true, expiresAt: true, revokedAt: true, revokedBy: true, lastSeenAt: true, user: { select: { name: true } }, portalUser: { select: { email: true } } },
});
for (const r of rows) {
  console.log([
    r.user?.name ?? r.portalUser?.email ?? '?',
    r.kind,
    r.device ?? 'no device',
    r.ip ?? 'no ip',
    r.revokedAt ? `revoked (${r.revokedBy})` : 'live',
    'expires ' + r.expiresAt.toISOString().slice(0, 16),
  ].join(' | '));
}
await prisma.$disconnect();
