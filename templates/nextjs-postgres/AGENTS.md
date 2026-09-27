# AGENTS.md

Guide for anyone (human or AI agent) changing this codebase. Keep it true: when a
convention or path changes, change this file in the same commit.

## Commands

```bash
npm run dev            # next dev --webpack (webpack, not Turbopack: see "Visual editor hook")
npm run check          # typecheck + lint + tests + build: must be green before you finish
npm run db:generate    # after editing src/db/schema; review the SQL it writes
npm run db:migrate && npm run db:seed
```

Next.js 16 differs from older versions (`src/proxy.ts` instead of middleware, async `params`
and `searchParams`, Turbopack by default). Read `node_modules/next/dist/docs/` before writing
framework code.

## Module map

```
src/
  env.ts                 the only reader of process.env (zod-validated, lazy)
  proxy.ts               request-level routing (pass-through today)
  instrumentation.ts     starts background job workers on server start
  app/                   routes: pages, layouts, route handlers (api/health, api/auth, api/files)
  components/ui/         primitives (button, input, label, card, dialog); owned by design
  components/layout/     site shell (header, footer)
  content/               every user-facing string (site.ts, auth.ts…)
  modules/<feature>/
    domain/              entities, value objects, domain errors; no framework imports
    application/         one use case per file + zod input + ports; authorisation first
    infrastructure/      repositories, adapters, container.ts (composition root)
    ui/                  feature components and server actions
    index.ts             the module's public API; other code imports only this
  db/
    schema/              one table per file, re-exported by index.ts; columns.ts helpers
    queries/             typed shared queries (no select *, no N+1)
    client.ts            lazy Drizzle client (`db`, `getDb()`, `closeDb()`)
    seed.ts              idempotent development seed
  lib/                   cross-cutting helpers (below)
  jobs/                  job handlers and schedules (index.ts) and their starter
drizzle/migrations/      generated SQL, forward-only
scripts/                 migrate.ts (bundled to dist/migrate.mjs), source-tags.js, dev/check/seed.sh
tests/                   Vitest (tests/helpers/db.ts gives each file its own database)
e2e/                     Playwright
docs/                    adr/, backlog.md (and design/, brand/, content/ as they appear)
```

## Helpers you can rely on

| Import                          | What it gives you                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@/lib/result`                  | `Result<T, E>`, `ok()`, `err()`, `DomainError` and `ValidationError` (400), `NotAuthenticatedError` (401), `ForbiddenError` (403), `NotFoundError` (404), `ConflictError` (409), `RateLimitedError` (429); plain `DomainError` = 422 |
| `@/lib/http`                    | `errorResponse`, `resultResponse`, `unexpectedErrorResponse` → `{ error: { code, message, details? } }`                                                                                                                              |
| `@/lib/safe-url`                | `publicUrlRejectionReason(url)` (SSRF guard, resolves DNS), `safeFetch(url, { timeoutMs, maxBytes })`                                                                                                                                |
| `@/lib/rate-limit`              | `rateLimit(key, { limit, window /* seconds */ })` → `{ ok, remaining, resetAt }` on Postgres                                                                                                                                         |
| `@/lib/jobs`                    | `enqueue(name, payload, { key })`, `schedule(name, cron)`, `work(name, handler)`; register handlers in `src/jobs/index.ts`                                                                                                           |
| `@/lib/storage`                 | `getStorage().put/get/delete/url`, `newFileName()`, `fileUrl({ name, url? })`; local disk or S3                                                                                                                                      |
| `@/lib/mailer`                  | `sendMail({ to, subject, text, html? })`; SMTP or log                                                                                                                                                                                |
| `@/lib/form` · `@/lib/use-form` | `parseForm(schema, formData)`, `FormState`, `formSuccess/formError` (server) · `useForm(schema, action)` (client)                                                                                                                    |
| `@/lib/logger`                  | pino JSON logger                                                                                                                                                                                                                     |
| `@/modules/auth`                | `getSession()`, `getCurrentUser()`, `requireUser()`, `requireRole(role)` (return `Result`), `authorizeOwner(user, ownerId)`, `SessionUser`, `Role`                                                                                   |
| `@/db/schema/columns`           | `id()`, `timestamps()`, `defaultRandom()` (UUID v7), `fileColumn()`, `FileRef`                                                                                                                                                       |
| `tests/helpers/db.ts`           | `useTestDatabase()`, `hasTestDatabase`                                                                                                                                                                                               |

## Conventions

- **Dependency rules** (enforced by `eslint-plugin-boundaries`): domain imports nothing but
  its own domain and `lib`; application → its domain (and any module's domain), `lib`;
  infrastructure → its application/domain, `db`, `lib`, `env`; `app` and `ui` → application
  and modules' `index.ts`. Never import another module's `infrastructure`.
- **Results, not exceptions**, for business outcomes. Throw only for bugs and infrastructure
  failures; route handlers map `Result` errors to status codes with `lib/http`.
- **Validate at the boundary** with zod (route handlers, server actions); use cases receive
  typed input. Authorise inside the use case, against the resource owner.
- **Configuration** only through `@/env`. Adding a variable = `src/env.ts` + `.env.example`
  (+ `.env.production.example`) + the README table. Integration keys are optional with a
  development adapter.
- **Database (the builder's database tab depends on these):** primary key `id text` UUID v7
  (`id()`), `created_at`/`updated_at` `timestamptz` on every table (`timestamps()`), bridge
  tables `<a>_<b>` with two FKs and a composite PK, file fields as `jsonb` columns named
  `*_file` / `*_image` holding `{ name, url? }`, closed sets as Postgres enums, `snake_case`
  in SQL and `camelCase` in TypeScript, an index on every foreign key. Infrastructure tables
  go in the `internal` schema. BetterAuth tables (`user`, `session`, `account`,
  `verification`) are not modified; reference `user.id`.
- **Migrations** are generated (`db:generate`), reviewed, forward-only and expand/contract
  compatible (the previous version keeps running while they apply). Never edit an applied
  migration.
- **UI:** server components by default; `"use client"` only on interactive leaves. Strings
  from `src/content`, colours/radii/fonts from the tokens in `src/app/globals.css`, icons from
  `lucide-react`, images with `next/image`, fonts local under `src/app/fonts` (never
  `next/font/google`). One `h1` per page, labelled inputs, visible focus, AA contrast.
- **Rendering:** the root layout is `force-dynamic` so `NEXT_PUBLIC_APP_URL` and other
  runtime settings are read per request, never baked into the build.
- **Tests:** a Vitest file per use case and per query module; integration tests call
  `useTestDatabase()` and skip without `DATABASE_URL_TEST`. E2E specs live in `e2e/`.
- **No telemetry:** `NEXT_TELEMETRY_DISABLED=1`, BetterAuth telemetry off, no analytics or
  third-party scripts unless the product explicitly needs them.

## Visual editor hook

`next.config.ts` has a `webpack: (config, { dev }) => {` block that, in development only,
runs `scripts/source-tags.js` to add `data-tlm-loc="file:line:col"` to JSX elements. Keep
the block, its first line and the loader file as they are (`SOURCE_TAGS=0` disables it).
Production builds use Turbopack and carry no source paths.

## Forja

This project was generated by [Forja](https://github.com/charcsllc/forja), an open source AI
app builder, from its `nextjs-postgres` template. It is **fully independent of Forja**: nothing here calls, imports or requires
Forja at build or run time. You can clone it, run it with `docker compose`, deploy it
anywhere and keep developing it with any editor or agent. The only Forja-specific pieces are
harmless in any environment: the development-only source-tag loader above and this section.
