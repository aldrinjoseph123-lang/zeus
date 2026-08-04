import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { corsOrigins, env, isProd } from './env.js';
import { prisma } from './db.js';
import { loadSessionUser } from './auth/session.js';
import { HttpError, sendError } from './lib/http.js';

import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import contactRoutes from './routes/contacts.js';
import leadRoutes from './routes/leads.js';
import dealRoutes from './routes/deals.js';
import productRoutes from './routes/products.js';
import quoteRoutes from './routes/quotes.js';
import activityRoutes from './routes/activities.js';
import dashboardRoutes from './routes/dashboard.js';
import reportRoutes from './routes/reports.js';
import importRoutes from './routes/imports.js';
import attachmentRoutes from './routes/attachments.js';
import invoiceRoutes from './routes/invoices.js';
import purchaseOrderRoutes from './routes/purchaseOrders.js';
import paymentRoutes from './routes/payments.js';
import approvalRoutes from './routes/approvals.js';
import undoRoutes from './routes/undo.js';
import renewalRoutes from './routes/renewals.js';
import adminRoutes from './routes/admin.js';
import integrationRoutes from './routes/integrations.js';

/**
 * Builds the API without starting it.
 *
 * Split out from server.ts so the integration suite can drive the real routes,
 * middleware and error handling through `app.inject()` — no port, no scheduler, no
 * mocks standing in for the parts most likely to break.
 */
export async function buildApp() {
  const app = Fastify({
    logger: isProd
      ? { level: 'info' }
      : { level: 'info', transport: undefined },
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: true,
  });

  /** Endpoints reachable without a session. Everything else needs one. */
  const PUBLIC_PATHS = new Set([
    '/api/health',
    '/api/auth/config',
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/microsoft/start',
    '/api/auth/microsoft/callback',
    '/api/auth/microsoft/consent-callback',
  ]);

  await app.register(cookie, { secret: env.APP_SECRET });
  await app.register(cors, { origin: corsOrigins, credentials: true });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });
  await app.register(rateLimit, { global: false, max: 300, timeWindow: '1 minute' });

  // One gate for the whole API: resolve the session, then reject anonymous traffic.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;

    const user = await loadSessionUser(request);
    if (user) request.user = user as never;

    const pathOnly = request.url.split('?')[0];
    if (PUBLIC_PATHS.has(pathOnly)) return;
    if (!user) return reply.status(401).send({ error: 'Sign in required.' });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return sendError(reply, error);
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: 'Too many attempts. Wait a minute and try again.' });
    }
    if ((error as { code?: string }).code === 'P2002') {
      return reply.status(409).send({ error: 'That value is already used by another record.' });
    }
    if ((error as { code?: string }).code === 'P2025') {
      return reply.status(404).send({ error: 'Record not found.' });
    }
    request.log.error(error);
    const err = error as { statusCode?: number; message?: string };
    return reply.status(err.statusCode ?? 500).send({ error: err.message || 'Something went wrong.' });
  });

  app.get('/api/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, service: 'zeus-api', time: new Date().toISOString() };
  });

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(contactRoutes);
  await app.register(leadRoutes);
  await app.register(dealRoutes);
  await app.register(productRoutes);
  await app.register(quoteRoutes);
  await app.register(activityRoutes);
  await app.register(dashboardRoutes);
  await app.register(reportRoutes);
  await app.register(importRoutes);
  await app.register(attachmentRoutes);
  await app.register(invoiceRoutes);
  await app.register(purchaseOrderRoutes);
  await app.register(paymentRoutes);
  await app.register(approvalRoutes);
  await app.register(undoRoutes);
  await app.register(renewalRoutes);
  await app.register(adminRoutes);
  await app.register(integrationRoutes);

  // In production the API also serves the built SPA, so one container is the whole app.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.status(404).send({ error: 'No such endpoint.' });
      return reply.sendFile('index.html');
    });
    app.log.info(`serving frontend from ${webDist}`);
  }


  return app;
}
