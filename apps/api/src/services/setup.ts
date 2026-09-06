/**
 * First-run setup checklist.
 *
 * What a fresh Zeus needs before it runs the way it is meant to: the company's own
 * details (required — no tax invoice issues without them), then the integrations
 * and safety nets that are each one Settings page away. The wizard page walks the
 * list; anything not done stays under the notification bell until it is. Skipping
 * hides an item from the wizard, not from the bell — "later" is not "never".
 *
 * Every check reads real state rather than a "configured" flag someone has to keep
 * true: an integration counts once its secret is stored, backups once one has
 * actually succeeded with automation on.
 */
import { prisma } from '../db.js';
import { getSetting, getSettings, setSetting, SETUP_REQUIRED } from '../lib/settings.js';

export interface SetupItem {
  key: string;
  label: string;
  description: string;
  /** Settings page where this gets done. */
  href: string;
  required: boolean;
  done: boolean;
  skipped: boolean;
}

export interface SetupStatus {
  /** Every required item is done. */
  complete: boolean;
  /** The admin has pressed Finish; the wizard stops opening on sign-in. */
  finished: boolean;
  items: SetupItem[];
  /** Company fields, for the banner on the Company page. */
  required: Array<{ key: string; label: string }>;
  missing: Array<{ key: string; label: string }>;
}

export const SETUP_KEYS = ['company', 'microsoft365', 'whatsapp', 'teams', 'backups', 'twoFactor', 'team'] as const;

export async function setupStatus(userId: string): Promise<SetupStatus> {
  const [company, integrations, webhooks, activeUsers, goodBackups, backupEnabled, me, skipped, finishedAt] = await Promise.all([
    getSettings('company.'),
    prisma.integration.findMany({ select: { provider: true, isConnected: true, secrets: true } }),
    prisma.teamsWebhook.count(),
    prisma.user.count({ where: { isActive: true } }),
    // 'partial' = the local copy landed and only the upload failed; the safety net exists.
    prisma.backupRun.count({ where: { status: { in: ['success', 'partial'] } } }),
    getSetting<boolean>('backup.enabled', false),
    prisma.user.findUnique({ where: { id: userId }, select: { totpEnabledAt: true } }),
    getSetting<string[]>('setup.skipped', []),
    getSetting<string | null>('setup.finishedAt', null),
  ]);

  const missing = SETUP_REQUIRED.filter(({ key, valid }) => {
    const v = String(company[key] ?? '').trim();
    return !v || (valid ? !valid(v) : false);
  });
  const strip = ({ key, label }: { key: string; label: string }) => ({ key, label });
  const configured = (provider: string) => integrations.some((i) => i.provider === provider && (i.isConnected || Boolean(i.secrets)));
  const skippedSet = new Set(Array.isArray(skipped) ? skipped : []);

  const defs: Array<Omit<SetupItem, 'skipped'>> = [
    { key: 'company', label: 'Company details', description: 'Legal name, TRN and address — printed on every quote and tax invoice.', href: '/settings/company', required: true, done: missing.length === 0 },
    { key: 'microsoft365', label: 'Office 365', description: 'Staff sign-in with Microsoft, email sending, and OneDrive as a backup destination.', href: '/settings/integrations', required: false, done: configured('microsoft365') },
    { key: 'whatsapp', label: 'WhatsApp alerts', description: 'Critical alerts to a phone through the WhatsApp Business API.', href: '/settings/integrations', required: false, done: configured('whatsapp') },
    { key: 'teams', label: 'Teams notifications', description: 'A channel webhook so deal and system events land where the team already looks.', href: '/settings/notifications', required: false, done: webhooks > 0 },
    { key: 'backups', label: 'Backups', description: 'Turn on the nightly schedule and let the first run succeed. Add a NAS path or OneDrive so a copy leaves this server.', href: '/settings/backups', required: false, done: backupEnabled === true && goodBackups > 0 },
    { key: 'twoFactor', label: 'Two-factor for your account', description: 'The administrator account can reach everything; put a second factor on it.', href: '/settings/profile', required: false, done: Boolean(me?.totpEnabledAt) },
    { key: 'team', label: 'Invite the team', description: 'Add the people who will use Zeus and give each a role.', href: '/settings/users', required: false, done: activeUsers > 1 },
  ];
  const items = defs.map((d) => ({ ...d, skipped: skippedSet.has(d.key) }));

  return {
    complete: items.every((i) => !i.required || i.done),
    finished: Boolean(finishedAt),
    items,
    required: SETUP_REQUIRED.map(strip),
    missing: missing.map(strip),
  };
}

export async function setSkipped(key: string, skipped: boolean): Promise<void> {
  const current = new Set(await getSetting<string[]>('setup.skipped', []));
  if (skipped) current.add(key); else current.delete(key);
  await setSetting('setup.skipped', [...current], 'setup');
}

export async function finishSetup(): Promise<void> {
  await setSetting('setup.finishedAt', new Date().toISOString(), 'setup');
}
