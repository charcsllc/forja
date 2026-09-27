# syntax=docker/dockerfile:1.7
# forja-runner: the image every project sandbox runs in (dev server, verification, gates).
# docs/architecture/04-sandbox-preview-deploy.md §2. Build from the repo root:
#   docker build -t forja-runner:1.0.0 --build-arg TEMPLATE_VERSION=1.0.0 -f infra/images/runner/Dockerfile .
# The build context is limited by Dockerfile.dockerignore to the template's manifests.

ARG NODE_IMAGE=node:22-bookworm-slim

# ── Curated OFL fonts (fontsource variable builds of Google Fonts) ────────────
FROM ${NODE_IMAGE} AS fonts
ARG FONTSOURCE_VERSION=5.3.0
ARG FONT_FAMILIES="inter geist geist-mono source-serif-4 fraunces jetbrains-mono space-grotesk manrope"
ENV npm_config_update_notifier=false npm_config_fund=false
WORKDIR /work
RUN set -eux; \
    mkdir -p /out; \
    for family in ${FONT_FAMILIES}; do \
      npm pack --silent "@fontsource-variable/${family}@${FONTSOURCE_VERSION}" >/dev/null; \
      mkdir -p "pkg/${family}" "/out/${family}"; \
      tar xzf "fontsource-variable-${family}-${FONTSOURCE_VERSION}.tgz" -C "pkg/${family}"; \
      src="pkg/${family}/package"; \
      # Weight-axis variable files (normal + italic, every subset); fall back to all files.
      if ls "${src}"/files/*-wght-*.woff2 >/dev/null 2>&1; then \
        cp "${src}"/files/*-wght-*.woff2 "/out/${family}/"; \
      else \
        cp "${src}"/files/*.woff2 "/out/${family}/"; \
      fi; \
      cp "${src}/LICENSE" "${src}/metadata.json" "${src}/unicode.json" "/out/${family}/"; \
    done; \
    node -e ' \
      const fs = require("fs"); \
      const version = process.env.FONTSOURCE_VERSION; \
      const rows = process.env.FONT_FAMILIES.split(/\s+/).filter(Boolean).map((id) => { \
        const m = JSON.parse(fs.readFileSync(`/out/${id}/metadata.json`, "utf8")); \
        const files = fs.readdirSync(`/out/${id}`).filter((f) => f.endsWith(".woff2")).length; \
        const axes = Object.keys(m.variable || {}).join(", "); \
        return `| ${m.family} | \`${id}/\` | [@fontsource-variable/${id}@${version}](https://www.npmjs.com/package/@fontsource-variable/${id}/v/${version}) | ${m.source || ""} (${m.version || ""}, ${m.lastModified || ""}) | ${m.license.type} | ${axes} | ${files} |`; \
      }); \
      const out = [ \
        "# Fonts in /opt/forja/fonts", \
        "", \
        "Curated for generated apps. The `font_vendor` tool copies a family into a project (`src/app/fonts/`),", \
        "where it is loaded with `next/font/local`: no font is ever fetched at runtime.", \
        "", \
        "Every family is licensed under the SIL Open Font License 1.1: the full licence and copyright notice", \
        "are in each folder (`LICENSE`) and must travel with the files. `metadata.json` (axes, weights, subsets)", \
        "and `unicode.json` (unicode-range per subset) come from the same package.", \
        "", \
        "Files are the variable weight-axis builds, named `<family>-<subset>-wght-<normal|italic>.woff2`.", \
        "", \
        "| Family | Folder | Package (download source) | Upstream | Licence | Variable axes (upstream) | woff2 files |", \
        "|---|---|---|---|---|---|---|", \
        ...rows, \
        "", \
      ].join("\n"); \
      fs.writeFileSync("/out/SOURCES.md", out); \
    '; \
    cat /out/SOURCES.md

# ── Pre-warmed npm cache for the template's lockfile ─────────────────────────
FROM ${NODE_IMAGE} AS npmcache
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
WORKDIR /tmp/template
COPY templates/nextjs-postgres/package.json templates/nextjs-postgres/package-lock.json ./
RUN set -eux; \
    npm ci --cache /opt/forja/npm-cache --ignore-scripts --no-audit --no-fund; \
    rm -rf node_modules /opt/forja/npm-cache/_logs /opt/forja/npm-cache/_npx /opt/forja/npm-cache/_update-notifier-last-checked; \
    chmod -R a+rX /opt/forja/npm-cache

# ── Runner ───────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE}
ARG TEMPLATE_VERSION=1.0.0
LABEL org.opencontainers.image.title="forja-runner" \
      org.opencontainers.image.description="Sandbox image for Forja projects: Node 22, git, curated OFL fonts, pre-warmed npm cache" \
      org.opencontainers.image.licenses="MIT" \
      forja.template.name="nextjs-postgres" \
      forja.template.version="${TEMPLATE_VERSION}"

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git curl bash tini ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    # uid/gid 1000 `node` comes with the base image; the sandbox runs as 1000:1000.
    test "$(id -u node):$(id -g node)" = "1000:1000"; \
    mkdir -p /workspace && chown node:node /workspace

COPY --from=fonts /out /opt/forja/fonts
COPY --from=npmcache /opt/forja/npm-cache /opt/forja/npm-cache
COPY templates/nextjs-postgres/template.json /opt/forja/template.json

ENV NEXT_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    FORJA_FONTS_DIR=/opt/forja/fonts \
    FORJA_NPM_CACHE=/opt/forja/npm-cache \
    HOME=/home/node

USER node
WORKDIR /workspace
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "dev"]
