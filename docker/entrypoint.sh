#!/bin/sh
# Wait for Postgres, apply migrations, seed on a fresh database, then start.
set -e

echo "[zeus] waiting for the database…"
tries=0
until node -e "
const { PrismaClient } = require('@prisma/client');
new PrismaClient().\$queryRaw\`SELECT 1\`.then(() => process.exit(0)).catch(() => process.exit(1));
" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 60 ]; then
    echo "[zeus] database did not become reachable after 60 attempts — giving up." >&2
    exit 1
  fi
  sleep 2
done

echo "[zeus] applying schema…"
# db push keeps a single-node install upgradeable without a migration history to babysit.
npx prisma db push --schema prisma/schema.prisma --skip-generate --accept-data-loss

echo "[zeus] seeding defaults (safe to re-run)…"
node dist/seed.js

echo "[zeus] starting API on :${PORT:-4000}"
exec "$@"
