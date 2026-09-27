#!/usr/bin/env bash
# Migrate then seed the database in DATABASE_URL (development only; idempotent).
set -euo pipefail
cd "$(dirname "$0")/.."
npm run db:migrate
npm run db:seed
