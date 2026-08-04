# Zeus CRM — single image: API + built frontend.
# Multi-stage so the runtime layer carries no toolchain.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# postgresql-client gives us pg_dump for the OneDrive backup job.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# ci, not install: the lockfile decides, so an image built today matches one built in
# six months. Install scripts stay on because Prisma fetches its engines in one.
RUN npm ci --include=dev

COPY apps/api/prisma apps/api/prisma
RUN npx prisma generate --schema apps/api/prisma/schema.prisma

COPY . .
RUN npm run build --workspace=apps/api \
    && npm run build --workspace=apps/web

# Drop dev dependencies from the tree we ship.
RUN npm prune --omit=dev

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# postgresql-client must match the *server* major version: pg_dump refuses to dump a
# newer server than itself, and Debian bookworm only ships client 15 while the db
# service runs Postgres 17. Pull the client from the PostgreSQL project's own repo.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates curl gnupg tini \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
         https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 \
    && apt-get purge -y curl gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# /data is where the named volume mounts. Creating it in the image first means Docker
# seeds the empty volume with these permissions, so the unprivileged user can write
# uploads and backups into it.
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data/uploads /data/backups \
    && chown -R node:node /app /data

USER node
WORKDIR /app/apps/api
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server.js"]
