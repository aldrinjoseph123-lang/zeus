import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { notify } from './notify.js';

/**
 * The weekly partner digest.
 *
 * A page someone has to remember to open is a page that gets opened in the first fortnight
 * and then not again. This takes the same question the register answers — who have I not
 * seen — and puts it in front of the person responsible, once a week, on Monday morning
 * before the week is committed.
 *
 * It is **silent when nothing is overdue**, which is the whole of what keeps it from
 * becoming noise. A weekly message that always arrives is a weekly message people filter.
 */

export interface OverduePartner {
  id: string;
  name: string;
  channelManagerId: string;
  lastContactAt: Date | null;
  cadenceDays: number;
  overdueDays: number;
}

/**
 * Partners past their rhythm, with the manager responsible for each.
 *
 * Dormant partners are excluded: they keep their history and their registrations still
 * expire, they are simply not being chased — which is the entire point of the state.
 * Partners with no channel manager are excluded too, because there is nobody to tell;
 * they are counted on the register instead, where somebody can assign one.
 */
export async function overduePartners(): Promise<OverduePartner[]> {
  const houseCadence = Number(await getSetting<number>('partners.contactCadenceDays', 30));
  const partners = await prisma.account.findMany({
    where: { type: 'PARTNER', deletedAt: null, isDormant: false, channelManagerId: { not: null } },
    select: { id: true, name: true, channelManagerId: true, lastContactAt: true, engagementCadenceDays: true },
  });

  const now = Date.now();
  return partners
    .map((p) => {
      const cadenceDays = p.engagementCadenceDays ?? houseCadence;
      // Never contacted is overdue by the whole rhythm, not by nothing. It is exactly the
      // partner most likely to have been forgotten, so it must not sort to the bottom.
      const overdueDays = p.lastContactAt
        ? Math.floor((now - p.lastContactAt.getTime()) / 86_400_000) - cadenceDays
        : cadenceDays;
      return { ...p, channelManagerId: p.channelManagerId!, cadenceDays, overdueDays };
    })
    .filter((p) => p.overdueDays > 0)
    .sort((a, b) => b.overdueDays - a.overdueDays);
}

const line = (p: OverduePartner) =>
  `${p.name} — ${p.lastContactAt ? `${p.overdueDays + p.cadenceDays} days since contact` : 'never contacted'}`;

/**
 * One message per channel manager, listing only their own partners.
 *
 * `notify()` already takes named recipients rather than only roles, already offers in-app,
 * email and Teams per event, and already defers to quiet hours — so this is a job that
 * groups by manager and calls it, not a new delivery mechanism.
 */
export async function sendWeeklyPartnerDigest(): Promise<{ managers: number; partners: number }> {
  const overdue = await overduePartners();
  if (overdue.length === 0) return { managers: 0, partners: 0 };

  const byManager = new Map<string, OverduePartner[]>();
  for (const p of overdue) {
    const list = byManager.get(p.channelManagerId) ?? [];
    list.push(p);
    byManager.set(p.channelManagerId, list);
  }

  for (const [managerId, partners] of byManager) {
    await notify({
      event: 'partners_overdue',
      title: `${partners.length} partner${partners.length === 1 ? '' : 's'} waiting to hear from you`,
      // Five is enough to act on; the rest is a link away, and a list nobody finishes
      // reading is a list nobody starts.
      body: partners.slice(0, 5).map(line).join('\n') + (partners.length > 5 ? `\n…and ${partners.length - 5} more.` : ''),
      link: '/partners',
      severity: 'info',
      ownerId: managerId,
      facts: [
        { title: 'Longest wait', value: `${partners[0].overdueDays} days past due` },
        { title: 'Partners', value: String(partners.length) },
      ],
    });
  }

  return { managers: byManager.size, partners: overdue.length };
}

/**
 * The individual nudge, for a partner that has gone past twice its rhythm.
 *
 * Separate from the weekly list because it is a different message: the digest says "here
 * is your week", this says "this one has been let go". Sent at most once per crossing —
 * `nudgedAt` is stamped when it fires and cleared by the next logged contact — so a badly
 * neglected partner cannot produce the same alert every day until someone acts.
 */
export async function nudgeBadlyOverdue(): Promise<number> {
  const overdue = await overduePartners();
  const badly = overdue.filter((p) => p.overdueDays >= p.cadenceDays);
  if (badly.length === 0) return 0;

  const unnudged = await prisma.account.findMany({
    where: { id: { in: badly.map((p) => p.id) }, nudgedAt: null },
    select: { id: true },
  });
  const due = badly.filter((p) => unnudged.some((u) => u.id === p.id));

  for (const p of due) {
    await notify({
      event: 'partner_badly_overdue',
      // "Never" is not a number of days. Reporting a never-contacted partner as "60 days"
      // is arithmetic dressed up as a fact, and the true answer is the more alarming one.
      title: p.lastContactAt
        ? `${p.name} has not been contacted in ${p.overdueDays + p.cadenceDays} days`
        : `${p.name} has never been contacted`,
      body: p.lastContactAt
        ? `Their rhythm is every ${p.cadenceDays} days. This is more than twice that.`
        : `They have been on the register since it was created, with nothing logged against them.`,
      link: `/accounts/${p.id}`,
      severity: 'warn',
      ownerId: p.channelManagerId,
    });
  }
  if (due.length) {
    await prisma.account.updateMany({ where: { id: { in: due.map((p) => p.id) } }, data: { nudgedAt: new Date() } });
  }
  return due.length;
}
