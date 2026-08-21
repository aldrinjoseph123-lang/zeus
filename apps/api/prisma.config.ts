import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the CLI's connection details out of schema.prisma. This is what
 * `prisma migrate` / `prisma studio` read; the running application does not use it —
 * it hands PrismaClient a driver adapter instead (see src/db.ts).
 *
 * Kept as a separate concern deliberately: the CLI needs a plain connection string to
 * run migrations (including at container start, via docker/entrypoint.sh), while the
 * app connects through the adapter's pool.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
