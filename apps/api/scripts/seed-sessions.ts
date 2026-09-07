import { prisma } from '../src/db.js';

/** Staging only: sessions that look like real life, so the screen has something to say. */
const admin = await prisma.user.findFirstOrThrow({ where: { email: 'uat-admin@example.com' } });
const rep = await prisma.user.findFirst({ where: { email: 'uat-rep@example.com' } });
const mins = (m: number) => new Date(Date.now() - m * 60_000);

const rows = [
  { kind: 'internal', userId: rep?.id ?? admin.id, device: 'Safari on iPhone', ip: '94.207.44.12', city: 'Dubai', region: 'Dubai', country: 'AE', isp: 'Emirates Telecommunications Group', createdAt: mins(180), lastSeenAt: mins(4), expiresAt: new Date(Date.now() + 6 * 3_600_000) },
  { kind: 'internal', userId: admin.id, device: 'Chrome on Windows', ip: '5.107.9.88', city: 'Sharjah', region: 'Sharjah', country: 'AE', isp: 'du (Emirates Integrated Telecom)', createdAt: mins(600), lastSeenAt: mins(90), expiresAt: new Date(Date.now() + 2 * 3_600_000) },
  { kind: 'internal', userId: rep?.id ?? admin.id, device: 'Firefox on Linux', ip: '102.89.33.7', city: 'Lagos', region: 'Lagos', country: 'NG', isp: 'MTN Nigeria', createdAt: mins(1500), lastSeenAt: mins(1400), expiresAt: mins(200), revokedAt: mins(1390), revokedBy: 'admin' },
];
for (const r of rows) await prisma.session.create({ data: r as never });
console.log('seeded', rows.length, 'session rows');
await prisma.$disconnect();
