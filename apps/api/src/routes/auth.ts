import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { getSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, HttpError } from '../lib/http.js';
import { clearSession, issueSession } from '../auth/session.js';
import { authorizeUrl, adminConsentUrl, exchangeCode, verifyState } from '../auth/entra.js';
import { getM365, markM365 } from '../services/graph.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  /** What the login screen renders — which methods are switched on. */
  app.get('/api/auth/config', async () => {
    const [allowLocal, allowEntra, productName] = await Promise.all([
      getSetting<boolean>('auth.allowLocalLogin', true),
      getSetting<boolean>('auth.allowEntraLogin', true),
      getSetting<string>('branding.productName', 'Zeus'),
    ]);
    const m365 = await getM365();
    return {
      localLogin: allowLocal,
      microsoftLogin: allowEntra && Boolean(m365?.config.clientId && m365?.secrets?.clientSecret),
      productName,
    };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } }, async (request, reply) => {
    if (!(await getSetting<boolean>('auth.allowLocalLogin', true))) {
      throw new HttpError(403, 'Password sign-in is disabled. Use Microsoft sign-in.');
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter a valid email and password.');

    const email = parsed.data.email.toLowerCase().trim();
    const user = await prisma.user.findUnique({ where: { email } });

    // Same generic message and a hash comparison either way — no user enumeration,
    // no timing shortcut when the account does not exist.
    const hash = user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(parsed.data.password, hash);

    if (!user || !ok || !user.isActive) {
      await audit({ action: 'login_failed', entity: 'User', entityId: user?.id, summary: email, ip: clientIp(request) });
      throw new HttpError(401, 'Email or password is incorrect.');
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await issueSession(reply, user.id);
    await audit({ action: 'login', entity: 'User', entityId: user.id, summary: `${user.name} signed in with a password`, ip: clientIp(request) });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (_request, reply) => {
    clearSession(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (request) => {
    if (!request.user) throw new HttpError(401, 'Not signed in.');
    const full = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: {
        id: true, email: true, name: true, jobTitle: true, phone: true, whatsappNumber: true, avatarColor: true,
        lastLoginAt: true, team: { select: { id: true, name: true, kind: true } },
        role: { select: { id: true, name: true, permissions: true } },
      },
    });
    const unread = await prisma.notification.count({ where: { userId: request.user.id, readAt: null } });
    return { user: full, unreadNotifications: unread };
  });

  app.post('/api/auth/change-password', async (request) => {
    if (!request.user) throw new HttpError(401, 'Not signed in.');
    const schema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(10, 'Use at least 10 characters.') });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) throw badRequest(parsed.error.issues[0].message);

    const user = await prisma.user.findUnique({ where: { id: request.user.id } });
    if (!user?.passwordHash) throw badRequest('This account signs in with Microsoft and has no password.');
    if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
      throw badRequest('Current password is incorrect.');
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(parsed.data.newPassword, 10) },
    });
    await audit({ user: request.user, action: 'update', entity: 'User', entityId: user.id, summary: 'Changed own password', ip: clientIp(request) });
    return { ok: true };
  });

  // ── Microsoft sign-in ───────────────────────────────────────────────────────

  app.get('/api/auth/microsoft/start', async (request, reply) => {
    const next = typeof (request.query as Record<string, string>).next === 'string' ? (request.query as Record<string, string>).next : '/';
    try {
      return reply.redirect(await authorizeUrl(next));
    } catch (err) {
      return reply.redirect(`${env.APP_URL}/login?error=${encodeURIComponent((err as Error).message)}`);
    }
  });

  app.get('/api/auth/microsoft/callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const fail = (msg: string) => reply.redirect(`${env.APP_URL}/login?error=${encodeURIComponent(msg)}`);

    if (query.error) return fail(query.error_description ?? query.error);
    const state = verifyState(query.state);
    if (!state.ok) return fail('Sign-in link expired. Try again.');
    if (!query.code) return fail('Microsoft did not return an authorization code.');

    let profile;
    try {
      profile = await exchangeCode(query.code);
    } catch (err) {
      return fail((err as Error).message);
    }

    const m365 = await getM365();
    if (m365 && profile.tenantId !== m365.config.tenantId) {
      return fail('That account is outside this organisation.');
    }

    let user = await prisma.user.findFirst({
      where: { OR: [{ entraOid: profile.oid }, { email: profile.email }] },
    });

    if (!user) {
      if (!(await getSetting<boolean>('auth.autoProvisionEntra', false))) {
        return fail('No Zeus account exists for that Microsoft user. Ask an administrator to add you.');
      }
      const roleName = await getSetting<string>('auth.defaultRoleName', 'Sales Executive');
      const role = (await prisma.role.findUnique({ where: { name: roleName } })) ?? (await prisma.role.findFirst());
      if (!role) return fail('No roles are configured yet.');
      user = await prisma.user.create({
        data: { email: profile.email, name: profile.name, entraOid: profile.oid, roleId: role.id },
      });
    } else if (!user.entraOid) {
      user = await prisma.user.update({ where: { id: user.id }, data: { entraOid: profile.oid } });
    }

    if (!user.isActive) return fail('That account is deactivated.');

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await issueSession(reply, user.id);
    await audit({ action: 'login', entity: 'User', entityId: user.id, summary: `${user.name} signed in with Microsoft`, ip: clientIp(request) });
    return reply.redirect(`${env.APP_URL}${state.nextPath}`);
  });

  /** Where Entra lands after an admin grants tenant-wide consent. */
  app.get('/api/auth/microsoft/consent-callback', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    if (query.error) {
      await markM365('consent_failed', false, query.error_description ?? query.error);
      return reply.redirect(`${env.APP_URL}/settings/integrations?consent=failed`);
    }
    await markM365('connected', true, null);
    return reply.redirect(`${env.APP_URL}/settings/integrations?consent=granted`);
  });

  app.get('/api/auth/microsoft/consent-url', async (request) => {
    if (!request.user) throw new HttpError(401, 'Not signed in.');
    return { url: await adminConsentUrl() };
  });
}
