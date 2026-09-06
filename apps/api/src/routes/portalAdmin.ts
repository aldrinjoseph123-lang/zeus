import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, clientIp, notFound, requirePermission } from '../lib/http.js';
import { issueLinkFor } from '../portal/auth.js';
import { signViewAsToken } from '../portal/session.js';
import { env } from '../env.js';

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
