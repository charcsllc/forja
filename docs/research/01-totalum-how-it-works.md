# Investigación 1: cómo funciona Totalum VCaaS (y qué hacer mejor)

Fecha: 2026-09-25. Fuentes: `https://www.totalum.app/totalum-api.md` (referencia completa),
`https://www.totalum.app/openapi.json` (OpenAPI 3.1, 65 operaciones, incluye `x-totalum-cost`),
las páginas `/docs/api/*`, `/docs/developers/*`, `/docs/database*`, `/docs/data-storage-security`,
`/docs/build-your-own-ai-app-builder`, `/docs/mcp` y `/whitelabel`. Los siete ficheros
`totalum-api/*.md` enlazados desde la referencia devuelven la home del sitio; se cubrieron con
OpenAPI y las páginas HTML.

Este documento es el punto de partida del rediseño (ver `docs/architecture/`). Se conserva
tal cual para saber qué se está sustituyendo.

## 1. Hechos de plataforma

- **Base URL y auth.** `https://api-accounts.totalum.app`, prefijo `/api/v1/vcaas`, cabecera
  `api-key: tlm_sk_…`. Envelope `{errors: null|{errorCode, errorMessage}, data}`. Excepción:
  clave inválida → `401 {"error":"Unauthorized api key"}`. Analítica de gasto fuera de
  `/vcaas`: `/api/v1/credits/spending-analytics`.
- **Servidor MCP.** `https://api-accounts.totalum.app/api/v1/mcp`, Streamable HTTP, misma cabecera.
- **El agente de código es Claude Code.** `clear-context` dice literalmente "the next prompt
  starts a brand-new Claude Code session". Los prompts y el código van a Anthropic; la voz a
  OpenAI Whisper. La página whitelabel habla de "Claude Code · Codex · OpenCode" y de "AI
  tests it in a browser": la API no expone nada de eso; tratar como marketing.
- **Sandbox.** Una VM dedicada por proyecto en datacenters de la UE. Se archiva tras 6 h de
  inactividad y se destruye a los 2 días. Queda una captura estática (`cachedDevelopmentUrl`).
- **Stack generado.** TypeScript, Next.js App Router, React, Tailwind, BetterAuth, Stripe y
  `totalum-api-sdk`. Solo JS/TS.
- **Base de datos.** Una MongoDB por proyecto, accesible solo por HTTPS vía el SDK con
  `TOTALUM_API_KEY`; sin connection string. Límites: 5 M filas/tabla, 300 tablas, 10 TB. El SDK
  también incluye servicios de plataforma (crud, files con PDF y OCR, email, openai, gemini,
  scrapping) facturados como "créditos de infraestructura". Contradicción: whitelabel dice
  "Workers + D1".
- **Producción.** `next build` desplegado en Cloudflare Workers, un worker aislado por
  proyecto, en `{projectId}.totalum-project.com`. Dominios propios con Cloudflare for SaaS
  (TXT `_cf-custom-hostname.<sub>` + CNAME). Logs de producción = Workers trace events
  (`EventTimestampMs`, `Outcome`, `WallTimeMs`, `CPUTimeMs`, `Logs[]`, `Exceptions[]`), 3 días.
- **Almacenamiento.** Subidas, archivos y logs del agente en Google Cloud Storage con URLs firmadas.
- **Env inyectado en cada app** (`github/env`): `TOTALUM_API_KEY`, `BETTER_AUTH_SECRET`,
  `NODE_ENV`, `NEXT_PUBLIC_APP_URL` más los secretos del usuario. `projectId` es literalmente
  el id de organización.

## 2. Ciclo de vida

### 2.1 Proyecto

- `POST /projects/launch` crea y arranca la primera ejecución en una llamada. Obligatorio
  `projectId`, `prompt`. Opcional `model`, `effort`, `fastMode`, `description` (≤500), `label`
  (≤80), `groupId`, `files[]` (≤10, `url` o `content` base64, `name`, `description`),
  `creditLimits{maxDevelopmentCreditsPerMonth, maxInfrastructureCreditsPerMonth}`, `secrets[]`
  (≤50, `{secretName, secretValue, environment}`), `figma{token}`.
  **El orden importa:** límites → secretos (escritos al `.env` del sandbox) → Figma → ficheros
  → agente. Todo lo validado antes de crear devuelve 4xx sin dejar nada; después de crear, un
  paso fallido devuelve 200 con `warnings[{step, errorCode, errorMessage}]` y
  `agent.started=false`. Respuesta: `projectId`, `requestedProjectId` (solo si el nombre
  estaba ocupado), `agent{started, status:"init", message, expectedMinutes, expectedFinishAt, warnings[]}`.
