#!/usr/bin/env bash
#
# Zeus — update production to a release tag.
#
#   ./docker/deploy.sh v1.2.3
#
# What it does, in order:
#   1. dumps the database to backups/pre-deploy-<tag>.sql.gz — migrations are
#      forward-only, so this is the way back for data if a release has to be undone
#   2. checks the repo out at the tag, so docker-compose.yml and the Caddyfile match
#      the image (.env is untracked and untouched)
#   3. writes ZEUS_TAG into .env, pulls the image CI published for that tag
#   4. restarts the app and waits for /api/health
#   5. if health never comes, puts the previous tag back and restarts it
#
# Rollback by hand is the same command with the previous tag.
#
# The whole file is wrapped in main() and only called on the last line: step 2 can
# replace this very script, and bash reads a running script incrementally.

set -euo pipefail

main() {
  local tag="${1:-}"
  if [[ -z "$tag" ]]; then
    echo "usage: $0 vX.Y.Z" >&2
    exit 2
  fi

  cd "$(dirname "$0")/.."
  [[ -f .env ]] || { echo "no .env here — this is not an installed Zeus" >&2; exit 2; }

  local prev
  prev=$(grep -E '^ZEUS_TAG=' .env | cut -d= -f2- || true)
  echo "▸ deploying $tag (currently: ${prev:-from-source build})"

  # 1. backup — plain pg_dump on this host, next to the repo. Independent of the app
  #    being healthy, which matters most on the day it is not.
  mkdir -p backups
  local dump
  dump="backups/pre-deploy-${tag}-$(date +%Y%m%dT%H%M%S).sql.gz"
  # The db container already carries POSTGRES_USER/DB from compose; use its copy.
  docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$dump"
  echo "▸ database dumped to $dump ($(du -h "$dump" | cut -f1))"

  # 2. infra files at the release — compose, Caddyfile, this script.
  git fetch -q --tags
  git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "no such tag: $tag" >&2; exit 2; }
  git checkout -q "$tag"

  # 3. pin and pull.
  set_tag "$tag"
  docker compose pull -q app

  # 4. restart just the app; db and caddy keep running.
  docker compose up -d --no-build app
  if wait_healthy 180; then
    echo "▸ $tag is live: $(curl -fsS http://localhost/api/health)"
    echo "▸ previous image kept for rollback: ./docker/deploy.sh ${prev:-<previous tag>}"
    exit 0
  fi

  # 5. rollback.
  echo "✗ $tag never became healthy — last app log lines:" >&2
  docker compose logs --no-color --tail=30 app >&2 || true
  if [[ -n "$prev" ]]; then
    echo "▸ rolling back to $prev" >&2
    git checkout -q "$prev" || true
    set_tag "$prev"
    docker compose up -d --no-build app
    wait_healthy 180 && echo "▸ $prev is back" >&2
  fi
  echo "▸ data as of before this deploy: $dump" >&2
  exit 1
}

set_tag() {
  if grep -qE '^ZEUS_TAG=' .env; then
    sed -i "s|^ZEUS_TAG=.*|ZEUS_TAG=$1|" .env
  else
    printf '\nZEUS_TAG=%s\n' "$1" >> .env
  fi
}

# The entrypoint waits for Postgres, migrates and seeds before it listens — allow for all of it.
wait_healthy() {
  local i
  for ((i = 1; i <= $1; i++)); do
    curl -fsS -m 3 http://localhost/api/health >/dev/null 2>&1 && return 0
    if [[ "$(docker compose ps --format '{{.State}}' app 2>/dev/null)" == "exited" ]]; then
      echo "✗ app container exited" >&2
      return 1
    fi
    sleep 1
  done
  return 1
}

main "$@"
