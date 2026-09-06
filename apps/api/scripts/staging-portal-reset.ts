import { prisma } from '../src/db.js';
/** Staging only: clear a portal user's lockout so a browser test can continue. */
for (const email of process.argv.slice(2)) {
  await prisma.portalUser.update({ where: { email }, data: { failedAttempts: 0, lockedUntil: null } });
  console.log('reset', email);
}
await prisma.$disconnect();
