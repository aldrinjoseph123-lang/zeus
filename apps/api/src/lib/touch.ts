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
  if (opts.accountId) jobs.push(prisma.account.updateMany({ where: { id: opts.accountId }, data: { lastActivityAt: at } }));
  if (opts.dealId) jobs.push(prisma.deal.updateMany({ where: { id: opts.dealId }, data: { lastActivityAt: at } }));
  if (opts.leadId) jobs.push(prisma.lead.updateMany({ where: { id: opts.leadId }, data: { lastActivityAt: at } }));
  await Promise.all(jobs);
}
