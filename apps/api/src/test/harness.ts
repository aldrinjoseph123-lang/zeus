import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';

/**
 * Integration harness.
 *
 * These tests drive the real app: real routes, real middleware, real Prisma, real
 * PostgreSQL. Only the network is skipped — `app.inject()` puts a request through the
 * full Fastify lifecycle without binding a port, so what is exercised is exactly what
 * production runs.
 *
 * They use their own database. `TEST_DATABASE_URL` decides which, defaulting to
 * `zeus_test`, and the guard below refuses to run against anything that does not look
 * like a test database — a suite that truncates tables must never be one typo away
 * from the development data.
 */

const TEST_URL =
  process.env.TEST_DATABASE_URL ??
  (process.env.DATABASE_URL ?? 'postgresql://localhost:5432/zeus').replace(/\/([^/?]+)(\?|$)/, '/zeus_test$2');

if (!/zeus_test/.test(TEST_URL)) {
  throw new Error(`Refusing to run tests against "${TEST_URL}" — the database name must contain "zeus_test".`);
}

process.env.DATABASE_URL = TEST_URL;
process.env.NODE_ENV = 'test';
process.env.APP_SECRET ??= 'test-secret-not-used-anywhere-else-0123456789';
process.env.APP_URL ??= 'http://localhost:4000';

export const prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

/** Every table, child-first, so truncation never trips a foreign key. */
const TABLES = [
  'Payment', 'InvoiceLine', 'Invoice', 'PurchaseOrderLine', 'PurchaseOrder',
  'QuoteLine', 'Quote', 'Subscription', 'DealRegistration', 'StageHistory', 'Deal',
  'Activity', 'Attachment', 'Contact', 'Lead', 'Account', 'Product',
  'Notification', 'AuditLog', 'ImportJob', 'Target', 'Counter',
  'NotificationRule', 'TeamsWebhook', 'Setting', 'Integration',
  'User', 'Role', 'Team', 'Stage', 'Pipeline',
];

let migrated = false;

/** Applies the migration history to the test database, once per run. */
export function migrateTestDatabase(): void {
  if (migrated) return;
  execFileSync('npx', ['prisma', 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    env: { ...process.env, DATABASE_URL: TEST_URL },
    stdio: 'pipe',
  });
  migrated = true;
}

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
  roleName: string;
  cookie: string;
}

export interface Fixtures {
  app: FastifyInstance;
  admin: TestUser;
  manager: TestUser;
  rep: TestUser;
  otherRep: TestUser;
  pipeline: { id: string; stages: Array<{ id: string; name: string; isWon: boolean; isLost: boolean }> };
  customer: { id: string; name: string };
  vendor: { id: string; name: string };
}

/**
 * Builds the world each suite starts from: four roles that actually differ, a pipeline,
 * a customer and a vendor. Roles come from the shipped presets so the tests assert the
 * permissions the product really ships with, not a convenient fiction.
 */
export async function seedFixtures(app: FastifyInstance): Promise<Fixtures> {
  const { SYSTEM_ROLES } = await import('../auth/rbac.js');

  const roles = new Map<string, string>();
  for (const preset of SYSTEM_ROLES) {
    const role = await prisma.role.create({
      data: { name: preset.name, description: preset.description, isSystem: true, permissions: preset.permissions as never },
    });
    roles.set(preset.name, role.id);
  }

  const team = await prisma.team.create({ data: { name: 'Test Team', kind: 'product' } });
  const passwordHash = await bcrypt.hash('Passw0rd!Test', 10);

  // Cookies are minted, not fetched: driving /api/auth/login four times per test would
  // hit the login rate limit within a couple of tests, and that limit is a control the
  // suite should be protecting rather than switching off. One test still logs in for
  // real, which is what proves the endpoint itself.
  const { SESSION_COOKIE, signSessionToken } = await import('../auth/session.js');

  const make = async (name: string, roleName: string, teamId: string | null) => {
    const user = await prisma.user.create({
      data: { email: `${name}@test.local`, name, passwordHash, roleId: roles.get(roleName)!, teamId },
    });
    const token = await signSessionToken(user.id, 12);
    return { id: user.id, email: user.email, name, roleName, cookie: `${SESSION_COOKIE}=${token}` };
  };

  const admin = await make('admin', 'Administrator', team.id);
  const manager = await make('manager', 'Sales Manager', team.id);
  const rep = await make('rep', 'Sales Executive', team.id);
  // Deliberately on no team: "team" scope must not reach them.
  const otherRep = await make('otherrep', 'Sales Executive', null);

  const pipeline = await prisma.pipeline.create({
    data: {
      name: 'Sales', kind: 'product', isDefault: true, isActive: true,
      stages: {
        create: [
          { name: 'New', order: 0, probability: 10, color: '#b8b8b4' },
          { name: 'Proposal', order: 1, probability: 50, color: '#d97a1f' },
          { name: 'Closed Won', order: 2, probability: 100, color: '#1f8a4c', isWon: true },
          { name: 'Closed Lost', order: 3, probability: 0, color: '#e11d2e', isLost: true },
        ],
      },
    },
    include: { stages: { orderBy: { order: 'asc' } } },
  });

  const customer = await prisma.account.create({
    data: { name: 'Test Customer LLC', type: 'CUSTOMER', domain: 'testcustomer.ae', ownerId: rep.id },
  });
  const vendor = await prisma.account.create({ data: { name: 'Test Vendor', type: 'VENDOR' } });

  return { app, admin, manager, rep, otherRep, pipeline, customer, vendor };
}

/**
 * Parsed JSON from a response. Deliberately loose: assertions in the suites read many
 * different response shapes, and typing each one would add noise without catching
 * anything the assertion itself does not.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = any;

/** `request(user).post('/api/deals', body)` — the shape the suites read best. */
export function request(app: FastifyInstance, user?: TestUser) {
  const headers = user ? { cookie: user.cookie } : {};
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
    let body: unknown = null;
    try {
      body = res.body ? JSON.parse(res.body) : null;
    } catch {
      body = res.body;
    }
    return { status: res.statusCode, body: body as JsonBody, raw: res };
  };

  return {
    get: (url: string) => call('GET', url),
    post: (url: string, payload?: unknown) => call('POST', url, payload ?? {}),
    patch: (url: string, payload?: unknown) => call('PATCH', url, payload ?? {}),
    put: (url: string, payload?: unknown) => call('PUT', url, payload ?? {}),
    del: (url: string) => call('DELETE', url),
  };
}
