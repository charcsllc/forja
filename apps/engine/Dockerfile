# syntax=docker/dockerfile:1
# Forja Engine. Build context: the repository root.
#   docker build -f apps/engine/Dockerfile -t forja-engine .
# Stages: build (engine deps incl. dev + root TypeScript) → deps (prod deps only) → runtime.
# Trade-off: `npm ci -w @forja/engine --include-workspace-root` installs only what the engine
# and the root toolchain need, not the web app's ~1 GB of dependencies.

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 npm_config_update_notifier=false npm_config_fund=false
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci -w @forja/engine --include-workspace-root --no-audit
RUN npm run build -w @forja/engine

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false
COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev -w @forja/engine --no-audit

FROM ${NODE_IMAGE} AS runtime
# git: repositories per project (phase 1). tini: PID 1 that forwards SIGTERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '/data/projects/*'
ENV NODE_ENV=production ENGINE_PORT=4000 DATA_DIR=/data
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/apps/engine/package.json ./apps/engine/package.json
COPY --from=build --chown=1000:1000 /app/apps/engine/dist ./apps/engine/dist
COPY --from=build --chown=1000:1000 /app/apps/engine/drizzle ./apps/engine/drizzle
# The base image's `node` user is uid/gid 1000 (sandboxes and DATA_DIR use the same ids).
USER 1000:1000
WORKDIR /app/apps/engine
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.ENGINE_PORT||4000)+'/v2/system/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
