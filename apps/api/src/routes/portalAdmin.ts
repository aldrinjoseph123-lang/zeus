import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, notFound, requirePermission } from '../lib/http.js';
import { issueLinkFor } from '../portal/auth.js';
import { grantPortalAccess, PORTAL_USER_SELECT, shapePortalUser } from '../portal/grant.js';
import { saveTurnstile, turnstileConfig } from '../portal/requests.js';
import { signViewAsToken } from '../portal/session.js';
import { PARTNER_SWITCHES, resolvePartnerSwitches, sanitizeOverrides, validLogo, type PartnerSwitch } from '../portal/switches.js';
import { env } from '../env.js';
import { getSetting } from '../lib/settings.js';

/**
 * The internal side of the portal: who has access. Grant is a deliberate act on a
 * specific contact — being a contact under a partner account grants nothing by
 * itself — and every change here is audited. Phase 2 adds the Settings page over
 * these; phase 1 ships the routes the page and the tests need.
 */
export default async function portalAdminRoutes(app: FastifyInstance): Promise<void> {
  const select = PORTAL_USER_SELECT;
  const shape = shapePortalUser;

  app.get('/api/portal-admin/users', { preHandler: requirePermission('portal', 'read') }, async () => {
    const users = await prisma.portalUser.findMany({ select, orderBy: { enabledAt: 'desc' } });
    return users.map(shape);
  });

  app.post('/api/portal-admin/users', { preHandler: requirePermission('portal', 'update') }, async (request, reply) => {
    const { contactId } = z.object({ contactId: z.string().min(1) }).parse(request.body);
    const { user, email, mail } = await grantPortalAccess(contactId);
    await audit({ user: request.user, action: 'create', entity: 'PortalUser', entityId: user.id, summary: `Portal access granted to ${email}${mail.ok ? '' : ' (link not sent)'}`, ip: clientIp(request) });
    return reply.status(201).send({ ...user, mail });
  });

  app.post('/api/portal-admin/users/:id/link', { preHandler: requirePermission('portal', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await prisma.portalUser.findUnique({ where: { id } });
    if (!user) throw notFound('Portal user not found.');
    const mail = await issueLinkFor(id);
    if (!mail.ok) throw badRequest(mail.reason);
    await audit({ user: request.user, action: 'update', entity: 'PortalUser', entityId: id, summary: `Set-password link sent to ${mail.to}`, ip: clientIp(request) });
    return { ok: true, to: mail.to };
  });

  /**
   * "View as": the only way to see the effective result of every switch. Returns a URL
   * on the portal host carrying a two-minute token; the portal exchanges it for a
   * read-only preview session marked with the admin's name, and logs every read twice.
   */
  app.post('/api/portal-admin/users/:id/view-as', { preHandler: requirePermission('portal', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const user = await prisma.portalUser.findUnique({ where: { id } });
    if (!user) throw notFound('Portal user not found.');
    const token = await signViewAsToken(id, { userId: request.user.id, name: request.user.name });
    await audit({ user: request.user, action: 'read', entity: 'PortalUser', entityId: id, summary: `Opened the portal as ${user.email}`, ip: clientIp(request) });
    return { url: `${env.PORTAL_URL.replace(/\/$/, '')}/view-as?token=${token}` };
  });

  // ── per-account: overrides of the field switches, and a logo ───────────────

  const accountView = async (accountId: string) => {
    const account = await prisma.account.findFirst({ where: { id: accountId, deletedAt: null }, select: { id: true, name: true, type: true, portalOverrides: true, portalLogo: true } });
    if (!account) throw notFound('Account not found.');
    const overrides = sanitizeOverrides(account.portalOverrides);
    const effective = await resolvePartnerSwitches(accountId);
    // The global default per switch, so the page can say what "Default" currently means.
    const global = {} as Record<PartnerSwitch, boolean>;
    for (const key of Object.keys(PARTNER_SWITCHES) as PartnerSwitch[]) global[key] = await getSetting<boolean>(PARTNER_SWITCHES[key].setting, PARTNER_SWITCHES[key].fallback);
    return {
      id: account.id, name: account.name, type: account.type,
      logo: account.portalLogo,
      overrides,
      global,
      effective,
      // The allowlist, with labels, so the page can only ever offer what the code allows.
      switches: (Object.keys(PARTNER_SWITCHES) as PartnerSwitch[]).map((key) => ({ key, label: PARTNER_SWITCHES[key].label })),
      users: await prisma.portalUser.findMany({ where: { contact: { accountId } }, select: { id: true, email: true, disabledAt: true, lastLoginAt: true, passwordHash: true } })
        .then((rows) => rows.map(({ passwordHash, ...rest }) => ({ ...rest, hasPassword: Boolean(passwordHash) }))),
    };
  };

  app.get('/api/portal-admin/accounts/:id', { preHandler: requirePermission('portal', 'read') }, async (request) => accountView((request.params as { id: string }).id));

  app.patch('/api/portal-admin/accounts/:id', { preHandler: requirePermission('portal', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const body = z.object({
      // null clears the override for that switch; absent leaves it alone.
      overrides: z.record(z.string(), z.boolean().nullable()).optional(),
      logo: z.string().nullable().optional(),
    }).parse(request.body);
    const account = await prisma.account.findFirst({ where: { id, deletedAt: null }, select: { portalOverrides: true, name: true } });
    if (!account) throw notFound('Account not found.');

    const data: { portalOverrides?: Record<string, boolean>; portalLogo?: string | null } = {};
    if (body.overrides) {
      const merged: Record<string, boolean> = { ...sanitizeOverrides(account.portalOverrides) };
      for (const [key, value] of Object.entries(body.overrides)) {
        if (!(key in PARTNER_SWITCHES)) continue; // not on the allowlist: ignored, never stored
        if (value === null) delete merged[key]; else merged[key] = value;
      }
      data.portalOverrides = merged;
    }
    if (body.logo !== undefined) {
      if (body.logo !== null && !validLogo(body.logo)) throw badRequest('The logo must be a PNG, JPEG, WebP or SVG image under 150 KB.');
      data.portalLogo = body.logo;
    }
    await prisma.account.update({ where: { id }, data });
    await audit({ user: request.user, action: 'update', entity: 'Account', entityId: id, summary: `Portal settings for ${account.name}: ${[body.overrides ? `overrides ${JSON.stringify(data.portalOverrides)}` : null, body.logo !== undefined ? (body.logo ? 'logo set' : 'logo removed') : null].filter(Boolean).join(', ')}`, ip: clientIp(request) });
    return accountView(id);
  });

  // ── access requests: the quarantine queue ──────────────────────────────────

  app.get('/api/portal-admin/requests', { preHandler: requirePermission('portal', 'read') }, async () =>
    prisma.accessRequest.findMany({ where: { status: 'PENDING' }, orderBy: { createdAt: 'desc' }, select: { id: true, email: true, company: true, note: true, createdAt: true } }));

  /** Match a request to a contact sales created: grants exactly as the Grant button does, then closes the request. */
  app.post('/api/portal-admin/requests/:id/match', { preHandler: requirePermission('portal', 'update') }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { contactId } = z.object({ contactId: z.string().min(1) }).parse(request.body);
    const req = await prisma.accessRequest.findFirst({ where: { id, status: 'PENDING' } });
    if (!req) throw notFound('Request not found, or already handled.');
    const { user, email, mail } = await grantPortalAccess(contactId);
    await prisma.accessRequest.update({ where: { id }, data: { status: 'MATCHED', handledById: request.user.id, handledAt: new Date() } });
    await audit({ user: request.user, action: 'create', entity: 'PortalUser', entityId: user.id, summary: `Access request from ${req.email} (${req.company}) matched to ${email}${mail.ok ? '' : ' (link not sent)'}`, ip: clientIp(request) });
    return reply.status(201).send({ ...user, mail });
  });

  /** Reject deletes the row: a claim nobody recognised is not data worth keeping. */
  app.post('/api/portal-admin/requests/:id/reject', { preHandler: requirePermission('portal', 'update') }, async (request) => {
    const { id } = request.params as { id: string };
    const req = await prisma.accessRequest.findFirst({ where: { id, status: 'PENDING' } });
    if (!req) throw notFound('Request not found, or already handled.');
    await prisma.accessRequest.delete({ where: { id } });
    await audit({ user: request.user, action: 'delete', entity: 'AccessRequest', entityId: id, summary: `Access request from ${req.email} (${req.company}) rejected`, ip: clientIp(request) });
    return { ok: true };
  });

  // ── Turnstile: the bot check on the public form ────────────────────────────

  app.get('/api/portal-admin/turnstile', { preHandler: requirePermission('portal', 'read') }, async () => turnstileConfig());

  app.put('/api/portal-admin/turnstile', { preHandler: requirePermission('portal', 'update') }, async (request) => {
    const { siteKey, secret } = z.object({ siteKey: z.string().trim().max(200), secret: z.string().trim().max(200).optional() }).parse(request.body);
    await saveTurnstile(siteKey, secret || undefined);
    await audit({ user: request.user, action: 'update', entity: 'Integration', entityId: 'turnstile', summary: `Turnstile ${siteKey ? 'configured' : 'cleared'}${secret ? ' (secret updated)' : ''}`, ip: clientIp(request) });
    return turnstileConfig();
  });

  for (const [action, disabledAt] of [['revoke', () => new Date()], ['restore', () => null]] as const) {
    app.post(`/api/portal-admin/users/:id/${action}`, { preHandler: requirePermission('portal', 'update') }, async (request) => {
      const { id } = request.params as { id: string };
      const user = await prisma.portalUser.findUnique({ where: { id } });
      if (!user) throw notFound('Portal user not found.');
      const updated = await prisma.portalUser.update({ where: { id }, data: { disabledAt: disabledAt() }, select });
      await audit({ user: request.user, action: 'update', entity: 'PortalUser', entityId: id, summary: `Portal access ${action === 'revoke' ? 'revoked for' : 'restored for'} ${user.email}`, ip: clientIp(request) });
      return shape(updated);
    });
  }
}
