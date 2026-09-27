# Changelog

All notable changes to Forja are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- chore: move the UI into `apps/web` and turn the repo into an npm-workspaces monorepo (no functional change)

### Added
- feat(engine): phase 1 API v1 without the agent: projects (slug rules, reserved ids, auto-suffix with `requestedProjectId`, soft delete + `/v2/projects/<id>/undelete`), provisioning as the pg-boss job `sandbox.provision` (template repo, Postgres with `app_rw`/`cms_ro`/`cms_rw`, dev server behind Traefik at `http://<id>.forja.localhost`), restart and wake with the UI's synchronous transitions, files tree/content (byte-exact, `.env*` forbidden, `STALE_WRITE`, coalesced commits, `rebuildRequired`), rebuild (no-op aware), versions, diff and restore (with a `pg_dump` first), secrets (AES-256-GCM, write-only), uploads sniffed by content, source zip, dev logs, the database tab over `@forja/db-cms`, and the GitHub/Figma/deploy/domain stubs
- feat(engine): signed public surface `GET /v1/public/<token>` (uploads, source zip) served to browsers as `${WEB_PUBLIC_URL}/api/files/<token>`; `GET /v1/system/public-config`
- feat(engine): API v2 `/v2/projects/<id>/preview/*` (internal preview proxy), `/v2/projects/<id>/budget` (real shape, zeros until the phase 2 ledger), `/v2/projects/<id>/archive`
- feat(engine): boot checks: DATA_DIR ↔ DATA_DIR_HOST host-path check, `forja-apps` network, resumption of interrupted operations, re-attachment to project networks
- build(engine): esbuild bundle of the workspace packages; the image ships the templates at `/opt/forja/templates` and runs on Debian trixie (git ≥ 2.42 for `@forja/git`); new settings `TEMPLATE_DIR`, `RUNNER_IMAGE`, `SANDBOX_DB_IMAGE`, `ENGINE_CONTAINER`, `WEB_PUBLIC_URL`
- feat(engine): add `@forja/git` (project repositories, versions, restore, file API) and `@forja/sandbox` (hardened Docker sandboxes per project)
- feat(engine): add `@forja/db-cms`, the database tab over a project's own Postgres: introspection into Totalum's `tables-structure`, the `queryOptions` DSL compiled to parameterized SQL, records CRUD and link/unlink by property name
- feat(web): talk to the self-hosted Forja Engine when `FORJA_ENGINE_URL` is set (key from `FORJA_ENGINE_KEY` or `FORJA_ENGINE_KEY_FILE`); Totalum stays the default and behaves as before
- feat(web): `/api/config` reports the backend and the publish scheme/domain; publish links and the "now live" message use them instead of a hardcoded `https://…totalum-project.com`
- feat(web): `/api/files/<token>` streams the engine's signed files; the visual editor and the source download fetch those from the engine directly
- feat(web): the visual-editor preview proxy forwards to the engine's `/v2/projects/<id>/preview` in engine mode
- feat(web): a per-project budget page (`/project/<id>/budget`), linked from the out-of-credits dialog in engine mode
- feat(web): the Code tab only asks for a rebuild when the backend says the saved file needs one (`rebuildRequired`)
- build(web): `output: "standalone"` for the container image
- feat(engine): add the Forja Engine skeleton (Hono API, Postgres schema, pg-boss queue, health) and the platform compose stack under `infra/`
- Contribution guide, security policy, code of conduct, issue and PR templates, CI typecheck.
- JSDoc on every exported helper under `src/lib`.
- First public edition: the ai-app-builder-open engine restyled after the Lovable layout and palette.
- `src/lib/brand.ts` as the single place the product is named.
- README aimed at people looking for an open source Lovable alternative.

### Changed
- Renamed the project from Creable (`lovable-alternative`) to Forja: package name, brand strings, storage prefix, repository links and demo asset.
- `AGENTS.md` rewritten as a verified map of the codebase: routes, client catalog, workspace state model, storage keys, privacy section, known debt.

### Removed
- All third-party phone-home paths: Next.js telemetry is disabled in next.config.ts, Monaco is bundled instead of loaded from jsDelivr, and the Geist fonts are vendored instead of fetched from Google Fonts at build time.
