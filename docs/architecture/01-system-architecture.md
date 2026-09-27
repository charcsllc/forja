# 01 · Arquitectura del sistema

## Vista de un vistazo

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Navegador                                                                            │
│   Forja Web (Next.js 16, la UI actual)  ── iframe ──▶ http://<id>.forja.localhost   │
└──────────────┬───────────────────────────────────────────────────────▲───────────────┘
               │ same-origin /api/*                                    │ Traefik (labels)
┌──────────────▼───────────────┐   HTTP + SSE  ┌───────────────────────┴───────────────┐
│ apps/web (server)            │──────────────▶│ apps/engine                            │
│  /api/vcaas/* → engine v1    │  FORJA_ENGINE │  API v1 (compat Totalum) + API v2      │
│  /api/preview/* → engine     │  _KEY header  │  Orchestrator (pg-boss jobs)           │
│    /v2/projects/:id/preview  │               │  Agent runtime (roles, tools, router)  │
│  /api/visual-edit/* (local)  │               │                                        │
│  /api/files/<token> → engine │               │                                        │
└──────────────────────────────┘               │  Sandbox manager (dockerode via        │
                                               │   socket proxy) · Git · Storage · Ledger│
                                               │  ↔ forja-browser sidecar (Playwright,  │
                                               │    sharp; sin socket Docker)           │
                                               └──┬──────────┬──────────┬──────────────┘
                                                  │          │          │
                                     ┌────────────▼──┐  ┌────▼─────┐ ┌──▼──────────────────┐
                                     │ Postgres      │  │ /data    │ │ Docker daemon        │
                                     │ (engine DB +  │  │ repos,   │ │  forja-app-<id>      │
                                     │ pg-boss)      │  │ uploads, │ │  forja-db-<id>       │
                                     └───────────────┘  │ artifacts│ │  forja-prod-<id>     │
                                                        └──────────┘ │  traefik             │
                                                                     └──────────────────────┘
                     Proveedores LLM (solo los activados por env) ◀── packages/llm
                     Unsplash/Pexels/Pixabay · OpenAI Images/Imagen/fal ◀── packages/media
```

## Componentes

### apps/web (la UI actual, casi intacta)
- Sigue siendo la aplicación Next.js 16 que existe hoy. Cambios en la fase 1 del plan:
  `VCAAS_BASE_URL` pasa a leerse de `FORJA_ENGINE_URL`, la cabecera `api-key` pasa a llevar
  `FORJA_ENGINE_KEY`, la allowlist de `git-diff` y la guardia SSRF aceptan el origen del
  engine, y los fallbacks `*.totalum-project.com` se sustituyen por el dominio configurado.
- El proxy de preview, cuando el backend es el engine, reenvía a
  `engine /v2/projects/:id/preview/*` (la web no está en la red de los sandboxes; `04 §4`).
  Una ruta nueva `api/files/[token]` sirve al navegador los ficheros firmados del engine
  (`05 §2.3`) y otra `api/runs/[id]/events` reenvía el SSE de la v2 (fase 3).
- En fase 3 añade el cliente SSE de la API v2 (plan visible, herramientas, diffs en vivo,
  coste). Hasta entonces la UI funciona por polling exactamente como hoy.

### apps/engine (nuevo; Node 22, TypeScript estricto, Hono)
Un solo proceso con módulos internos claramente separados. Se puede partir en varios
procesos más adelante porque hablan por la base de datos y la cola, no por memoria.

| Módulo | Responsabilidad |
|---|---|
| `api/v1` | Implementa el contrato de Totalum tal cual lo consume la UI (`docs/research/02`). Envelope `{errors, data}`, mismos códigos de error, mismas transiciones síncronas. |
| `api/v2` | API propia: runs, eventos SSE, tareas, coste, salud. Sin restricciones de compatibilidad. |
| `orchestrator` | Máquina de estados de un run. Encola fases en pg-boss, aplica presupuestos, gestiona reintentos y cancelación. |
| `agents` | Runtime de agentes: carga prompts, ensambla contexto, ejecuta el bucle modelo ↔ herramientas, emite eventos. |
| `llm` | Router de modelos sobre Vercel AI SDK v7: proveedores, capacidades, fallbacks, protocolo de herramientas nativo o XML, contabilidad. |
| `tools` | Implementación de las herramientas (ficheros, shell en sandbox, git, base de datos, navegador, imágenes, diseño). |
| `sandbox` | Ciclo de vida de contenedores por proyecto vía `dockerode`: crear, arrancar, exec, logs, parar, snapshot, destruir. |
| `git` | Repositorios por proyecto, worktrees por tarea, commits, tags, diffs, revert. |
| `preview` | Registro de rutas de Traefik por labels; salud de la app; captura de pantalla. |
| `deploy` | Build de producción, contenedor prod, dominios, certificados. |
| `db-cms` | Introspección de Postgres y compilación del DSL de consulta de la UI a SQL. |
| `storage` | Ficheros subidos y artefactos en `/data`, URLs firmadas con caducidad. |
| `ledger` | Tokens, coste por modelo, presupuestos, informes. |
| `secrets` | Cifrado AES-256-GCM con clave maestra; renderizado a `.env` del sandbox. |
| `integrations` | GitHub (push/pull), Figma (lectura de diseños). Opcionales. |

### packages (código compartido, sin dependencias entre ellos salvo `contracts`)
- `packages/contracts`: esquemas zod y tipos de la API v1, v2, eventos, mensajes de agente, plan, tareas, mensajes localizados y slugs reservados. Su única dependencia de runtime es zod. Es el único paquete que importa `apps/web`.
- `packages/llm`: router y proveedores. Sin conocimiento de agentes.
- `packages/agents`: definición de roles, prompts (cargados desde `docs/prompts/` en build), políticas de herramientas por rol.
- `packages/sandbox`, `packages/git`, `packages/media`: adaptadores de infraestructura.
- `packages/db`: esquema Drizzle del engine y migraciones.

### templates/nextjs-postgres
La aplicación de partida que los agentes reciben para cada proyecto. Descrita en `06`.

### infra/
`compose.yaml` de la plataforma (web, engine, postgres, traefik), `Dockerfile` de web y engine,
imagen base del runner de sandboxes, configuración de Traefik.

## Estructura del monorepo (npm workspaces)

```
forja/
├── apps/
│   ├── web/                 # la UI actual (movida desde la raíz en la fase 0)
│   └── engine/              # el servicio nuevo
├── packages/
│   ├── contracts/
│   ├── llm/
│   ├── agents/
│   ├── sandbox/
│   ├── git/
│   ├── media/
│   └── db/
├── templates/
│   └── nextjs-postgres/
├── infra/
│   ├── compose.yaml
│   ├── traefik/
│   └── images/runner/Dockerfile
├── docs/                    # este diseño y los prompts
├── AGENTS.md · CLAUDE.md · README.md · CHANGELOG.md
└── package.json             # workspaces, scripts raíz (dev, build, typecheck, test)
```

Reglas: `apps/*` importan de `packages/*`; `packages/*` nunca importan de `apps/*`;
`packages/contracts` no importa nada de runtime; ningún paquete importa `dockerode` salvo
`sandbox`; ningún paquete importa SDKs de proveedores salvo `llm` y `media`.

## Flujo de una petición (prompt → app)

1. **Entrada.** La UI llama `POST /api/vcaas/projects/launch` (web) → `POST /v1/projects/launch` (engine).
2. **Creación síncrona.** El engine crea la fila `projects`, inicializa el repositorio git desde
   la plantilla (`templates/nextjs-postgres`), persiste el mensaje del usuario, crea el run
   con `status="received"` (proyectado a `init`) y responde. La UI ve
   `agentProcessStatus:"init"` en la primera consulta, como exige el contrato.
3. **Provisión (job `sandbox.provision`).** Red interna, volúmenes, contenedor Postgres con
   la base `app` y la base de verificación del run, contenedor de app (`work/`, `main`) y
   contenedor de verificación (`run/`, rama del run) con `npm ci` desde caché y
   `next dev --webpack`. Traefik descubre el contenedor de app por labels.
   `agentServerStatus` pasa de `Creating` a `Active`.
4. **Comprensión (job `run.direct`).** El **director** lee el prompt, los adjuntos y, en
   follow-ups, el estado del proyecto (AGENTS.md generado, ADRs, árbol, últimos commits).
   Clasifica la intención (`question | tweak | bugfix | feature | refactor | infra | full`) y
   emite un `RunPlan`: spec, decisiones, DAG de tareas con rol, alcance, dependencias,
   criterios de aceptación y pesos de presupuesto.
5. **Diseño.** `designer` produce el sistema de diseño; después `brand` (identidad) e
   `imagery` (imágenes) en paralelo; después `copywriter` (textos, SEO, `alt`).
6. **Datos.** `database` escribe esquema, migraciones, seed y consultas; migra la **base de
   verificación** del run.
7. **Implementación.** `backend` y `frontend` ejecutan sus tareas **en secuencia** (v1) sobre
   la rama del run, cada una con lease de ficheros; el contenedor de verificación muestra
   el estado del run; el usuario sigue viendo `main` en la preview.
8. **Integración.** El **supervisor** instala dependencias, genera o actualiza
   `Dockerfile`, `compose*.yaml`, `.env.example`, `src/env.ts`, scripts y CI, y valida.
9. **Verificación.** El **orquestador** ejecuta las puertas (tipos, lint, migraciones,
   tests, build, imagen de producción, rutas, flujos, a11y, capturas); `qa` escribe los
   e2e y hace el triaje de los fallos; `designer` revisa las capturas. Rondas acotadas.
10. **Revisión.** `reviewer` y `security` por módulo; bloqueantes vuelven a implementación.
11. **Documentación.** `docs` actualiza `README.md`, `AGENTS.md`, ADRs, changelog, backlog.
12. **Cierre.** Merge de la rama del run en `main`, tag, migración de la base `app`, captura
    (`previewImageUrl`), coste, y mensaje final del director (`finished`, con `versionId`).

Un follow-up pequeño no recorre todo el pipeline: la intención elige uno reducido (`03 §2`).

## Ejecución de las herramientas: dónde corre qué

| Herramienta | Dónde | Cómo |
|---|---|---|
| Leer/escribir/editar ficheros, grep, glob | Engine | Acceso directo al checkout `run/` en `/data/projects/<id>/`. Cada escritura pasa por el lease de la tarea y por el redactor de secretos a la vuelta. |
| `bash`, `npm`, `tsc`, `next build`, tests | Contenedor de verificación | `docker exec` en `forja-verify-<id>`, uid 1000, cwd `/workspace`, timeout y límite de salida. |
| Git | Engine | `git` nativo sobre `repo.git`, `work/` y `run/`. |
| Base de datos del proyecto | Contenedor de DB | Desde el engine por la red interna (`forja-db-<id>:5432`, base `verify_<runId>`). |
| Navegador (capturas, axe, flujos) e imágenes (`sharp`) | Sidecar `forja-browser` | Playwright + Chromium, sin socket Docker, contra `forja-verify-<id>:3000`. |
| Imágenes (buscar, generar) | Engine | APIs externas activadas; el resultado se escribe al checkout. |
| Modelos LLM | Engine | `packages/llm`, salida a Internet. |
| Puertas de verificación | Engine (orquestador) | Código determinista; no pasa por ningún agente. |

El engine es el único proceso que habla con el daemon de Docker, a través de un socket
proxy acotado. Los sandboxes y el sidecar no tienen acceso al socket. El registro completo
de herramientas está en `11-tool-registry.md`.

## Decisiones de tecnología y por qué

| Decisión | Alternativas descartadas | Razón |
|---|---|---|
| Hono para la API del engine | Express, Fastify, Next route handlers | Tipado, streaming SSE limpio, ligero, sin acoplarse a Next. |
| Vercel AI SDK v7 como base del router | LiteLLM, OpenRouter como gateway, SDKs crudos | TypeScript nativo, providers oficiales para casi todos, `providerOptions` para rarezas. Escape a SDK crudo donde haga falta (`research/03 §C.1`). |
| Postgres + pg-boss | Redis + BullMQ | Un solo datastore, encolado transaccional, suficiente para decenas de runs concurrentes. BullMQ queda como opción si se necesita escala. |
| Drizzle ORM (engine y plantilla) | Prisma, Kysely | Migraciones SQL legibles en el repo, tipado fuerte, sin motor binario, funciona en el sandbox sin red. |
| dockerode | Docker CLI, Testcontainers | API completa, streams de exec y logs, sin parseo de stdout. |
| Traefik v3 | Caddy, proxy en Next | Descubrimiento por labels sin recarga, WebSockets para HMR, ACME para dominios. |
| Playwright | Puppeteer | Multi-navegador, esperas robustas, ya es el estándar de e2e en la plantilla. |
| Un `.md` por prompt en `docs/prompts/` | Prompts en código | Revisables por humanos, versionados, diffs legibles; se empaquetan en build. |

## Lo que se mantiene de la UI sin cambios

Todo `src/components/*`, la página de proyecto, la home, el editor visual, el CMS de base de
datos, los modales. El contrato de `research/02` garantiza que funcionen. Los únicos
ficheros de la UI que cambian en la fase 1 se enumeran en `08-migration-plan.md`.
