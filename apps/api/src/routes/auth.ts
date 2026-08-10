import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { getSetting } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { closeChallenge, openChallenge, readChallenge, verifySecondFactor } from '../services/twoFactor.js';
import * as twoFactor from '../services/twoFactor.js';
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

    /**
     * The password was right, but it is not a session yet. The cookie is only issued once
     * the second factor is checked, so a stolen password on its own reaches nothing.
     */
    if (user.totpEnabledAt) {
      await audit({ action: 'login_pending_2fa', entity: 'User', entityId: user.id, summary: `${user.name} passed the password step`, ip: clientIp(request) });
      return { ok: false, twoFactorRequired: true, challenge: openChallenge(user.id) };
    }

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await issueSession(reply, user.id);
    await audit({ action: 'login', entity: 'User', entityId: user.id, summary: `${user.name} signed in with a password`, ip: clientIp(request) });
    return { ok: true };
  });

  /**
   * The second step. Rate-limited harder than the password: a six-digit code is a million
   * guesses, which is nothing without a limit and a great deal with one.
   */
  app.post('/api/auth/2fa/verify', { config: { rateLimit: { max: 6, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const parsed = z.object({ challenge: z.string().min(1), code: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter the code from your authenticator, or a recovery code.');

    const userId = readChallenge(parsed.data.challenge);
    if (!userId) throw new HttpError(401, 'That sign-in took too long. Enter your password again.');

    const factor = await verifySecondFactor(userId, parsed.data.code);
    if (!factor) {
      await audit({ action: 'login_failed', entity: 'User', entityId: userId, summary: 'wrong second factor', ip: clientIp(request) });
      throw new HttpError(401, 'That code is not right. Check the clock on your phone, or use a recovery code.');
    }

    closeChallenge(parsed.data.challenge);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, isActive: true } });
    if (!user.isActive) throw new HttpError(401, 'That account is no longer active.');

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await issueSession(reply, user.id);
    await audit({
      action: 'login', entity: 'User', entityId: user.id,
      summary: `${user.name} signed in with a password and ${factor === 'recovery' ? 'a recovery code' : 'an authenticator code'}`,
      ip: clientIp(request),
    });

    // Spending a recovery code is worth saying out loud — it usually means a lost phone.
    return { ok: true, usedRecoveryCode: factor === 'recovery' };
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

  // ── two-factor enrolment, for a signed-in user managing their own account ─────

  app.get('/api/auth/2fa', async (request) => {
    if (!request.user) throw new HttpError(401, 'Not signed in.');
    return twoFactor.status(request.user.id);
  });

  /**
   * Start enrolment. Hands back the secret, a QR payload and the recovery codes — the
   * one and only time the codes are shown in the clear. Nothing is enforced until the
   * user confirms with a working code.
   */
  app.post('/api/auth/2fa/enrol', async (request) => {
    if (!request.user) throw new HttpError(401, 'Not signed in.');
    const enrolment = await twoFactor.beginEnrolment(request.user.id, request.user.email);
    await audit({ action: 'update', entity: 'User', entityId: request.user.id, summary: 'started two-factor enrolment', ip: clientIp(request) });
    return enrolment;
  });

  app.post('/api/auth/2fa/confirm', async (request) => {
    if (!request.user) throw new HttpError(401, 'Not signed in.');
    const parsed = z.object({ code: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter the six-digit code from your authenticator.');

    const ok = await twoFactor.confirmEnrolment(request.user.id, parsed.data.code);
    if (!ok) throw badRequest('That code did not match. Check your phone\'s clock and try the current code.');

    await audit({ action: 'update', entity: 'User', entityId: request.user.id, summary: 'turned two-factor on', ip: clientIp(request) });
    return { ok: true };
  });

  /**
   * Turn it off. Requires the current password — a hijacked *session* must not be able
   * to strip the protection that would have stopped it, and a shared unlocked screen is
   * the ordinary case this defends against.
   */
  app.post('/api/auth/2fa/disable', async (request) => {
    if (!request.user) throw new HttpError(401, 'Not signed in.');
    const parsed = z.object({ password: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) throw badRequest('Enter your password to turn two-factor off.');

    const user = await prisma.user.findUnique({ where: { id: request.user.id }, select: { passwordHash: true } });
    const ok = user?.passwordHash ? await bcrypt.compare(parsed.data.password, user.passwordHash) : false;
    if (!ok) throw new HttpError(401, 'That password is not right.');

    await twoFactor.disable(request.user.id);
    await audit({ action: 'update', entity: 'User', entityId: request.user.id, summary: 'turned two-factor off', ip: clientIp(request) });
    return { ok: true };
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
