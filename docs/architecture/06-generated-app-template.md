# 06 · Plantilla de aplicación generada (`templates/nextjs-postgres`)

Punto de partida de todo proyecto. Los agentes heredan la estructura y la extienden. Cada
regla existe para que la app resultante no tenga deuda técnica y sea trivial de actualizar,
migrar o entregar. La plantilla lleva `template.json` con `version`; cada proyecto guarda la
versión con la que nació (`projects.template_version`) y la imagen `forja-runner` se
etiqueta por versión; la intención `upgrade` (v2) migra un proyecto a una versión nueva.

## 1. Stack

| Capa | Elección | Razón |
|---|---|---|
| Framework | Next.js 16, App Router, React 19, TypeScript strict | Lo que la UI y el editor visual esperan |
| Dev server | `next dev --webpack` | El editor visual depende del hook `webpack` (`scripts/source-tags.js`); Turbopack queda en backlog |
| Estilos | Tailwind 4 + tokens en `@theme` | El sistema de diseño es dato |
| UI base | Primitivas propias en `src/components/ui` (patrón shadcn, copiadas) | Sin lock-in |
| ORM / DB | Drizzle + `postgres`; Postgres 17 | Migraciones SQL legibles |
| Auth | BetterAuth (email+password; OAuth opcional); `trustedOrigins` desde env | Sin servicio externo |
| Validación / env | zod; `src/env.ts` (server/client) | Contratos explícitos |
| Tests | Vitest + helper de DB de test; Playwright | Puertas |
| Calidad | ESLint 9 flat + `eslint-plugin-boundaries`, Prettier, `knip` | Determinista |
| Imágenes | `next/image` + `sharp`; `public/media/manifest.json` | |
| Almacenamiento de ficheros de usuario | Puerto `storage` (`src/lib/storage.ts`): adaptador local (volumen) y S3-compatible | La app sirve sus ficheros sin Forja |
| Email | Puerto `mailer` (`src/lib/mailer.ts`): adaptador consola (dev), Mailpit (compose dev), SMTP (prod) | |
| Jobs | `pg-boss` embebido (`src/lib/jobs.ts`), ejecutado en el proceso `app` o en un servicio `worker` si el plan lo decide | Sin Redis |
| Observabilidad | `pino` a stdout, `/api/health` | |
| Contenedores | `Dockerfile` multi-stage, `compose.yaml`, `compose.prod.yaml` | Autosuficiente |
| CI | `.github/workflows/ci.yml` | |

Sin telemetría: `NEXT_TELEMETRY_DISABLED=1`; sin `next/font/google`; fuentes OFL en
`src/app/fonts/` copiadas por `font_vendor` desde la imagen del runner.

## 2. Estructura (clean architecture pragmática)

Como antes (`AGENTS.md`, `docs/{adr,design,brand,content,backlog.md}`, `compose*.yaml`,
`Dockerfile`, `.dockerignore`, `.env.example`, `drizzle/`, `scripts/`, `public/{brand,media}`,
`src/{env.ts,app,components/{ui,layout},modules/<feature>/{domain,application,infrastructure,ui},db/{schema,client.ts,seed.ts,queries},lib,content,proxy.ts}`,
`tests/`, `e2e/`). `src/proxy.ts` (antes middleware) lo posee el rol `frontend`.

Reglas de dependencia (`eslint-plugin-boundaries`): `domain` sin imports externos;
`application` → `domain`; `infrastructure` → `application`, `domain`; `ui`/`app` →
`application`; `modules/A` no importa `modules/B/infrastructure`.

## 3. Helpers que la plantilla garantiza (los prompts los referencian)

| Fichero | Qué es |
|---|---|
| `src/lib/result.ts` | `Result<T, E>`, `ok()`, `err()`, `DomainError` base |
| `src/lib/safe-url.ts` | Guardia SSRF para URLs de usuario (portada de la UI de Forja) |
| `src/lib/rate-limit.ts` | `rateLimit(key, {limit, window})` sobre Postgres |
| `src/lib/jobs.ts` | Cola pg-boss: `enqueue(name, payload, {key})`, `schedule(cron)` |
| `src/lib/storage.ts` | Puerto `storage` + adaptadores local/S3; lee `{name}` de campos `*_file` |
| `src/lib/mailer.ts` | Puerto `mailer` + adaptadores |
| `src/lib/form.ts` | Helper de formularios (zod compartido cliente/servidor, `useForm`, errores por campo) |
| `src/modules/auth/*` | BetterAuth configurado; `getSession()`, `requireUser()`, `requireRole()` |
| `tests/helpers/db.ts` | Base de datos de test aislada por fichero (usa `DATABASE_URL_TEST`) |
| `scripts/migrate.ts` → `dist/migrate.mjs` (en la imagen, `/app/migrate.mjs`) | Migrador **empaquetado con esbuild** (sin depender de `node_modules` en runtime), con advisory lock |
| `scripts/source-tags.js` | Loader webpack que añade `data-tlm-loc` en dev |
| `src/db/seed.ts` | Usuarios `user`, `admin`, `other` + datos de cada entidad |

