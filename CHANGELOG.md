# Changelog

All notable changes to Forja are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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
