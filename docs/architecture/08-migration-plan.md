# 08 · Plan de migración: de Totalum a Forja Engine

Principio: **la UI sigue funcionando en cada fase**. Hasta la fase 6 `TOTALUM_VCAAS_API_KEY`
sigue siendo válida; se elige backend con `FORJA_ENGINE_URL`. Cada fase termina con
typecheck y build en verde, la pantalla afectada abierta en el navegador y una entrada en
`CHANGELOG.md`.

## Fase 0 · Monorepo, cimientos y arneses de prueba

- Mover la UI a `apps/web` (`git mv`). Ajustar: `.github/workflows/typecheck.yml` (rutas y
  `working-directory`), rutas citadas en `AGENTS.md`, la regla de "portar a
  `ai-app-builder-open`" (queda limitada a `apps/web`), `CLAUDE.md`.
- `packages/contracts` con zod (tipos de `vcaas-types.ts`, `vcaas-errors.ts`, plan, eventos,
  informes, mensajes localizados, slugs reservados).
- `apps/engine` con Hono, config zod, logger, Postgres + Drizzle + pg-boss,
  `infra/compose.yaml` (init, web, engine, postgres, traefik, socket-proxy, browser sidecar)
  y `Dockerfile` de web y engine; redes `forja-core` y `forja-apps`; regla `DOCKER-USER`
  documentada.
- **Arneses antes que funciones:** proveedor LLM de *replay* (graba y reproduce respuestas
  para tests sin coste), tests de contrato v1 que reproducen las secuencias de polling de
  `research/02 §3.3` (una por transición síncrona), y el esqueleto de `agents:eval` (una
  tarea de oro por rol con criterios automáticos).
- `AGENTS.md` raíz: sección "Forja Engine" que apunta a `docs/`.

**Estado (2026-09-25): fase 0 completada, sin commit.** Seis workspaces (`@forja/web`,
`@forja/engine`, `@forja/contracts`, `@forja/llm`, `@forja/contract-tests`, `@forja/agents`),
214 tests, typecheck y `npm audit` a cero, build de web y engine en verde; el engine arrancó
contra un Postgres real (19 tablas, pg-boss, salud 200, 501 bien formado en `/v1/*`);
`docker compose config` válido. No verificado: construcción de las imágenes Docker, arranque
de la pila completa, reglas de firewall. Pendientes que la fase 1 hereda: `output:
"standalone"` en `next.config.ts` de la web, `transpilePackages: ["@forja/contracts"]` en la
web, un `build` de `@forja/contracts` consumible por Node (hoy exporta `.ts`), sustituir los
tipos locales marcados `TODO(phase-0)` por `@forja/contracts`, y quitar `docs/` del
`.dockerignore` cuando los prompts se empaqueten.

## Fase 1 · Engine v1 mínimo: proyecto, sandbox, preview, ficheros

- `packages/sandbox`, `packages/git`, imagen `forja-runner`, plantilla `nextjs-postgres`
  completa (helpers de `06 §3`, Dockerfile que arranca, CMS conventions).
- Endpoints v1 sin agente: `projects`, `restart`, `files/*` (con `STALE_WRITE`, agrupación
  de commits, `.forja` scratch), `rebuild`, `source-code`, `files/upload`, `backend/dev/logs`,
  `versions`, `version-diff`, `recover`, `secrets`, stubs GitHub/Figma, `account`,
  `credit-costs`, superficie pública firmada, `/v2/projects/:id/preview/*`.
