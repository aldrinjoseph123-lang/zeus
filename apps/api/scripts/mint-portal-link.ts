import { randomBytes, createHash } from 'node:crypto';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';

/** Staging only: mint a set-password link without a mailer — same token + hash as issueLinkFor. */
for (const email of process.argv.slice(2)) {
  const u = await prisma.portalUser.findUnique({ where: { email } });
  if (!u) { console.log(email, 'no portal user'); continue; }
  const token = randomBytes(32).toString('hex');
  await prisma.portalUser.update({ where: { id: u.id }, data: { linkTokenHash: createHash('sha256').update(token).digest('hex'), linkExpiresAt: new Date(Date.now() + 3_600_000), disabledAt: null, failedAttempts: 0, lockedUntil: null } });
  console.log('LINK', email, `${env.PORTAL_URL}/set-password?token=${token}`);
}
await prisma.$disconnect();
