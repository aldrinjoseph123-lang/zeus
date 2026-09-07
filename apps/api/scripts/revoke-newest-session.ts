import { prisma } from '../src/db.js';
import { revokeSession } from '../src/auth/sessionStore.js';

/** Staging only: end the most recent live session, to prove revocation from outside. */
const row = await prisma.session.findFirstOrThrow({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' }, include: { user: { select: { name: true } } } });
await revokeSession(row.id, 'admin');
console.log(`revoked ${row.id} — ${row.user?.name} on ${row.device} from ${row.ip}`);
await prisma.$disconnect();
