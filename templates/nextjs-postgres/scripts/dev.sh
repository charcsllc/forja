#!/usr/bin/env bash
# Start the development stack: Postgres + Mailpit + the app (compose.yaml), then migrate and seed.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
docker compose up -d --wait db mailpit
docker compose run --rm migrate
docker compose run --rm app npm run db:seed
docker compose up app
