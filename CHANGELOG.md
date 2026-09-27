# Changelog

All notable changes to Forja are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- chore: move the UI into `apps/web` and turn the repo into an npm-workspaces monorepo (no functional change)

### Added
- feat(engine): add `@forja/git` (project repositories, versions, restore, file API) and `@forja/sandbox` (hardened Docker sandboxes per project)
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