- **Colisión de nombre.** Se prueba el nombre y después con 2..6 caracteres aleatorios.
  `409 PROJECT_ALREADY_EXISTS` solo si todos están ocupados. `projectId` inmutable, 4–35
  chars, `[a-z][a-z0-9-]*`, es el hostname de producción; `label` es el nombre editable.
- `POST /projects` crea vacío (para import, GitHub connect o escribir ficheros a mano).
- `GET /projects`: `limit` ≤100, `skip`, `search`, `sortField` (date|lastModified),
  `sortDirection`, `groupId` (`none`), `createdFrom`, `createdTo`. Cabeceras `X-Total-Count`,
  `X-Limit`, `X-Skip`, `X-Has-More`. Items con `previewImageUrl` (captura tras cada prompt),
  `lastModifiedAt`, `productionProjectUrl` (canónico, no prueba de deploy).
- `GET /projects/:id` es el endpoint principal de polling. Campos: `agentProcessStatus`
  (init|done|idle), `agentServerStatus` (Active|Creating|Starting|Archived|Unarchiving|Archiving),
  `deployment{status, createdAt, versionId}`, `versionRecovery{status: recovering|error,
  versionId, startedAt, errorMessage}`, `importInProgress{startedAt, errorMessage}`, `secrets[]`
  (solo nombres), `customDomain{hostname, status, sslStatus, dnsRecordsToAdd[]}`,
  `temporalDevelopmentProjectUrl`, `cachedDevelopmentUrl`, `developmentUrlFieldToUse`,
  `productionProjectUrl`, `totalCreditsSpent`, `creditLimits`, `multiPrompt`. Cacheado unos
  segundos; un PATCH invalida.
- `PATCH /projects/:id` `{label?, description?, groupId?}` (`null` limpia; `{}` →
  `NOTHING_TO_UPDATE`). `DELETE` despublica primero (`UNPUBLISH_FAILED` 502 = nada borrado;
  `DEPLOYMENT_RUNNING` 409). `PATCH /credit-limits`: por defecto desarrollo sin tope,
  infraestructura 250; al tope `403 PROJECT_CREDIT_LIMIT_REACHED`; reset el día 1.
- Límites por plan: Free 2 proyectos (1/5 min, 12/h), Starter 10 (5/min), Basic 50 (10/min),
  Professional 300 (30/min), Enterprise ilimitado (100/min, 1.200/h). `403 MAX_PROJECTS_REACHED`
  con `errorDetails{maxProjects, projectsUsed, plan, upgradePlan}`; `429 RATE_LIMIT_EXCEEDED`.

### 2.2 Ejecución del agente

- `POST /projects/:id/agent/start`: `prompt`, `inputFiles[{name, imageDescription, url}]`,
  `multiPrompt{prompts[] ≤50 | letTotalumDecide:true}`, `model` (`opus` por defecto | `sonnet`),
  `effort` (`low|medium|high|xhigh`), `fastMode` (bool, solo Opus). Una opción inválida nunca
  falla la petición: se descarta y se informa en `data.warnings[]`. Sin opciones, Totalum
  enruta modelo y esfuerzo por prompt. Devuelve `{status:"init", message, expectedMinutes,
  expectedFinishAt}`. Errores 409: `AGENT_RUNNING`, `AUTO_EXECUTION_ALREADY_ACTIVE`,
  `DEPLOYMENT_RUNNING`, `RECOVERY_RUNNING`, `REBUILD_RUNNING`, `GITHUB_PULL_RUNNING`,
  `IMPORT_IN_PROGRESS`; `INSUFFICIENT_CREDITS` 402; `PROMPT_SECURITY_VIOLATION` 400.
- `GET /agent/status` (cada 10–15 s): `status` init|done|idle, `startedAt`,
  `realtimeConversation[]` = `{author: user|agent, message, messageType:
  regular|starting|building|finished|error|limit-reached, createdAt, versionId?, gitDiffUrl?,
  secretKeysNeeded?{KEY:{isProvided, description}}}`, `creditsSpent`, `expectedMinutes`,
  `expectedFinishAt`, `multiPrompt{status: planning|executing|paused|done|cancelled, ...}`.
