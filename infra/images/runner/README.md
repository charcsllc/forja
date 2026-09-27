# forja-runner

The image every project sandbox runs in: the development container `forja-app-<id>`, the
per-run verification container `forja-verify-<id>` and the gate containers
(`docs/architecture/04-sandbox-preview-deploy.md` §1–§2). It is tagged with the version of
the template it was built for: `forja-runner:<template-version>`.

## Contents

| Path / setting | What |
|---|---|
| Base | `node:22-bookworm-slim` (Node 22, npm 10) |
| Packages | `git`, `curl`, `bash`, `tini`, `ca-certificates` |
| User | `node`, uid/gid 1000 (from the base image); `WORKDIR /workspace`; `HOME=/home/node` |
| Entrypoint | `tini --`, default command `npm run dev` (`next dev --webpack`) |
| `/opt/forja/fonts/<family>/` | Curated OFL variable fonts (woff2 + `LICENSE` + `metadata.json` + `unicode.json`) that `font_vendor` copies into `src/app/fonts/`. `SOURCES.md` lists source, version and licence of each. |
| `/opt/forja/npm-cache` | npm cache pre-warmed with the template's lockfile. Read-only for `node`: provisioning **copies** it to the project's `home/.npm` so it is writable. |
| `/opt/forja/template.json` | The template manifest the image was built from |
| Labels | `forja.template.name`, `forja.template.version` |
| Env | `NEXT_TELEMETRY_DISABLED=1`, `FORJA_FONTS_DIR`, `FORJA_NPM_CACHE` |

Fonts: Inter, Geist, Geist Mono, Source Serif 4, Fraunces, JetBrains Mono, Space Grotesk and
Manrope, downloaded at build time from the `@fontsource-variable/*` npm packages (pinned by
`FONTSOURCE_VERSION`), which repackage the Google Fonts releases. Only the weight-axis
variable files are kept, every subset, normal and italic. All are SIL OFL 1.1; each
`LICENSE` must travel with the files it covers.

## Build

From the repository root (the context is narrowed to the template manifests by
`Dockerfile.dockerignore`):

```bash
docker build -t forja-runner:1.0.0 \
  --build-arg TEMPLATE_VERSION="$(node -p 'require("./templates/nextjs-postgres/template.json").version')" \
  -f infra/images/runner/Dockerfile .
docker builder prune -af   # optional: reclaim the build cache
```

Rebuild whenever `templates/nextjs-postgres/package-lock.json` or `template.json` changes,
and tag with the new template version; keep older tags while projects still use them.

Build arguments: `TEMPLATE_VERSION` (label), `FONTSOURCE_VERSION` (default `5.3.0`),
`FONT_FAMILIES` (space-separated fontsource ids), `NODE_IMAGE`.

## Using the cache

```bash
cp -r /opt/forja/npm-cache "$HOME/.npm"          # done by provisioning, once per project
npm ci --prefer-offline                          # installs the template's lockfile from cache
```

`npm ci --offline` succeeds with no network for an unchanged template lockfile.
