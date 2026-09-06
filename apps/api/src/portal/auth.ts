import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { getSetting } from '../lib/settings.js';
import { sendMail } from '../services/graph.js';
import { emailTemplate } from '../services/notify.js';
import { resolvePortalSession } from './access.js';

/**
 * Passwords for outsiders, set and reset only from an emailed single-use link.
 *
 * The public page never offers to create a password: whoever types an address gets
 * the same "if it's registered, check your inbox" whether the address is a partner,
 * a customer, a contact without access, or nonsense. The link is what proves mailbox
 * control. Lockout counts failed attempts per account, on the same terms as the
 * internal login.
 */

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
/** Compared against when no such user exists, so a missing account costs the same time as a wrong password. */
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/**
 * Send the set/reset link to a portal user — used by the admin's grant and resend, and
 * by the self-serve request below. Only sends when the user would actually be able to
 * sign in; a revoked or unqualified account gets nothing, silently.
 */
export async function issueLinkFor(portalUserId: string): Promise<{ ok: true; to: string } | { ok: false; reason: string }> {
  const session = await resolvePortalSession(portalUserId);
  if (!session) return { ok: false, reason: 'This contact cannot use the portal right now (revoked, or their account no longer qualifies).' };

  const token = randomBytes(32).toString('hex');
  const minutes = Number(await getSetting<number>('portal.link.expiryMinutes', 60));
  await prisma.portalUser.update({
    where: { id: portalUserId },
    data: { linkTokenHash: hashToken(token), linkExpiresAt: new Date(Date.now() + minutes * 60_000) },
  });

  const company = await getSetting<string>('company.name', 'Protect24x7');
  const url = `${env.PORTAL_URL.replace(/\/$/, '')}/set-password?token=${token}`;
  const title = `Set your ${company} portal password`;
  const body = `Use the button below to choose a password for the ${company} portal. The link works once and expires in ${minutes} minutes. If you did not ask for this, ignore it — nothing changes until the link is used.`;
  try {
    await sendMail({ to: [session.email], subject: title, html: emailTemplate(title, body, url, undefined, 'SET PASSWORD') });
  } catch (err) {
    return { ok: false, reason: `Could not send the mail: ${(err as Error).message}` };
  }
  return { ok: true, to: session.email };
}

/** Self-serve "first time / forgot". Deliberately returns nothing: the caller answers the same way regardless. */
export async function requestLink(email: string): Promise<void> {
  const pu = await prisma.portalUser.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!pu) return;
  await issueLinkFor(pu.id).catch(() => undefined);
}

export async function setPasswordFromLink(token: string, password: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const minLength = Number(await getSetting<number>('portal.password.minLength', 12));
  if (password.length < minLength) return { ok: false, reason: `Use at least ${minLength} characters.` };
  // Length carries most of the strength; these two rules stop the obvious weak ones
  // without turning the form into a puzzle: not a single character class, and not
  // built from the address the attacker already knows.
  if (!(/[a-zA-Z]/.test(password) && /[^a-zA-Z]/.test(password))) return { ok: false, reason: 'Mix letters with numbers or symbols.' };

  const pu = await prisma.portalUser.findFirst({ where: { linkTokenHash: hashToken(token) } });
  if (!pu || !pu.linkExpiresAt || pu.linkExpiresAt < new Date()) return { ok: false, reason: 'This link is not valid any more. Ask for a new one from the sign-in page.' };
  const local = pu.email.split('@')[0].toLowerCase();
  if (local.length >= 4 && password.toLowerCase().includes(local)) return { ok: false, reason: 'Do not build the password from your email address.' };
  if (!(await resolvePortalSession(pu.id))) return { ok: false, reason: 'This link is not valid any more. Ask for a new one from the sign-in page.' };

  await prisma.portalUser.update({
    where: { id: pu.id },
    data: { passwordHash: await bcrypt.hash(password, 10), linkTokenHash: null, linkExpiresAt: null, failedAttempts: 0, lockedUntil: null },
  });
  return { ok: true };
}

export async function loginWithPassword(email: string, password: string): Promise<{ ok: true; portalUserId: string } | { ok: false }> {
  const pu = await prisma.portalUser.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!pu || !pu.passwordHash) {
    await bcrypt.compare(password, DUMMY_HASH);
    return { ok: false };
  }
  if (pu.lockedUntil && pu.lockedUntil > new Date()) return { ok: false };

  const attempts = Number(await getSetting<number>('portal.lockout.attempts', 10));
  const lockMinutes = Number(await getSetting<number>('portal.lockout.minutes', 15));

  if (!(await bcrypt.compare(password, pu.passwordHash))) {
    const failed = pu.failedAttempts + 1;
    await prisma.portalUser.update({
      where: { id: pu.id },
      data: { failedAttempts: failed, lockedUntil: failed >= attempts ? new Date(Date.now() + lockMinutes * 60_000) : null },
    });
    return { ok: false };
  }
  if (!(await resolvePortalSession(pu.id))) return { ok: false };

  await prisma.portalUser.update({ where: { id: pu.id }, data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() } });
  return { ok: true, portalUserId: pu.id };
}
