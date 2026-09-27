# App

A full-stack Next.js application: server-rendered pages, a Postgres database, email +
password authentication, file storage, email, background jobs and a production Docker setup.
Everything runs on your own infrastructure; no third-party service is required.

**Stack:** Next.js 16 (App Router, React 19, TypeScript strict) · Postgres 17 + Drizzle ORM ·
BetterAuth · Tailwind CSS 4 · pg-boss · zod · pino · Vitest · Playwright.

## Run it locally

Requirements: Node.js 22.12+ and Docker (for Postgres), or only Docker.

**Everything in Docker** (Postgres, Mailpit, the app with hot reload):

```bash
scripts/dev.sh          # compose up + migrate + seed; app on http://localhost:3000
```

Mail sent in development appears in Mailpit at http://localhost:8025.

**Node on your machine, Postgres in Docker:**

```bash
cp .env.example .env            # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
npm install
npm run db:migrate
npm run db:seed
npm run dev                     # http://localhost:3000
```

### Seed accounts (development only)

`npm run db:seed` is idempotent and refuses to run when `NODE_ENV=production`.

| Email               | Password         | Role                                          |
| ------------------- | ---------------- | --------------------------------------------- |
| `user@example.com`  | `user-password`  | user                                          |
| `admin@example.com` | `admin-password` | admin                                         |
| `other@example.com` | `other-password` | user (a second account, for ownership checks) |

Sign in at `/sign-in`.

## Scripts

| Command                                 | What it does                                                          |
| --------------------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                           | Development server (`next dev --webpack`)                             |
| `npm run build` / `npm start`           | Production build / serve it                                           |
| `npm run check`                         | Typecheck, lint, tests and build (what CI runs)                       |
| `npm run typecheck` · `lint` · `format` | Quality gates                                                         |
| `npm test`                              | Unit tests; integration tests too when `DATABASE_URL_TEST` is set     |
| `npm run e2e`                           | Playwright end-to-end tests (`npx playwright install chromium` first) |
| `npm run db:generate`                   | Generate a SQL migration from `src/db/schema`                         |
| `npm run db:migrate`                    | Apply pending migrations                                              |
| `npm run db:seed`                       | Load development data                                                 |
| `npm run build:migrator`                | Bundle the migrator into `dist/migrate.mjs` (used by the image)       |
| `npm run knip`                          | Find unused files, exports and dependencies                           |

## Configuration

All configuration is environment variables, validated at startup by `src/env.ts`. Only three
are required; every integration falls back to a development adapter when its keys are missing.

| Variable                                                                                                                    | Required | Default                                       | Purpose                                                            |
| --------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------- | ------------------------------------------------------------------ |
| `DATABASE_URL`                                                                                                              | yes      |                                               | Postgres connection string                                         |
| `BETTER_AUTH_SECRET`                                                                                                        | yes      |                                               | 32+ random characters; signs sessions                              |
| `NEXT_PUBLIC_APP_URL`                                                                                                       | yes      |                                               | Public URL (read at runtime on the server)                         |
| `INTERNAL_APP_URL`                                                                                                          | no       |                                               | URL inside the container network; trusted by auth                  |
| `EXTRA_TRUSTED_ORIGINS`                                                                                                     | no       |                                               | More origins trusted by auth                                       |
| `ALLOWED_FRAME_ANCESTORS`                                                                                                   | no       | `'self'`                                      | Who may embed the app in an iframe (CSP)                           |
| `LOG_LEVEL`                                                                                                                 | no       | `info`                                        | pino log level                                                     |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `SMTP_FROM`                                          | no       | log only                                      | Outgoing mail                                                      |
| `STORAGE_DIR`                                                                                                               | no       | `.data/uploads` (dev), `/data/uploads` (prod) | Local file storage                                                 |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL`, `S3_FORCE_PATH_STYLE` | no       | local disk                                    | S3-compatible storage                                              |
| `JOBS_MODE`                                                                                                                 | no       | `inline`                                      | `inline` runs job handlers in the web process; `off` disables them |
| `DATABASE_URL_TEST`                                                                                                         | no       |                                               | Postgres the integration tests may use                             |

Security headers (CSP, HSTS…) are computed in `next.config.ts` when the server starts in
development and at build time for production images.

## Deploy

The app is one container plus Postgres. Migrations are a separate step that runs **before**
the new version receives traffic, never inside the app's start command.

### Docker Compose (any VPS)

```bash
cp .env.production.example .env.production     # fill in every value
docker compose -f compose.prod.yaml --env-file .env.production up -d --build
```

`migrate` runs `node migrate.mjs` once (a Postgres advisory lock makes concurrent runs safe),
then `app` starts on port 3000 (`APP_PORT` to change it) with a read-only root filesystem.
Put a TLS-terminating reverse proxy (Caddy, Traefik, nginx) in front of it. Uploaded files
live in the `uploads` volume; back up it and `pgdata`.

### Other platforms

- **Any container host (Fly.io, Railway, Render, Kubernetes…):** build the `Dockerfile`, run
  `node migrate.mjs` as a release/pre-deploy command, then `node server.js`. Health check:
  `GET /api/health` (`{ ok, db, version }`, 503 when the database is unreachable).
- **Vercel + managed Postgres:** works for the web part; run `npm run db:migrate` from CI
  before each deploy, use S3 storage (the function filesystem is ephemeral), and set `JOBS_MODE=off`
  (serverless functions cannot keep a job worker alive; run one elsewhere).

## Project layout

See `AGENTS.md` for conventions and the module map, and `docs/adr/` for decisions.
