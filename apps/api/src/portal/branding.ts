import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';
import type { PortalSession } from './access.js';

/**
 * What dresses the portal for one visitor: our logo and theirs, a welcome line and a
 * banner for their audience, and how to reach us. All admin-set; nothing here is data
 * about anyone but the company and the signed-in account itself.
 */
export interface PortalBranding {
  companyName: string;
  logo: string | null;
  accountLogo: string | null;
  welcome: string;
  banner: string | null;
  contact: string;
}

export async function brandingFor(session: PortalSession): Promise<PortalBranding> {
  const audience = session.accountType === 'PARTNER' ? 'partner' : 'customer';
  const [companyName, logo, welcome, banner, contact, account] = await Promise.all([
    getSetting<string>('company.name', 'Protect24x7'),
    getSetting<string>('portal.branding.logo', ''),
    getSetting<string>(`portal.branding.welcome.${audience}`, ''),
    getSetting<string>(`portal.branding.banner.${audience}`, ''),
    getSetting<string>('portal.branding.contact', ''),
    prisma.account.findUnique({ where: { id: session.accountId }, select: { portalLogo: true } }),
  ]);
  return {
    companyName,
    logo: logo || null,
    accountLogo: account?.portalLogo ?? null,
    welcome: welcome || (audience === 'partner' ? 'Your registered opportunities and their protection, both with us and with the vendor.' : 'Your services with us, what each includes, and when they renew.'),
    banner: banner || null,
    contact: contact || '',
  };
}
