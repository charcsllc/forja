# Traefik dynamic configuration

At run time Traefik's file provider watches `${DATA_DIR_HOST}/traefik/dynamic/`
(mounted read-only at `/data/traefik/dynamic`), **not this folder**. The `init` service
creates that directory; the engine writes and deletes files in it:

- `domain-<projectId>.yml`: router `Host(<hostname>)` → the project's production service,
  with `tls.certresolver` (custom domains, `docs/architecture/04-sandbox-preview-deploy.md` §7.3).
- Middlewares that do not fit in container labels, such as `forja-preview-auth`
  (forward-auth to `engine /v2/auth/preview` when `PREVIEW_PUBLIC=false`, §4).

Do not hand-edit files the engine owns; they are rewritten. Files you add yourself should
use a prefix the engine never writes (for example `local-*.yml`).

Phase 0 writes nothing here.
