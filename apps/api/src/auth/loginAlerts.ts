import { prisma } from '../db.js';
import { env } from '../env.js';
import { describeWhere } from '../lib/whereFrom.js';
import { emailTemplate, notify } from '../services/notify.js';
import { sendMail } from '../services/graph.js';

/**
 * "Was this you?"
 *
 * The sessions list only catches a stranger if somebody thinks to look. This is the
 * half that goes and finds them: a sign-in from a device or a country this account has
 * not used in the last three months tells the person and the administrators, once.
 *
 * Deliberately quiet in the ordinary case. A first sign-in has nothing to compare
 * against and says nothing; a familiar laptop in a familiar country says nothing; and
 * a single sign-in raises at most one alert, so a new phone abroad is one message
 * rather than two.
 */

/** How far back counts as "familiar". Long enough to cover a quarter away from a device. */
const HISTORY_DAYS = 90;

interface Seen { devices: Set<string>; countries: Set<string> }

async function seenBefore(where: { userId?: string; portalUserId?: string }, exceptSessionId: string): Promise<Seen | null> {
  const rows = await prisma.session.findMany({
    where: {
      ...(where.userId ? { userId: where.userId } : {}),
      ...(where.portalUserId ? { portalUserId: where.portalUserId } : {}),
      id: { not: exceptSessionId },
      createdAt: { gte: new Date(Date.now() - HISTORY_DAYS * 86_400_000) },
    },
    select: { device: true, country: true },
  });
  // No history at all: this is the first sign-in we know of, and everything about it
  // would look new. Saying so would be noise, not a warning.
  if (rows.length === 0) return null;
  return {
    devices: new Set(rows.map((r) => r.device).filter((d): d is string => Boolean(d))),
    countries: new Set(rows.map((r) => r.country).filter((c): c is string => Boolean(c))),
  };
}

/**
 * Judge one sign-in and alert if it is unfamiliar. Called after the location has been
 * resolved, never awaited by the sign-in itself — an alert must not be able to keep
 * someone waiting at the door, or to stop them getting in when the mail server is down.
 */
export async function alertOnNewSignIn(sessionId: string): Promise<void> {
  const s = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true, device: true, ip: true, city: true, region: true, country: true, isp: true, createdAt: true, viewingAsId: true,
      user: { select: { id: true, name: true, email: true } },
      portalUser: { select: { id: true, email: true, contact: { select: { firstName: true } } } },
    },
  });
  if (!s) return;
  // A preview is an administrator looking on purpose, not a stranger arriving.
  if (s.viewingAsId) return;

  const who = s.user ? { userId: s.user.id } : s.portalUser ? { portalUserId: s.portalUser.id } : null;
  if (!who) return;

  const seen = await seenBefore(who, s.id);
  if (!seen) return;

  const newCountry = Boolean(s.country) && !seen.countries.has(s.country!);
  const newDevice = Boolean(s.device) && !seen.devices.has(s.device!);
  if (!newCountry && !newDevice) return;

  // One sign-in, one alert. A new country is the louder signal, so it names the event
  // even when the device is new too — the body says both either way.
  const event = newCountry ? 'login_new_country' : 'login_new_device';
  const name = s.user?.name ?? s.portalUser?.contact?.firstName ?? s.portalUser?.email ?? 'Someone';
  const place = describeWhere(s);
  const what = newCountry && newDevice ? 'a new device, in a country' : newCountry ? 'a country' : 'a device';
  const title = `${name} signed in from ${what} not used before`;
  const body = `${s.device ?? 'An unknown device'} · ${place}.`;
  const facts = [
    { title: 'Device', value: s.device ?? 'Unknown' },
    { title: 'Where', value: place },
    { title: 'When', value: s.createdAt.toLocaleString('en-GB', { timeZone: 'Asia/Dubai' }) },
  ];

  if (s.user) {
    // The person and the administrators, whatever the rule's audience is set to: being
    // told about your own account is not something an admin should be able to switch off.
    await notify({
      event, title, body, facts, severity: 'warn',
      link: '/settings/profile',
      ownerId: s.user.id,
      userIds: [s.user.id],
    });
    return;
  }

  // A portal user has no account inside Zeus to receive an in-app notice, so they get
  // the mail directly and the administrators get the in-app alert.
  const to = s.portalUser!.email;
  const heading = 'Was this you?';
  const mail = emailTemplate(
    heading,
    `${body} If this was not you, change your password and tell your Protect24x7 contact.`,
    `${env.PORTAL_URL.replace(/\/$/, '')}/sign-in`,
    facts,
    'GO TO THE PORTAL',
  );
  await sendMail({ to: [to], subject: `[Protect24x7] ${heading}`, html: mail, log: { kind: 'notification', entity: 'PortalUser', entityId: s.portalUser!.id } })
    .catch((err) => console.error('[login-alert] could not mail the portal user:', (err as Error).message));
  await notify({ event, title: `${title} (portal)`, body: `${to} · ${body}`, facts, severity: 'warn', link: '/settings/sessions' });
}
