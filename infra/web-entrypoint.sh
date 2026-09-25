#!/bin/sh
# Forja web entrypoint: export FORJA_ENGINE_KEY from the file init shares with web
# (/data/engine/engine.key on the read-only forja-data volume) unless it is already set.
# Never echo the key.
set -eu
KEY_FILE="${FORJA_ENGINE_KEY_FILE:-/data/engine/engine.key}"
if [ -z "${FORJA_ENGINE_KEY:-}" ]; then
  if [ -r "$KEY_FILE" ]; then
    FORJA_ENGINE_KEY="$(tr -d '\r\n' < "$KEY_FILE")"
    export FORJA_ENGINE_KEY
  else
    echo "forja-web: $KEY_FILE not readable and FORJA_ENGINE_KEY unset; engine calls will be refused" >&2
  fi
fi
exec "$@"
