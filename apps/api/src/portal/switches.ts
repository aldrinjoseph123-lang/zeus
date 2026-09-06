import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';

/**
 * The three layers of control, resolved for one account.
 *
 *   code allowlist  →  global switch (Settings → Portal access)  →  per-account override
 *
 * The allowlist is this file: a switch that is not named here does not exist, whatever
 * a setting or an override says. The global switch sets the default for everyone; an
 * account's override can turn a field on or off for that account only. Neither can
 * reach a field the code never allowed out.
 */
export const PARTNER_SWITCHES = {
  showRegNumber: { setting: 'portal.partner.showRegNumber', fallback: true, label: 'Vendor registration number' },
  showDealValue: { setting: 'portal.partner.showDealValue', fallback: false, label: 'Deal value' },
} as const;
export type PartnerSwitch = keyof typeof PARTNER_SWITCHES;
export type PartnerOverrides = Partial<Record<PartnerSwitch, boolean>>;

export async function resolvePartnerSwitches(accountId: string): Promise<Record<PartnerSwitch, boolean>> {
  const account = await prisma.account.findUnique({ where: { id: accountId }, select: { portalOverrides: true } });
  const overrides = sanitizeOverrides(account?.portalOverrides);
  const out = {} as Record<PartnerSwitch, boolean>;
  for (const key of Object.keys(PARTNER_SWITCHES) as PartnerSwitch[]) {
    const global = await getSetting<boolean>(PARTNER_SWITCHES[key].setting, PARTNER_SWITCHES[key].fallback);
    out[key] = key in overrides ? overrides[key]! : global;
  }
  return out;
}

/** Keeps only known switches with boolean values — an override naming anything else is dropped. */
export function sanitizeOverrides(raw: unknown): PartnerOverrides {
  const out: PartnerOverrides = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(PARTNER_SWITCHES) as PartnerSwitch[]) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'boolean') out[key] = v;
  }
  return out;
}

/** A logo an admin uploaded: a data URL, an image, small. Anything else is refused. */
export function validLogo(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value)) return false;
  return value.length <= 200_000; // ≈150 KB decoded
}
