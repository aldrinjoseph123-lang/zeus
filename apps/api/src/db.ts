import { PrismaClient } from '@prisma/client';
import { isProd } from './env.js';

export const prisma = new PrismaClient({
  log: isProd ? ['warn', 'error'] : ['warn', 'error'],
});

/** Prisma Decimal -> number. Safe for AED amounts well under 2^53. */
export function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return typeof v === 'number' ? v : Number(v.toString());
}
