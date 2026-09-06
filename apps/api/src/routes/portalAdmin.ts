import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, notFound, requirePermission } from '../lib/http.js';
import { issueLinkFor } from '../portal/auth.js';
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
  const select = {
    id: true, email: true, enabledAt: true, disabledAt: true, lastLoginAt: true, lockedUntil: true, linkExpiresAt: true, passwordHash: true,
    contact: { select: { id: true, firstName: true, lastName: true, account: { select: { id: true, name: true, type: true } } } },
  } as const;
  const shape = (u: { passwordHash: string | null; [k: string]: unknown }) => {
    const { passwordHash, ...rest } = u;
    return { ...rest, hasPassword: Boolean(passwordHash) };
  };

  app.get('/api/portal-admin/users', { preHandler: requirePermission('portal', 'read') }, async () => {
    const users = await prisma.portalUser.findMany({ select, orderBy: { enabledAt: 'desc' } });
    return users.map(shape);
  });

  app.post('/api/portal-admin/users', { preHandler: requirePermission('portal', 'update') }, async (request, reply) => {
    const { contactId } = z.object({ contactId: z.string().min(1) }).parse(request.body);
    const contact = await prisma.contact.findFirst({ where: { id: contactId, deletedAt: null, erasedAt: null }, include: { account: { select: { type: true, deletedAt: true } } } });
    if (!contact) throw notFound('Contact not found.');
    const email = contact.email?.trim().toLowerCase();
    if (!email) throw badRequest('This contact has no email address — add one first.');
    if (!contact.account || contact.account.deletedAt) throw badRequest('This contact is not under an account.');
    if (contact.account.type !== 'PARTNER' && contact.account.type !== 'CUSTOMER') throw badRequest('Only contacts at partner or customer accounts can use the portal.');

    // Fail closed on a shared address: the login key must name exactly one person.
    const sharing = await prisma.contact.count({ where: { id: { not: contactId }, deletedAt: null, email: { equals: email, mode: 'insensitive' } } });
    if (sharing > 0) throw badRequest(`${email} is on ${sharing} other contact${sharing === 1 ? '' : 's'} too. Make it unique before granting access.`);
    if (await prisma.portalUser.findFirst({ where: { OR: [{ contactId }, { email }] } })) throw badRequest('This contact already has portal access. Use resend or restore instead.');

    const user = await prisma.portalUser.create({ data: { contactId, email }, select });
    const mail = await issueLinkFor(user.id);
    await audit({ user: request.user, action: 'create', entity: 'PortalUser', entityId: user.id, summary: `Portal access granted to ${email}${mail.ok ? '' : ' (link not sent)'}`, ip: clientIp(request) });
    return reply.status(201).send({ ...shape(user), mail });
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