- **La conversación es una lista plana de mensajes de texto gruesos. No se exponen eventos
  de herramientas**, ni ediciones de fichero, ni salida de comandos, ni stream de tokens.
- `POST /agent/stop` (no reanudable). `POST /agent/clear-context` descarta la sesión de
  Claude Code; rechazado mientras hay ejecución.
- **Tiempo y coste.** 5–40 min y 6–46 créditos por ejecución; 6 por adelantado y el resto al
  final; al tope de tiempo se cobran 50 (o 60) planos; una ejecución fallida se reembolsa.
- **Mecanismo inferido.** Cola por proyecto que ejecuta `claude` (CLI o SDK) dentro de la VM
  con id de sesión persistido. Al terminar: commit git, documento de versión, diff a GCS
  (`gitDiffUrl`), captura de la home (`previewImageUrl`), parseo de variables necesarias a
  `secretKeysNeeded`, push a `develop` si hay GitHub y webhook `agent.prompt.finished`.

### 2.3 Sandbox y servidor de desarrollo

- Estados: Creating → Starting → Active → Archiving → Archived → Unarchiving.
- `POST /agent/server/start-or-restart` cuesta `START_SERVER` = 3 créditos, 2–4 min, devuelve
  `{status:"starting"}`. Permitido durante rebuild, pull o import.
- `temporalDevelopmentProjectUrl` = `next dev` vivo; `cachedDevelopmentUrl` = captura estática;
  `developmentUrlFieldToUse` dice **qué campo leer** (por defecto el temporal). Releer al
  cargar, al refrescar y tras cada `done`.
- Auto-despertar: deploy, recover, GitHub connect y pull sobre un servidor dormido lo
  arrancan (cobrando) y devuelven `409 SERVER_NOT_READY`; el cliente hace polling hasta
  `Active` y reintenta. `version-diff` dormido → `NO_ACTIVE_SANDBOX`. Escritura y rebuild →
  `NO_SANDBOX` / `SANDBOX_NOT_ACTIVE`.
- `GET /backend/dev/logs` → `{logs: string}` (el fichero de log de la VM).

### 2.4 Despliegues y dominios

- `POST /deployments/deploy` 1 crédito, `{status:"deploying"}`, 2–5 min. `GET
  /deployments/status` → `{status: deploying|success|error|null, createdAt, versionId}`. Con
  GitHub conectado, hace push a `main`. Justo después del deploy el estado puede describir
  el anterior.
- `POST /deployments/unpublish` gratis y síncrono: quita sitio, captura y todos los dominios.
- `PUT /domain {hostname}` 2 créditos, necesita deploy previo (`NO_DEPLOYMENT`). Solo
  subdominios. Devuelve `pending_validation` y `dnsRecordsToAdd[{type, name, value}]`. Estados
  pending_validation → pending_deployment → active | blocked. `DELETE /domain`.
- Mecanismo inferido: `next build` + adaptador tipo OpenNext a un Worker por proyecto
  (Workers for Platforms) y Cloudflare for SaaS. Producción es otra máquina distinta de dev.

### 2.5 Base de datos (Mongo por proyecto, API estilo CMS, gratis)

- `GET /database/tables-structure` → `tables[{_id, type, label, description, icon,
  properties{name:{id, name, propertyType, label, description, objectReference, typeExtras}}}]`.
  `propertyType`: `string | number | date | options | file | long-string | objectReference`.
- `POST /database/query {tableName, queryOptions}`: `_filter`, `_sort{f: asc|desc}`, `_limit`
  (50 por defecto, máx 1000), `_offset`, `_select`/`_omit`, `_count` (añade `_count._total`),
  `_aggregate{_sum|_avg|_min|_max|_count}`, `_groupBy`. Operadores: `gte lte gt lt ne in nin
  regex(+options) contains startsWith endsWith _or[]`. Expansión de relaciones por nombre de
  propiedad (`{orders: true}` o `{orders: {_filter, _sort, _limit ≤300}}`), `_has:
  true|"none"`, `_count: true`, hasta 6 niveles. Respuesta `{results: []}`.