## 4. Convenciones sin deuda técnica

Como antes (nombres, tipos estrictos, `Result`, repositorios por puerto, migraciones
forward-only y compatibles expand/contract, server actions validadas, autorización por caso
de uso, estados de error y carga, a11y AA, SEO, rendimiento, documentación, dependencias
mínimas, tests), más las **convenciones del CMS** (`05 §6.1`): PK `id` text UUID v7,
`created_at`/`updated_at` en toda tabla, puentes `<a>_<b>` con dos FKs, ficheros en jsonb
`*_file`/`*_image`, enums cerrados como enums de Postgres.

**Claves opcionales y adaptadores mock.** `src/env.ts` exige solo lo imprescindible
(`DATABASE_URL`, `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_APP_URL`). Toda integración (Stripe,
SMTP, S3, OAuth) declara su clave **opcional** y, si falta, usa un adaptador de desarrollo
(pagos simulados, correo a consola/Mailpit, storage local, OAuth deshabilitado con aviso en
UI). Así la preview y la puerta de arranque funcionan antes de que el usuario aporte
secretos; el supervisor lista las claves que faltan en `secretKeysNeeded`.

**Cabeceras.** `next.config.ts` fija CSP con `frame-ancestors` desde `ALLOWED_FRAME_ANCESTORS`
(en dev, el origen de Forja; en prod, `'self'`), HSTS solo en prod, y el resto de cabeceras
de seguridad. BetterAuth `trustedOrigins` = `NEXT_PUBLIC_APP_URL`, `INTERNAL_APP_URL` y
`EXTRA_TRUSTED_ORIGINS`.

## 5. `Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm run build:migrator     # esbuild → dist/migrate.mjs (autocontenido)

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN groupadd -r app && useradd -r -g app app && mkdir -p /app/.next/cache /data && chown -R app:app /app /data
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
COPY --from=build --chown=app:app /app/drizzle ./drizzle
COPY --from=build --chown=app:app /app/dist/migrate.mjs ./migrate.mjs
USER app
EXPOSE 3000
VOLUME ["/app/.next/cache", "/data"]
HEALTHCHECK --interval=15s --timeout=5s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","server.js"]
```

Las migraciones **no** corren en el `CMD`: son un paso previo (`node migrate.mjs`) que
Forja ejecuta como job y que `compose.prod.yaml` ejecuta como servicio `migrate` de un
solo disparo del que `app` depende (`condition: service_completed_successfully`).

## 6. `compose.yaml` y `compose.prod.yaml`

```yaml
# compose.prod.yaml
name: ${COMPOSE_PROJECT_NAME:-app}
services:
  migrate:
    build: .
    command: ["node", "migrate.mjs"]
    env_file: [.env.production]
    depends_on: { db: { condition: service_healthy } }
  app:
    build: .
    restart: unless-stopped
    env_file: [.env.production]
    depends_on:
      db: { condition: service_healthy }
      migrate: { condition: service_completed_successfully }
    volumes: ["uploads:/data", "next-cache:/app/.next/cache"]
    read_only: true
    tmpfs: ["/tmp"]
    deploy: { resources: { limits: { memory: 1g } } }
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:?set in .env.production}", POSTGRES_DB: app }
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U app -d app"], interval: 10s, retries: 10 }
volumes: { pgdata: {}, uploads: {}, next-cache: {} }
```

`compose.yaml` (dev) refleja la misma topología con bind mount del código, Mailpit y
`WATCHPACK_POLLING` opcional. `.env.production.example` acompaña a `.env.example`. Servicios
opcionales (`redis`, `minio`, `worker`) solo por decisión del plan, documentados en `README`.

## 7. Ganchos para Forja

`scripts/source-tags.js` + bloque `webpack` en `next.config.ts`; `/api/health`
(`{ok, db, version}`); `AGENTS.md` con sección fija "Forja" sembrada por la plantilla y
mantenida por `docs`.

## 8. Otras plantillas

Interfaz `template.json` (nombre, versión, comandos, puerto, salud, alcances por rol). v1
solo `nextjs-postgres`.
