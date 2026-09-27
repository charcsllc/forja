# syntax=docker/dockerfile:1
# Forja Web (the builder UI). Build context: the repository root.
#   docker build -f apps/web/Dockerfile -t forja-web .
#
# Works with or without `output: "standalone"` in apps/web/next.config.ts:
#  - standalone present → the runtime image carries only the traced server (small);
#  - absent (phase 0)   → it carries the full install and runs `next start`. `next`,
#    `typescript` and `tailwindcss` are devDependencies the app needs at run time
#    (AGENTS.md §10), so dev deps are NOT omitted in that case.
# Phase 1 adds `output: "standalone"` (infra/README.md).

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false npm_config_fund=false
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @forja/web --include-workspace-root --no-audit
RUN npm run build -w @forja/web
# Stage the runtime tree in /out, whichever output mode the build produced.
RUN set -eu; mkdir -p /out; \
    if [ -f apps/web/.next/standalone/apps/web/server.js ]; then \
      cp -a apps/web/.next/standalone/. /out/; \
      mkdir -p /out/apps/web/.next; \
      cp -a apps/web/.next/static /out/apps/web/.next/static; \
      cp -a apps/web/public /out/apps/web/public; \
      printf '#!/bin/sh\ncd /app/apps/web && exec node server.js\n' > /out/start.sh; \
    else \
      cp -a package.json node_modules /out/; \
      mkdir -p /out/apps /out/packages; \
      cp -a apps/web /out/apps/web; \
      if [ -d packages ]; then cp -a packages/. /out/packages/; fi; \
      printf '#!/bin/sh\ncd /app/apps/web && exec ../../node_modules/.bin/next start -H "${HOSTNAME:-0.0.0.0}" -p "${PORT:-3000}"\n' > /out/start.sh; \
    fi; \
    chmod +x /out/start.sh

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=1000:1000 /out/ ./
COPY --chmod=0755 infra/web-entrypoint.sh /usr/local/bin/forja-web-entrypoint
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/forja-web-entrypoint"]
CMD ["/app/start.sh"]
