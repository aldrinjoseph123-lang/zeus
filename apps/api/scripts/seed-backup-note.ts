import { prisma } from '../src/db.js';

/** Staging only: a backup that wrote locally but failed to reach OneDrive, so the
 *  Backups table can be checked against a genuinely long error note. */
const error = [
  'OneDrive: AADSTS7000215: Invalid client secret provided. Ensure the secret being sent',
  'in the request is the client secret value, not the client secret ID, for a secret added',
  "to app '7b07f87de-3ba7-4503-8968-85ac85ca6f64'. Trace ID: 36664a93-968e-4e0d-9667-b521d04b5300",
  'Correlation ID: 147b162e-1ac7-4118-81c0-968858d42c36 Timestamp: 2026-09-07 22:00:01Z',
].join(' ');

await prisma.backupRun.create({
  data: {
    kind: 'physical', tier: 'daily', status: 'partial',
    filename: 'zeus-physical-2026-09-07T22-00-00.sql.gz.enc',
    destinations: ['local'], sizeBytes: 92160, encrypted: true, error,
    startedAt: new Date(Date.now() - 3_600_000), finishedAt: new Date(Date.now() - 3_595_000),
  } as never,
});
console.log('seeded a partial backup with a long note');
await prisma.$disconnect();
