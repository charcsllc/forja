#!/usr/bin/env bash
# Every quality gate, in the order CI runs them.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run typecheck
npm run lint
npm test
npm run build
