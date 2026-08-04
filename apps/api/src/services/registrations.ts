import { prisma } from '../db.js';
import { getSetting } from '../lib/settings.js';
import { sendMail } from './graph.js';
import { emailTemplate } from './notify.js';

/**
 * Partner-facing registration mail.
 *
 * Vendor-side registrations are chased internally — the rep talks to the vendor.
 * Partner-side registrations protect someone else's deal, so the partner is the one
 * who has to act, and they only find out if we tell them. One message, sent by the
 * scheduler before expiry and by the rep on demand, so the partner never gets two
 * differently worded versions of the same warning.
 */

export interface RegistrationForMail {
  id: string;
  expiresAt: Date | null;
  regNumber: string | null;
  status: string;
  partner: { name: string } | null;
  partnerContact: { firstName: string; lastName: string; email: string | null } | null;
  deal: { reference: string; name: string; account: { name: string } };
}

export type MailResult = { ok: true; to: string } | { ok: false; reason: string };

const dayjs = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / 86_400_000);
}

export async function mailPartnerAboutRegistration(reg: RegistrationForMail): Promise<MailResult> {
  const email = reg.partnerContact?.email?.trim();
  if (!email) return { ok: false, reason: 'No partner contact with an email address is set on this registration.' };
  if (!reg.expiresAt) return { ok: false, reason: 'This registration has no expiry date to warn about.' };

  const left = daysUntil(reg.expiresAt);
  const lapsed = left < 0;
  const company = await getSetting<string>('company.name', 'Protect24x7');

  const title = lapsed
    ? `Deal registration expired — ${reg.deal.account.name}`
    : `Deal registration expires in ${left} day${left === 1 ? '' : 's'} — ${reg.deal.account.name}`;

  const body = lapsed
    ? `Your registration on ${reg.deal.account.name} lapsed on ${dayjs(reg.expiresAt)}. The protection is no longer active. If the opportunity is still live, reply to this email and we will renew it.`
    : `This is a reminder that your registration on ${reg.deal.account.name} runs out on ${dayjs(reg.expiresAt)}. Let us know where the opportunity stands and we will extend the protection if it is still moving.`;

  try {
    await sendMail({
      to: [email],
      subject: title,
      html: emailTemplate(title, body, undefined, [
        { title: 'End customer', value: reg.deal.account.name },
        { title: 'Opportunity', value: reg.deal.name },
        { title: 'Registration', value: reg.regNumber ?? reg.deal.reference },
        { title: lapsed ? 'Expired' : 'Expires', value: dayjs(reg.expiresAt) },
        { title: 'Registered with', value: company },
      ]),
    });
  } catch (err) {
    // Mail is the one part of this that depends on an outside service. A partner who
    // cannot be reached must not fail the rep's action or the nightly job.
    return { ok: false, reason: `Could not send the mail: ${(err as Error).message}` };
  }

  await prisma.dealRegistration.update({ where: { id: reg.id }, data: { partnerNotifiedAt: new Date() } });
  return { ok: true, to: email };
}
