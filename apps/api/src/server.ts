import { buildApp } from './app.js';
import { env } from './env.js';
import { prisma } from './db.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { ensureNotificationRules } from './services/notify.js';
import { ensureRoleModules } from './auth/rbac.js';

/**
 * Process entry point. Everything that makes the API *work* lives in app.ts; this file
 * only owns the things a test must never do — bind a port, start cron, trap signals.
 */

const app = await buildApp();

const shutdown = async (signal: string) => {
  app.log.info(`${signal} received — shutting down`);
  stopScheduler();
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A release that adds an alert must not need a re-seed to be configurable.
try {
  const added = await ensureNotificationRules();
  if (added) app.log.info(`added ${added} notification rule(s) for new events`);
  const patched = await ensureRoleModules();
  if (patched) app.log.info(`backfilled new permission modules into ${patched} role(s)`);
} catch (err) {
  app.log.error(`could not sync notification rules or role modules: ${(err as Error).message}`);
}

await app.listen({ port: env.PORT, host: '0.0.0.0' });
startScheduler();
app.log.info(`Zeus API listening on :${env.PORT} (${env.NODE_ENV})`);
