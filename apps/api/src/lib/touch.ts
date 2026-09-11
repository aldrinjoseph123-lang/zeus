import { prisma } from '../db.js';

/**
 * Roll lastActivityAt forward on the records an event relates to.
 * This single timestamp is what the stale-account alert and the "rotting deal"
 * board colouring both read, so every write path calls it.
 */
export async function touch(opts: {
  accountId?: string | null;
  dealId?: string | null;
  leadId?: string | null;
  at?: Date;
}): Promise<void> {
  const at = opts.at ?? new Date();
  const jobs: Promise<unknown>[] = [];
  // Every caller today passes a Zod-validated or Prisma-read string, but `where: { id: X }`
  // in an `updateMany` turns into a filter object (not an equality check) if X is ever
  // anything but a plain string — a `typeof` guard here closes that off for every caller
  // at once, present and future, rather than trusting each call site to validate first.
  if (typeof opts.accountId === 'string') jobs.push(prisma.account.updateMany({ where: { id: opts.accountId }, data: { lastActivityAt: at } }));
  if (typeof opts.dealId === 'string') jobs.push(prisma.deal.updateMany({ where: { id: opts.dealId }, data: { lastActivityAt: at } }));
  if (typeof opts.leadId === 'string') jobs.push(prisma.lead.updateMany({ where: { id: opts.leadId }, data: { lastActivityAt: at } }));
  await Promise.all(jobs);
}

/** Activity types that mean a person actually dealt with someone. */
const CONTACT_TYPES = new Set(['VISIT', 'CALL', 'MEETING', 'EMAIL']);

/**
 * "When did we last speak to them", which is not what `touch` above records.
 *
 * `lastActivityAt` rolls forward whenever anything under an account changes — a quote,
 * an invoice, a payment, a contact edited, a task booked for next month. That is the
 * right meaning for a stale *customer*: a paid invoice is not a neglected account. It is
 * the wrong meaning for a partner rhythm, because the follow-up task booked at the end of
 * every visit would reset the clock the visit was meant to start.
 *
 * So this one is narrow on purpose: a visit, call, meeting or email, and only once it is
 * actually completed. A note does not count, and neither does a task still to do.
 */
export async function touchContact(opts: {
  accountId?: string | null;
  type: string;
  status: string;
  at?: Date;
}): Promise<void> {
  if (typeof opts.accountId !== 'string') return;
  if (!CONTACT_TYPES.has(opts.type) || opts.status !== 'Completed') return;
  const at = opts.at ?? new Date();
  // Never walk the clock backwards: editing an old visit should not make a partner look
  // more neglected than the last thing actually done with them.
  await prisma.account.updateMany({
    where: { id: opts.accountId, OR: [{ lastContactAt: null }, { lastContactAt: { lt: at } }] },
    data: { lastContactAt: at },
  });
}
