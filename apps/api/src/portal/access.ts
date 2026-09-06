import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';

/**
 * What a signed-in outsider is, resolved fresh on every request.
 *
 * Nothing here is cached from the cookie beyond the portal user's id: the contact, its
 * account, the account's standing and the section switches are all re-read, so
 * revoking access, deleting a contact, an account's type changing or a customer's last
 * subscription lapsing each close the door on the very next request.
 */
export interface PortalSession {
  portalUserId: string;
  contactId: string;
  accountId: string;
  accountType: 'PARTNER' | 'CUSTOMER';
  accountName: string;
  email: string;
  name: string;
  /** Set when an admin is previewing the portal as this person. */
  viewingAs?: { userId: string; name: string };
}

export async function resolvePortalSession(portalUserId: string, viewingAs?: { userId: string; name: string }): Promise<PortalSession | null> {
  const pu = await prisma.portalUser.findUnique({
    where: { id: portalUserId },
    include: { contact: { include: { account: { select: { id: true, name: true, type: true, deletedAt: true } } } } },
  });
  if (!pu || pu.disabledAt) return null;
  const contact = pu.contact;
  if (contact.deletedAt || contact.erasedAt || !contact.account || contact.account.deletedAt) return null;

  const account = contact.account;
  if (account.type === 'PARTNER') {
    if (!(await getSetting<boolean>('portal.partner.enabled', true))) return null;
  } else if (account.type === 'CUSTOMER') {
    if (!(await getSetting<boolean>('portal.customer.enabled', true))) return null;
    // A customer is a customer while something they bought is still running.
    const live = await prisma.subscription.count({ where: { accountId: account.id, deletedAt: null, status: { in: ['ACTIVE', 'EXPIRING'] } } });
    if (live === 0) return null;
  } else {
    return null;
  }

  return {
    portalUserId: pu.id,
    contactId: contact.id,
    accountId: account.id,
    accountType: account.type,
    accountName: account.name,
    email: pu.email,
    name: `${contact.firstName} ${contact.lastName}`.trim(),
    ...(viewingAs ? { viewingAs } : {}),
  };
}

/** Every portal query goes through this. No route ever reads an account id from the request. */
export function portalScope(session: PortalSession): { accountId: string } {
  return { accountId: session.accountId };
}
