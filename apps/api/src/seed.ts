import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';
import { SYSTEM_ROLES } from './auth/rbac.js';
import { ensureNotificationRules } from './services/notify.js';
import { SETTING_DEFAULTS } from './lib/settings.js';

/**
 * Idempotent seed. Safe to re-run after an upgrade: it creates what is missing
 * and leaves anything you have since edited alone.
 */

const prisma = new PrismaClient();

const STANDARD_STAGES = [
  { name: 'New', order: 0, probability: 10, color: '#6b6b6b', rotDays: 7, isWon: false, isLost: false },
  { name: 'Qualified', order: 1, probability: 25, color: '#4a4a4a', rotDays: 14, isWon: false, isLost: false },
  { name: 'Proposal', order: 2, probability: 50, color: '#d97a1f', rotDays: 14, isWon: false, isLost: false },
  { name: 'Negotiation', order: 3, probability: 75, color: '#e11d2e', rotDays: 10, isWon: false, isLost: false },
  { name: 'Closed Won', order: 4, probability: 100, color: '#1f8a4c', rotDays: 30, isWon: true, isLost: false },
  { name: 'Closed Lost', order: 5, probability: 0, color: '#9e0e19', rotDays: 30, isWon: false, isLost: true },
];

/** The five managed service lines Protect24x7 sells, ready to quote on day one. */
const SERVICE_LINES = [
  { sku: 'SVC-MDR', name: 'Managed Detection & Response', unit: 'endpoint', listPrice: 55, cost: 30, description: '24x7 detection and response across endpoint, network and cloud.' },
  { sku: 'SVC-SOC', name: 'SOC-as-a-Service', unit: 'month', listPrice: 18000, cost: 11000, description: 'Round-the-clock monitoring from the UAE-based SOC.' },
  { sku: 'SVC-VM', name: 'Vulnerability Management', unit: 'device', listPrice: 42, cost: 22, description: 'Continuous scanning, prioritisation and remediation guidance.' },
  { sku: 'SVC-IR', name: 'Incident Response', unit: 'day', listPrice: 9500, cost: 5200, description: 'Rapid containment and recovery retainer.' },
  { sku: 'SVC-VCISO', name: 'vCISO Advisory', unit: 'day', listPrice: 8500, cost: 4500, description: 'Fractional security leadership: strategy, audits, compliance.' },
];

async function main(): Promise<void> {
  console.log('▸ Seeding Zeus…');

  // ── roles ─────────────────────────────────────────────────────────────────
  for (const role of SYSTEM_ROLES) {
    const existing = await prisma.role.findUnique({ where: { name: role.name } });
    if (existing) {
      console.log(`  role "${role.name}" already exists — left as configured`);
      continue;
    }
    await prisma.role.create({
      data: { name: role.name, description: role.description, isSystem: true, permissions: role.permissions as never },
    });
    console.log(`  + role ${role.name}`);
  }

  // ── teams (the two-team structure from the website) ───────────────────────
  for (const team of [
    { name: 'Product Team', kind: 'product' },
    { name: 'Service Team', kind: 'service' },
  ]) {
    await prisma.team.upsert({ where: { name: team.name }, create: team, update: {} });
  }

  // ── bootstrap administrator ───────────────────────────────────────────────
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: 'Administrator' } });
  const adminEmail = (process.env.SEED_ADMIN_EMAIL ?? 'admin@protect24x7.ae').toLowerCase();
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!existingAdmin) {
    const password = process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe#2026';
    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Zeus Administrator',
        passwordHash: await bcrypt.hash(password, 10),
        roleId: adminRole.id,
        jobTitle: 'System Administrator',
      },
    });
    console.log(`  + admin ${adminEmail}  (password from SEED_ADMIN_PASSWORD — change it after first sign-in)`);
  } else {
    console.log(`  admin ${adminEmail} already exists`);
  }

  // ── pipeline ──────────────────────────────────────────────────────────────
  if ((await prisma.pipeline.count()) === 0) {
    await prisma.pipeline.create({
      data: {
        name: 'Sales Pipeline',
        kind: 'product',
        isDefault: true,
        order: 0,
        stages: { create: STANDARD_STAGES },
      },
    });
    console.log('  + pipeline "Sales Pipeline" with 6 stages');
  }

  // ── settings ──────────────────────────────────────────────────────────────
  let newSettings = 0;
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    const existing = await prisma.setting.findUnique({ where: { key } });
    if (existing) continue;
    await prisma.setting.create({ data: { key, value: value as never, category: key.split('.')[0] } });
    newSettings += 1;
  }
  if (newSettings) console.log(`  + ${newSettings} default setting(s)`);

  // ── notification rules ────────────────────────────────────────────────────
  // Same sync the API runs at boot, so there is one definition of what a new event
  // gets rather than two that drift.
  const newRules = await ensureNotificationRules();
  if (newRules) console.log(`  + ${newRules} notification rule(s)`);

  // ── service catalogue ─────────────────────────────────────────────────────
  let newProducts = 0;
  for (const line of SERVICE_LINES) {
    const existing = await prisma.product.findUnique({ where: { sku: line.sku } });
    if (existing) continue;
    await prisma.product.create({
      data: { ...line, type: 'SERVICE', category: 'Managed Security', taxable: true, currency: 'AED' },
    });
    newProducts += 1;
  }
  if (newProducts) console.log(`  + ${newProducts} managed service line(s)`);

  console.log('▸ Done.\n');
  console.log('  Next: sign in, then Settings → Integrations to connect Microsoft 365,');
  console.log('  and Settings → Company to set your TRN and letterhead details.\n');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
