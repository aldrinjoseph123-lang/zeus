import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env, isProd } from './env.js';

/**
 * Prisma 7 connects through a driver adapter rather than its own bundled engine, so
 * the connection string is handed to node-postgres here instead of being read from
 * schema.prisma. The CLI gets the same URL from prisma.config.ts.
 *
 * One adapter (and therefore one pg pool) per process, which is what the single-node
 * deployment wants — the previous PrismaClient managed its own pool the same way.
 */
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: isProd ? ['warn', 'error'] : ['warn', 'error'],
});

/** Prisma Decimal -> number. Safe for AED amounts well under 2^53. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}