- Cambios en la UI (todos en `apps/web`):
  - `vcaas-server.ts`: `FORJA_ENGINE_URL` + `FORJA_ENGINE_KEY` (fichero compartido o env).
  - Nueva ruta `api/files/[token]` (stream desde el engine) y `api/runs/[id]/events` (SSE, fase 3).
  - Proxy de preview: cuando el backend es el engine, reenviar a `/v2/projects/:id/preview/*`.
  - `visual-edit/apply`: reconocer `/api/files/` propio y descargar del engine; sin otros cambios en la guardia SSRF.
  - `/api/config` devuelve además `{backend: "engine"|"totalum", publishScheme, publishDomain, previewDomain}`;
    `project-status.ts`, `page.tsx`, `PublishedModal`, `DeployControl` leen esquema y dominio de ahí
    en vez de hardcodear `https://` y `totalum-project.com`.
  - `CodePanel` honra `rebuildRequired` (solo marca `rebuildNeeded` si es `true`); copy de `en.ts:4093` actualizado con `// forja`.
  - `InsufficientCreditsModal` enlaza a `/project/:id/budget` (página nueva en la UI) cuando el backend es el engine.
  - Sin `gitDiffUrl`: nada que cambiar, el DiffViewer ya cae a `version-diff`.
- Verificación en navegador: crear proyecto, preview de la plantilla en `<id>.forja.localhost`
  (probar Safari), editar y guardar en Code con cambio instantáneo, restaurar versión,
  pestaña Database sobre la base de la plantilla, subir un fichero al CMS y verlo.

**Estado fase 1 · engine (2026-09-27, sin commit).** `apps/engine` sirve la API v1 sin agente
(proyectos, provisión `sandbox.provision`, restart/wake, files, rebuild, versiones/diff/restore,
secretos, subidas, código fuente, logs dev, base de datos vía `@forja/db-cms`, stubs de 05 §2.1,
superficie pública firmada, `system/public-config`) y la v2 `preview/*`, `budget`, `undelete`,
`archive`. Verificado de extremo a extremo en Docker real: proyecto `Active` en ~60 s, preview por
Traefik (`Host: <id>.forja.localhost`) y por `/v2/projects/<id>/preview/`, edición con HMR en ~3 s,
restore, subida + URL firmada, `tables-structure` + CRUD del CMS, zip, rebuild no-op y real,
restart, archive → wake, borrado + undelete, recreación del engine (re-adjunta redes); simuladores
de `packages/contract-tests` en verde para rebuild, restart, restore y wake; `launch` responde
`agent.started:false` y `agent/start` 501 como se espera hasta la fase 2. La web se probó con su
build standalone en el host (la imagen `forja-web:local` era anterior al cableado y no había disco
para reconstruirla). Desviaciones: git ≥ 2.42 obliga a basar el runtime del engine en Debian trixie;
las rutas de base de datos despiertan el sandbox entero (no solo la DB) para que el wake de la UI
termine; imágenes subidas sin re-codificar; tabla `versions` sin poblar (git es la fuente; `_id` =
commit sha); el archivado es manual (`/v2/.../archive`) y sin captura estática. No verificado:
navegador (Chrome/Firefox/Safari con `*.localhost`), UI del workspace sobre el engine, reglas de
firewall, gVisor, `SANDBOX_EGRESS=registry-only`.

## Fase 2 · Gateway LLM y el primer bucle de agentes

- `packages/llm`: env de dos valores, catálogo verificado, router con requisitos por rol,
  bucle uniforme, ledger con `PriceFn`, `llm:smoke`.
- `packages/agents`: registro de herramientas (`11`), runtime, roles `director`, `frontend`,
  `backend`, `database`, `fixer`, `summarizer`; puertas 1–6 en el orquestador.
- Endpoints v1 de agente; mensajes localizados según `05 §2.4`.
- Verificación: un prompt sencillo produce una página nueva con puertas en verde; el coste
  aparece en `/project/:id/budget`.

