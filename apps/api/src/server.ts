import { buildApp } from './app.js';
import { env } from './env.js';
import { prisma } from './db.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

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

await app.listen({ port: env.PORT, host: '0.0.0.0' });
startScheduler();
app.log.info(`Zeus API listening on :${env.PORT} (${env.NODE_ENV})`);
