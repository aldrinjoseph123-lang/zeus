import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 chars — run: openssl rand -hex 32'),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  APP_URL: z.string().url().default('http://localhost:5174'),
  CORS_ORIGINS: z.string().default('http://localhost:5174'),
  SEED_ADMIN_EMAIL: z.string().email().default('admin@protect24x7.ae'),
  SEED_ADMIN_PASSWORD: z.string().default('ChangeMe#2026'),
  UPLOAD_DIR: z.string().default('./uploads'),
  BACKUP_DIR: z.string().default('./backups'),
  PG_DUMP_PATH: z.string().default('pg_dump'),
  M365_TENANT_ID: z.string().optional(),
  M365_CLIENT_ID: z.string().optional(),
  M365_CLIENT_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