- Registros: `POST /database/records {tableName, data}`, `PATCH /records/:rid`, `DELETE
  /records/:rid?tableName=`, `POST|DELETE /records/:rid/link {tableName, propertyId,
  referenceId}` (solo many-to-many).
- Campos fichero: el cliente escribe `{name}`; las URLs son firmadas de GCS.
- Mecanismo inferido: colección de metadatos con las tablas, una colección Mongo por `type`,
  compilador de consultas a pipelines de agregación con `$lookup`.

### 2.6 Ficheros, rebuild y código fuente

- `GET /files/tree?path=&limit≤5000&offset=` → `entries[{path, name, type, size, depth}]`,
  `totalEntries`, `hasMore`, `commitSha`, `filesCount`. Excluye node_modules, .next, .git, dist.
- `GET /files/content?path=` (≤1 MB) → `{encoding: utf8|base64, content, commitSha}`.
- `PUT /files/content {path, content, encoding}` (≤512 KB). **Cada escritura es un commit y
  una versión**, y push a GitHub si está conectado. Coste 0,1 crédito (OpenAPI dice 1).
  Rechazado en Free (`FREE_PLAN_NO_SOURCE_EDITING`).
- **Por qué base64.** Un middleware global `sanitize-html` sobre los cuerpos elimina JSX
  (`className`) de cadenas planas. Base64 no contiene `<`, `>` ni `&`. Es un bug upstream que
  los clientes esquivan.
- **Las escrituras no van en vivo.** Hace falta `POST /rebuild` (1 crédito, build frío,
  1–4 min). `GET /rebuild/status` → `{status: idle|rebuilding|success|error, startedAt,
  finishedAt, elapsedSeconds, livePreviewUrl, errorCode, errorMessage}`.
- `GET /source-code` 1 crédito → `{filesCount, lastCommitSha, downloadUrl}` (URL firmada,
  ~30 min). `POST /files/upload` (multipart `file`, ≤8 MB, 0,5 crédito) → `{fileNameId, url}`.

### 2.7 Versiones

- Crean versión: cada prompt terminado, cada escritura, cada pull de GitHub y cada import.
- `GET /versions?limit=20&skip=` → `versions[{_id, name, commitSha, commitMessage, prompt,
  gcsUploaded, recoveredVersionId, createdAt, updatedAt}]`, `totalCount`.
- `GET /version-diff?commitSha=` → diff unificado calculado en el sandbox (debe estar despierto).
- `POST /versions/:id/recover` 2 créditos, async, 1–4 min; seguir `versionRecovery` en el
  proyecto. El marcador caduca a los 10 min; `DELETE /versions/recovery` lo limpia. La
  recuperación produce una versión **nueva** con `recoveredVersionId` (revert hacia delante).
- Mecanismo inferido: documentos Mongo apuntando a commits del repo del sandbox más un
  tarball en GCS por commit (sobrevive a la destrucción de la VM a los 2 días).

### 2.8 Logs, secretos, GitHub, Figma, webhooks, transferencia

- Dev: texto crudo. Prod: `GET /backend/prod/logs?getOnlyLastLogs&from&to&regexSearch`, 3
  días, trace events de Cloudflare, cada campo opcional.
- Secretos: `POST /secrets {secretName, secretValue, environment}`, `DELETE /secrets/:id`.
  Cifrados, "nunca devueltos"… pero `GET /github/env` devuelve `envDev` y `envProd` completos
  con valores y con `TOTALUM_API_KEY`. El agente puede pedir claves vía `secretKeysNeeded`.
- GitHub: `POST /github/connect {token PAT, repositoryFullName, syncDirection}`; requiere
  Contents RW, Pull requests RW y **Administration RW**. Push automático a `develop` tras cada
  prompt y a `main` en cada deploy. `GET /github/status`, `POST /github/pull` →
  `{status: pulling|no_changes, filesUpdated}`, `GET /github/pull-status`. Sin webhooks
  entrantes, sin PRs.
- Figma: `POST /figma/validate {token}` → `{valid, account}` (10/min); `POST|DELETE
  /projects/:id/figma/connect`; `GET /figma/status?verify=true`. El token se entrega al agente.
- Webhooks: `PUT /webhooks {url https, event, headers?}`, uno por evento, solo dos eventos
  (`agent.prompt.finished`, `project.credit_limit.reached`), payload `{event, timestamp,
  data{projectId, status, prompt}}`. Sin firma ni reintentos documentados.
