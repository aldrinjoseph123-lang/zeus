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
