// Must come first: TEST_URL below is derived from DATABASE_URL, and without .env
// loaded that read returns undefined and falls through to a default with no username.
// Prisma 6 hid this — its Rust engine defaulted the user the way libpq does — but the
// Prisma 7 pg adapter does not, and the connection is refused outright.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
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

// Prisma 7 dropped the `datasources` override in favour of a driver adapter, so the
// test database is targeted by pointing the adapter at TEST_URL rather than by
// overriding a URL the client read from the schema.
export const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }) });

/** Every table, child-first, so truncation never trips a foreign key. */
/**
 * Every table, asked of the database rather than listed here.
 *
 * This used to be a hand-written array, and it went stale the moment a model was added
 * with no parent to cascade from — Webhook rows survived the reset and leaked between
 * tests, which showed up as a count assertion failing for reasons that had nothing to do
 * with the test that failed. A list of tables is the database's job to remember.
 */
let tableCache: string[] | null = null;

async function allTables(): Promise<string[]> {
  if (tableCache) return tableCache;
  const rows = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
  `;
  tableCache = rows.map((r) => r.tablename);
  return tableCache;
}

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
  const tables = await allTables();
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
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
  const { invalidateSettings } = await import('../lib/settings.js');

  const roles = new Map<string, string>();
  for (const preset of SYSTEM_ROLES) {
    const role = await prisma.role.create({
      data: { name: preset.name, description: preset.description, isSystem: true, permissions: preset.permissions as never },
    });
    roles.set(preset.name, role.id);
  }

  // A VAT-registered supplier is the realistic starting state, and issuing a tax invoice
  // now refuses without it — the suite should not be quietly producing invalid documents.
  await prisma.setting.upsert({
    where: { key: 'company.trn' },
    create: { key: 'company.trn', value: '100123456700003' as never, category: 'company' },
    update: { value: '100123456700003' as never },
  });

  invalidateSettings();

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
    let body: unknown;
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
