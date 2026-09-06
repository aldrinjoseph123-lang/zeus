/**
 * Staging only: create or rotate a non-2FA Administrator so `npm run uat` can sign in
 * against the local API when the real admin has two-factor on.
 *
 *   npm run staging:admin        → prints the email and a fresh random password
 *
 * Refuses to run against anything but a local database: a privileged user with no
 * second factor is exactly what production must never have.
 */
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/db.js';
import { env } from '../src/env.js';

const EMAIL = 'uat-admin@example.com';

async function main() {
  const host = new URL(env.DATABASE_URL).hostname;
  if (process.env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '::1'].includes(host)) {
    console.error(`Refusing: DATABASE_URL points at ${host}. This helper is for a local staging database only.`);
    process.exit(2);
  }

  const password = 'Uat-' + randomBytes(9).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  const role = await prisma.role.findFirstOrThrow({ where: { name: 'Administrator' } });
  await prisma.user.upsert({
    where: { email: EMAIL },
    update: { isActive: true, passwordHash, totpSecret: null, totpEnabledAt: null, roleId: role.id },
    create: { email: EMAIL, name: 'UAT Admin (staging)', roleId: role.id, passwordHash },
  });

  const settings = await prisma.setting.findMany({ where: { key: { in: ['auth.require2faForManagers', 'company.trn'] } } });
  const value = (key: string) => settings.find((s) => s.key === key)?.value;
  console.log(`UAT_EMAIL=${EMAIL}`);
  console.log(`UAT_PASSWORD=${password}`);
  if (value('auth.require2faForManagers') === true) console.warn('warning: auth.require2faForManagers is on — admin writes will be refused until this user enrols or the setting is off');
  if (!value('company.trn')) console.warn('warning: company.trn is empty — the invoice step will refuse to issue');
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
