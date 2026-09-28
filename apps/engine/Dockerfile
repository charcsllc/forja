# syntax=docker/dockerfile:1
# Forja Engine. Build context: the repository root.
#   docker build -f apps/engine/Dockerfile -t forja-engine .
# Stages: build (engine deps incl. dev + root TypeScript) → deps (prod deps only) → runtime.
# Trade-off: `npm ci -w @forja/engine --include-workspace-root` installs only what the engine
# and the root toolchain need, not the web app's ~1 GB of dependencies.
# The build is an esbuild bundle (scripts/build.mjs): the workspace packages (@forja/contracts,
# git, sandbox, db-cms, llm, agents, media) are compiled in; npm packages stay external in
# node_modules. The agent prompts travel inside the bundle (packages/agents/src/prompts/
# bundle.generated.ts, generated from docs/prompts), so the image needs no copy of docs/.
# Templates are copied to /opt/forja/templates (TEMPLATE_DIR default), from the repo's
# templates/ folder, so a project is created from exactly the template this image was built with.

ARG NODE_IMAGE=node:22-bookworm-slim
# Runtime on Debian trixie: @forja/git needs git >= 2.42 (`git worktree add --orphan`);
# bookworm (and bookworm-backports) ship 2.39. Build stages stay on bookworm (glibc-forward-compatible).
ARG RUNTIME_IMAGE=node:22-trixie-slim

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

FROM ${RUNTIME_IMAGE} AS runtime
# git (>= 2.42): repositories per project (phase 1). tini: PID 1 that forwards SIGTERM.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '/data/projects/*' \
 && git --version
ENV NODE_ENV=production ENGINE_PORT=4000 DATA_DIR=/data TEMPLATE_DIR=/opt/forja/templates/nextjs-postgres
WORKDIR /app
COPY --from=deps --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/apps/engine/package.json ./apps/engine/package.json
COPY --from=build --chown=1000:1000 /app/apps/engine/dist ./apps/engine/dist
COPY --from=build --chown=1000:1000 /app/apps/engine/drizzle ./apps/engine/drizzle
# Project templates (read-only for the engine: it copies them into each new repository).
COPY --from=build /app/templates /opt/forja/templates
# The base image's `node` user is uid/gid 1000 (sandboxes and DATA_DIR use the same ids).
USER 1000:1000
WORKDIR /app/apps/engine
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.ENGINE_PORT||4000)+'/v2/system/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