- Export `POST /export {includeRecords}` → `importCode` (2 créditos, 1/min, 5/h). Import
  `POST /import {importCode}` (6 créditos, destructivo, destino casi vacío). Grupos en
  `/project-groups`.

### 2.9 Créditos y concurrencia

- `GET /account` → `credits`. Precio 0,07 $/crédito. `GET /credit-costs`: CREATE_PROJECT 1,
  CREATE_DEPLOYMENT 1, START_SERVER 3, GET_SOURCE_CODE 1, RECOVER_VERSION 2, UPLOAD_FILE 0,5,
  ADD_CUSTOM_DOMAIN 2, EXPORT_PROJECT 2, IMPORT_PROJECT 6, UPDATE_FILE 0,1, REBUILD_PROJECT 1.
- Dos categorías: desarrollo (agente, deploy, escrituras) e infraestructura (uso del SDK por
  la app generada).
- Una operación pesada por proyecto a la vez (agente, deploy, recovery, rebuild, pull,
  import), cada una con su 409. Marcadores caducan a los 10 min (salvo el agente). Peticiones
  mutantes serializadas con espera de 3 s y después `409 PROJECT_BUSY`.

## 3. Mapa capacidad → mecanismo (inferido)

| Capacidad | Mecanismo más probable |
|---|---|
| Proyecto | Documento "organization" en Mongo (id = slug = hostname) + Mongo por proyecto + repo git + VM |
| Ejecución | Sesión de Claude Code en la VM, reanudada por proyecto; mensajes gruesos a Mongo; medida por tokens y tiempo |
| model/effort/fastMode | Opus/Sonnet, presupuesto de thinking, modo rápido de Anthropic; router automático si no se indica |
| Multi-prompt | Cola servidor (planificador LLM → prompts secuenciales) |
| Preview dev | `next dev`/`next start` en la VM tras proxy inverso `dev-<id>.totalum.app` |
| Dormir/despertar | Snapshot de disco a las 6 h, destrucción a los 2 días; unarchive = restaurar + reinstalar |
| Preview cacheada | Export estático subido a `<id>-dev-<hash>.totalum-project.com` |
| Versiones | commits + documento + snapshot en GCS |
| Diff | `git show` en la VM; diff por ejecución subido a GCS |
| Publicar | Build en la VM → bundle tipo OpenNext → Worker por proyecto |
| Dominio | Cloudflare for SaaS |
| Base de datos | Mongo por proyecto + capa de esquema CMS + compilador a agregaciones |
| Auth en la app | BetterAuth con la colección de usuarios en la DB del proyecto |
| Secretos | Cifrados en Mongo, renderizados al `.env`, bindings del Worker en deploy |
| Capturas | Navegador headless tras cada prompt |

## 4. Valoración crítica

### 4.1 Conservar

1. Superficie REST orientada a recursos con envelope estable, `errorCode` estables, un 409
   con nombre por operación bloqueante y "qué consultar después" en cada mensaje.
2. `launch` atómico y ordenado, con la semántica honesta "200 = el proyecto existe; lee
   `warnings[]`", y validación previa sin cobro.
3. Opciones de ejecución que nunca fallan la petición (se descartan y se informan).
4. Cada mutación es un commit y una versión; la recuperación es hacia delante, no destructiva.
5. Marcadores de operación con TTL y serialización por proyecto: un bloqueo colgado no puede
   inutilizar un proyecto.
6. Precios legibles por máquina, topes mensuales, analítica de gasto, lecturas gratis.
7. `developmentUrlFieldToUse`: el servidor decide vivo o captura.
8. Captura estática mientras duerme.
9. `secretKeysNeeded` estructurado en los mensajes del agente.
10. Auto-sufijo en colisión de nombre con `requestedProjectId`.
11. El DSL de consulta de la base de datos: compacto y amigable para la UI. Merece clonarse.
12. Canales separados de logs dev/prod con búsqueda por regex en prod.
13. Un servidor MCP sobre la misma API.

### 4.2 Débil o ausente

- **Sin streaming.** Todo es polling; no hay SSE ni WebSocket, ni stream de tokens o
  herramientas, ni eventos de cambio de fichero.
- **Agente opaco.** Un solo proveedor (Anthropic). Sin planificación visible, sin aprobación,
  sin checkpoints, sin reanudar tras stop. Sin typecheck, lint ni tests expuestos.