**Estado fase 2 · runtime de agentes y orquestador (2026-09-28, sin commit).**
`packages/agents`: registro de herramientas (`11`, subconjunto de la fase), puertos
(workspace, exec, db, git, imágenes), bucle uniforme sobre `Provider`, protocolos nativo y
XML, compactación con el `summarizer`, ensamblador de prompts (base → rol → proveedor →
familia vía `promptNotesFor`), cabeceras de contexto y los seis roles con
`ROLE_REQUIREMENTS`. Los prompts se empaquetan en build (`bundle.generated.ts`), así que
`docs/` sigue fuera de la imagen (resuelve de otra forma el pendiente de la fase 0).
`apps/engine`: `services/llm.ts` (gateway, asignaciones al arrancar, motor en pie aunque
falten modelos, modo replay opt-in con `FORJA_LLM_REPLAY_DIR`), `services/runs/` (arranque
síncrono, orquestador, puertas 1–6, presupuesto, ledger, stop, recuperación), endpoints v1
de agente y `GET /v2/system/models`; `media_calls` conectado. Detalle y diferencias con el
diseño en `03 §11`, `05 §2.1/§2.4/§3/§4`, `11` "Estado fase 2". Verificado con proveedores
guionizados: simulador `launch` y `agentStart` de `packages/contract-tests` en verde en
proceso, recorrido completo con repositorio git real (plan → página → puertas → merge →
tag → mensaje), fixer tras puerta roja, límite de presupuesto, stop con rama conservada,
recuperación tras caída, `PgStore` contra Postgres 17 real; con `LLM_NVIDIA` solo, los seis
roles quedan asignados a `nvidia:z-ai/glm-5.3` sin hacer ninguna petición. No verificado:
un run con un modelo real, el contenedor `forja-verify` real (creación, `npm ci`, puertas
sobre la plantilla), la puerta 6 sobre la plantilla, y la UI de extremo a extremo.

## Fase 3 · Equipo completo, puertas de navegador, SSE

- Roles `designer`, `brand`, `imagery`, `copywriter`, `supervisor`, `qa`, `reviewer`,
  `security`, `docs`; `packages/media`; sidecar de navegador; puertas 7–11; SSE v2 y panel
  "Actividad" opcional en la UI.
- Calibración de presupuestos por defecto con 20 runs de referencia.
- Verificación: "una tienda de velas artesanales" produce app completa con todas las
  puertas en verde.

## Fase 4 · Publicación, dominios, archivado

- `deploy` con migraciones como job previo, `rollback`, `unpublish`, dominios con provider
  de ficheros de Traefik y ACME, logs prod, capturas, archivado/despertar,
  `cachedDevelopmentUrl`, purga de proyectos borrados.

## Fase 5 · Integraciones

- GitHub, Figma, export/import, webhooks firmados, MCP, `?env=production` en el CMS.

## Fase 6 · Retirada de Totalum

- Eliminar `TOTALUM_VCAAS_API_KEY`, el fallback, `lib/attachments.ts` (constante sin uso),
  referencias en README, `AGENTS.md`, `package.json`. Renombrado mecánico `vcaas*` →
  `engine*`. Eventos `totalum:*` se conservan (protocolo). `AGENTS.md` raíz reescrito
  desde `docs/architecture/`.
- **Proyectos existentes en Totalum**: no hay migración automática (MongoDB + SDK
  propietario). Se documenta la ruptura y el camino manual: exportar el código con
  `source-code`, importarlo como proyecto nuevo con un prompt "migra el acceso a datos de
  totalum-api-sdk a Drizzle/Postgres según el esquema adjunto" (`tables-structure`
  exportado como JSON). Hasta la fase 6, ambos backends coexisten.

## Paralelismo en v2 (después de la fase 6)

Worktrees por tarea montados en `/data/projects/<id>/wt`, contenedor de comprobación por
tarea con `node_modules` enlazado, `git_merge` del supervisor, `AGENT_MAX_PARALLEL_TASKS>1`.

## Riesgos y cómo se vigilan

| Riesgo | Señal | Respuesta |
|---|---|---|
| Transición síncrona incumplida | UI "pensando" o cerrando una operación al instante | Tests de contrato de la fase 0 en CI |
| Modelo que no sigue el protocolo | Tareas sin cambios | `llm:smoke`; fallback XML; `task.failed` explícito |
| Coste inesperado | `budget.warning` | Presupuestos bajos por defecto; página de presupuesto |
| Docker no disponible | `system/health` | `SANDBOX_DRIVER=process` solo para desarrollar Forja |
| Disco lleno | `system.pressure` | Archivado automático; documentación de limpieza |
| `*.localhost` en Safari | Fase 1 | Documentar `dnsmasq`/`/etc/hosts` |
| Turbopack por defecto en Next | `npm run dev` de la plantilla | `--webpack` fijado; loader Turbopack en backlog |
