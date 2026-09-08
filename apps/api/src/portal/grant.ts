import { prisma } from '../db.js';
import { badRequest, notFound } from '../lib/http.js';
import { issueLinkFor } from './auth.js';

/**
 * Grant portal access to one contact. The single place the eligibility rules live:
 * a live contact with an email, under a live partner or customer account, whose
 * address no other live contact shares, not already granted. Used by the admin's
 * Grant button and by matching an access request — never by anything a visitor can call.
 */
export const PORTAL_USER_SELECT = {
  id: true, email: true, enabledAt: true, disabledAt: true, lastLoginAt: true, lockedUntil: true, linkExpiresAt: true, passwordHash: true,
  contact: { select: { id: true, firstName: true, lastName: true, isPrimary: true, account: { select: { id: true, name: true, type: true } } } },
} as const;

export function shapePortalUser<T extends { passwordHash: string | null }>(u: T): Omit<T, 'passwordHash'> & { hasPassword: boolean } {
  const { passwordHash, ...rest } = u;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}

export async function grantPortalAccess(contactId: string) {
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

  const user = await prisma.portalUser.create({ data: { contactId, email }, select: PORTAL_USER_SELECT });
  const mail = await issueLinkFor(user.id);
  return { user: shapePortalUser(user), email, mail };
}