- **Concurrencia gruesa.** Una operación pesada por proyecto; sin ramas ni worktrees; sin
  variantes en paralelo. Multi-prompt secuencial y sin supervisión.
- **Bucle de edición lento.** Escribir y después rebuild frío de 1–4 min. Sin HMR para
  ediciones manuales aunque exista un servidor de desarrollo.
- **Ciclo de vida del sandbox frágil.** Despertar cuesta 2–4 min y 3 créditos; los diffs
  necesitan la VM despierta; destrucción a los 2 días.
- **Bugs upstream filtrados al contrato.** `sanitize-html` obliga a base64; costes y formatos
  de archivo inconsistentes.
- **Seguridad.** `GET /github/env` devuelve secretos en claro; webhooks sin firma; PAT con
  Administration RW; sin claves por usuario final.
- **Modelo de eventos mínimo.** Dos eventos, sin reintentos ni firma.
- **Lock-in.** Las apps dependen de `totalum-api-sdk`, del Mongo alojado y de APIs
  proxificadas. "Autoalojar" sigue llamando a Totalum. Sin Postgres ni migraciones en el repo.
- Solo Next.js/TypeScript y solo Workers en producción. Sin entornos por rama ni por versión.
- Coste visible solo al final; sin desglose por tokens ni modelo.

### 4.3 Qué añadiría un diseño "exponencialmente mejor"

1. **Protocolo de eventos determinista y en streaming.** Tabla `run_events` append-only
   `{seq, runId, type: plan|tool_call|tool_result|file_diff|command|stdout|test_result|cost|message|status, payload}`
   servida por SSE con replay, exportada a webhooks firmados y a OpenTelemetry.
2. **Multiagente con roles especializados y handoffs explícitos**, workers en worktrees git
   separados, merge determinista, revisor y QA con navegador.
3. **Múltiples proveedores LLM tras un router** con modelo por rol, fallback y claves propias.
4. **Puertas de verificación duras**: la ejecución solo termina con typecheck, lint, tests y
   build en verde, o con una explicación. Resultados guardados por versión.
5. **Versionado nativo git** con ramas por ejecución, tags por deploy, diffs sin sandbox.
6. **Entornos de preview por versión** y producción = promocionar una versión.
7. **Generación automática de `compose.yaml`** como artefacto de primera clase, con Postgres
   y migraciones en el repo: autoalojar = `docker compose up`.
8. **Bucle de edición rápido**: `next dev` con HMR; escrituras instantáneas; parches
   multi-fichero atómicos en un commit.
9. **Sandboxes local-first** con imágenes plantilla precalentadas y snapshot en reposo.
10. **Contabilidad de coste** por tokens, modelo y CPU; estimación previa, coste en vivo,
    presupuestos duros.
11. **Multi-tenant y seguridad** desde el inicio: claves con alcance, auditoría, webhooks
    firmados, secretos de solo escritura, política de salida de red por sandbox.
12. **Catálogo de eventos rico** (`run.*`, `build.*`, `deploy.*`, `domain.*`, `server.*`,
    `budget.*`, `version.*`, `github.*`).
13. **Memoria y contexto del agente**: `AGENTS.md` en el repo generado, índice de código,
    reset explícito, reanudación desde checkpoint.
14. **Compatibilidad de contrato**: implementar las rutas y el envelope de Totalum como capa
    de compatibilidad para que Forja funcione cambiando solo `VCAAS_BASE_URL`, y añadir los
    endpoints v2 (SSE, runs, events, checks) al lado.

## 5. Huecos y contradicciones en la documentación de Totalum

- Coste de `UPDATE_FILE`: 0,1 en `/credit-costs`, "1 crédito" en OpenAPI.
- Tecnología de base de datos: MongoDB (docs) vs "Workers + D1" (whitelabel).
- Formato del archivo fuente: `.tar.gz` (guía de autoalojado) vs `.zip` (export).
- Secretos "nunca devueltos" vs `github/env` en claro.
- Nombre de variable: `VCAAS_API_KEY` (docs) vs `TOTALUM_VCAAS_API_KEY` (Forja, con fallback).
- No documentado: base64 obligatorio en escrituras, firma y reintentos de webhooks, estados
  `paused`/aprobación de multi-prompt, `SANDBOX_NOT_REACHABLE`.
