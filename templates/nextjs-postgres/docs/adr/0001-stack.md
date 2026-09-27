# 0001 · Stack and architecture

- Status: accepted
- Date: generated with the project

## Context

The app must be full-stack (server rendering, database, auth, files, email, background
work), cheap to operate on one server, deployable anywhere with Docker, and easy for
several engineers (or agents) to extend without stepping on each other.

## Decision

- **Next.js 16, App Router, React 19, TypeScript strict.** Server components by default;
  route handlers and server actions are thin adapters over use cases.
- **Postgres 17 + Drizzle ORM + `postgres` driver.** Readable SQL migrations generated from
  the schema, forward-only. UUID v7 text primary keys (time-ordered, safe to expose).
- **BetterAuth** (email + password; OAuth optional) with the Drizzle adapter: no external
  identity provider required.
- **pg-boss** for jobs and Postgres for rate limiting: no Redis until a measured need.
- **Ports with development adapters** for storage (local disk / S3) and mail (log / SMTP),
  so the app starts before any third-party credentials exist.
- **Tailwind 4 with design tokens in `@theme`**, own primitives in `src/components/ui`.
- **Clean architecture per feature module** (`domain` → `application` → `infrastructure`,
  `ui`), enforced by `eslint-plugin-boundaries`.
- **Operations:** multi-stage Dockerfile with standalone output, migrations bundled with
  esbuild and run as a separate step, `/api/health`, JSON logs to stdout.

## Consequences

- One container plus Postgres runs everything; horizontal scaling needs shared storage
  (S3) and, if job volume grows, a separate worker running `src/jobs`.
- Pages render per request (runtime configuration is never baked into the build); add
  caching per route when a page is hot and static.
- Development uses webpack (`next dev --webpack`) for the source-tag loader; production
  builds use Turbopack.
