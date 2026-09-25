import { randomBytes } from 'node:crypto';
import { prisma } from '../db.js';
import { env } from '../env.js';

/** A link that stops working a day after the quote does, or after 30 days if it never says. */
const GRACE = 86_400_000;
const DEFAULT_DAYS = 30;

/**
 * The link a customer accepts from. One per quote, reused while it is live: the email
 * and the "copy link" button must hand out the same one, or a colleague copying it after
 * the email went out would quietly kill the link the customer holds.
 */
export async function acceptLinkFor(quote: { id: string; validUntil: Date | null; acceptToken: string | null; acceptTokenExpiresAt: Date | null }): Promise<{ url: string; expiresAt: Date }> {
  const now = Date.now();
  if (quote.acceptToken && quote.acceptTokenExpiresAt && quote.acceptTokenExpiresAt.getTime() > now) {
    return { url: `${env.APP_URL}/q/${quote.acceptToken}`, expiresAt: quote.acceptTokenExpiresAt };
  }
  const token = randomBytes(32).toString('hex');
  const expiresAt = quote.validUntil && quote.validUntil.getTime() + GRACE > now
    ? new Date(quote.validUntil.getTime() + GRACE)
    : new Date(now + DEFAULT_DAYS * 86_400_000);
  await prisma.quote.update({ where: { id: quote.id }, data: { acceptToken: token, acceptTokenExpiresAt: expiresAt } });
  return { url: `${env.APP_URL}/q/${token}`, expiresAt };
}
