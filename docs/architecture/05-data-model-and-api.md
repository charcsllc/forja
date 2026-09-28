# 05 · Modelo de datos y API

## 1. Base de datos del engine (Postgres, Drizzle, `packages/db`)

Todas las tablas llevan `created_at`, `updated_at`. PK `text` (UUID v7) salvo `projects`.

| Tabla | Campos principales | Notas |
|---|---|---|
| `projects` | `id` (slug, PK), `label`, `description`, `template`, `template_version`, `language`, `server_status`, `process_status`, `dev_url`, `internal_dev_url`, `cached_url`, `url_field_to_use`, `production_host`, `preview_image_path`, `archived_at`, `last_activity_at`, `deleted_at`, `purge_after` | `id` inmutable, es hostname; lista de reservados en `packages/contracts/src/slug.ts` (`apps`, `www`, `traefik`, `engine`, `web`, `api`, `preview`, `mail`, `admin`, `static`, `cdn`, `forja`…). |
| `runs` | `id`, `project_id`, `status`, `intent`, `prompt`, `input_files` jsonb, `options` jsonb, `plan` jsonb, `budget_usd`, `spent_usd`, `started_at`, `finished_at`, `heartbeat_at`, `expected_minutes`, `error`, `cancel_requested_at` | Índice parcial único: un run no terminal por proyecto. |
| `tasks` | `id`, `run_id`, `plan_task_id`, `role`, `status`, `scope` jsonb, `attempt`, `turns`, `spent_usd`, `lease_until`, `checkpoint` jsonb, `report` jsonb | `checkpoint` = mensajes nativos + diario de efectos. |
| `run_events` | `seq` bigserial PK, `run_id`, `task_id?`, `ts`, `type`, `payload` jsonb, `blob_path?` | Append-only; **sin deltas** (los deltas viven en memoria, §4); payloads > 8 KB van a `blob_path`. Retención `EVENTS_RETENTION_DAYS` (30). |
| `messages` | `id`, `project_id`, `run_id?`, `author`, `type`, `text`, `version_id?`, `secret_keys_needed` jsonb, `files` jsonb, `created_at` | `created_at` con microsegundos y **estrictamente creciente por proyecto** (secuencia + reloj) para que la clave de dedupe de la UI nunca colisione. |
| `versions` | `id`, `project_id`, `run_id?`, `tag`, `commit_sha`, `parent_sha`, `message`, `prompt?`, `recovered_from_id?`, `checks` jsonb, `db_dump_path?`, `created_at` | |
| `llm_calls` · `media_calls` | ledger (`02 §6`) | |
| `secrets` | `id`, `project_id`, `name`, `environment`, `kind` (`user`/`system`), `ciphertext`, `nonce`, `key_version` | Valor nunca en claro. `system` = generados por el engine (contraseñas de DB). |
| `deployments` | `id`, `project_id`, `version_id`, `status`, `image_tag`, `container`, `log`, `migrations_applied` bool, `started_at`, `finished_at` | |
| `domains` | `id`, `project_id`, `hostname` (único), `status`, `ssl_status`, `verify_token`, `dns_records` jsonb, `last_checked_at`, `error?` | Uno por proyecto en v1. |
| `uploads` | `id`, `project_id`, `file_name_id`, `original_name`, `mime` (detectado por contenido), `size`, `path`, `sha256` | Límite `UPLOAD_MAX_MB` (8); imágenes re-codificadas. |
| `operations` | `project_id` PK, `kind`, `started_at`, `expires_at`, `payload` | Una operación pesada por proyecto; TTL. |
| `integrations_github` · `integrations_figma` · `webhooks` · `webhook_deliveries` · `project_groups` · `settings` | como antes | |

pg-boss en el esquema `pgboss` de la misma base.

## 2. API v1: compatibilidad con la UI

Prefijo `/v1`, montado por `apps/web` bajo `/api/vcaas/*`. Cumple `docs/research/02`.

### 2.1 Decisiones por área

| Área | Decisión |
|---|---|
| Envelope y códigos | Como Totalum (`{errors, data}`, mismos `errorCode`). Presupuesto agotado → `INSUFFICIENT_CREDITS` 402. Nuevos: `NO_PROVIDER_ENABLED` 503, `STALE_WRITE` 409, `ROLLBACK_NEEDS_DB` 409 (v2). |
| Autenticación | `api-key: ${FORJA_ENGINE_KEY}` en todo salvo la **superficie pública firmada** (§2.3). La clave la genera el servicio `init` de `infra/compose.yaml` en `/data/engine/engine.key` (bind mount de `DATA_DIR_HOST`) y copia **solo** `engine.key` al volumen `forja-data`, que `web` monta de solo lectura (`infra/web-entrypoint.sh` la exporta); `web` nunca ve `master.key` ni el `.env` de infra. En servidor ambas claves se definen en env. |
| `launch` | Crea proyecto + sandbox + run; `warnings[]` por paso; `agent.started`; auto-sufijo y `requestedProjectId`. El run se crea antes de responder y espera a que la provisión deje el sandbox `Active`; si no puede empezar (p. ej. `NO_PROVIDER_ENABLED`), `agent.started:false` con `warnings[{step:"agent", code, message}]` y la UI envía el prompt guardado con `agent/start`. |
| `agent/start` | Persiste el mensaje `user` (con `files`) y crea el run con `process_status="init"` **antes** de responder; respuesta `{started:true, status:"init", runId, warnings}`. Pistas: `effort` se aplica a todos los roles del run; `model` y `fastMode` se ignoran con `warnings[{code:"HINT_IGNORED"}]` (los modelos son por rol, `AGENT_<ROL>_MODEL`). Proyecto dormido → despierta + 409 `SERVER_NOT_READY`; en creación → se acepta y el run espera. Otro run activo → `AGENT_RUNNING` 409; operación pesada en curso → `OPERATION_IN_PROGRESS` 409; presupuesto mensual agotado → `INSUFFICIENT_CREDITS` 402; roles sin modelo → `NO_PROVIDER_ENABLED` 503 con el mensaje localizado `run.rolesUnsatisfiable`, que nombra qué configurar. Durante un run, `files/content PUT`, `rebuild` y `recover` → `AGENT_RUNNING`. |
| `agent/status` | Del último run: `status` = proyección de `03 §2`; `startedAt` = `runs.started_at`; `realtimeConversation` = mensajes del run; `creditsSpent` = `runs.spent_usd`; `expectedMinutes` = mediana de las 20 últimas duraciones de la intención (por defecto `full` 8, `feature`/`refactor` 6, `infra` 5, `bugfix` 4, `tweak` 2, `question` 1; antes de clasificar: `full` en el primer prompt, `feature` después) y `expectedFinishAt`, solo mientras `init`. Un run sin worker y con heartbeat de más de 3 min se cierra aquí como `failed` con el mensaje `run.interrupted`. `agent/stop` → `{runId, status:"cancelling"}` (`cancelled` si aún estaba en cola); sin run → `NO_PROCESS_RUNNING` 409. |
| Proyecto | Todos los campos de `research/02 §4` + `internalDevelopmentUrl` (solo lo usa el servidor de la UI). `plan="self-hosted"`. |
| Ficheros | `files/tree` excluye `node_modules`, `.next`, `.git`, `dist`, `.forja`, `.totalum`, **`.env*`**. `files/content GET/PUT` sin sanitizar, `bytesWritten` exacto; `.env*` → `FORBIDDEN_PATH` 403; `PUT` durante run → `AGENT_RUNNING`; `baseCommitSha` opcional → `STALE_WRITE`. `source-code` → zip por `git archive` con URL firmada. `files/upload` multipart → `{url, fileNameId}` (URL pública firmada, §2.3). |
| Rebuild / deploy / dominio / versiones | `04 §5–7`. `gitDiffUrl` no se emite. |
| Logs | `04 §8`. |
| GitHub / Figma | Stubs hasta la fase 5: `github/status` → `{connected:false, tokenValid:false, tokenExpired:false}`, `github/pull-status` → `{status:null}`, `figma/status` → `{connected:false}`, `connect` → `NOT_IMPLEMENTED` 501. `github/env` → nombres con `***` salvo `ALLOW_ENV_EXPORT=true`. |
| Export/Import | zip del repo + `pg_dump` opcional → `importCode` firmado; import en proyecto vacío con `importInProgress` síncrono; 1/min. |
| `account` · `credit-costs` | `{credits:null, mode:"self-hosted", budgets}` · `{}`. |

### 2.2 Qué necesita cada endpoint (despertar o no)

| Necesita | Endpoints | Dormido → |
|---|---|---|
| Nada (git/engine) | `projects.*`, `files/tree`, `files/content GET`, `versions`, `version-diff`, `source-code`, `secrets`, `domain`, `github/*`, `figma/*`, logs prod, `deployments/status`, `account`, `webhooks` | responde |
| Sandbox | `agent/start`, `launch`, `files/content PUT`, `rebuild`, `restart`, `visual-edit`, `backend/dev/logs`, `versions/:id/recover`, `deploy` | despierta + `409 SERVER_NOT_READY` |
| DB | `database/*` | despierta solo la DB + `409 SERVER_NOT_READY` |

### 2.3 Superficie pública firmada (sin `api-key`)

Rutas con token HMAC (`FORJA_MASTER_KEY`, caducidad en el token, ligado a proyecto y
recurso), **servidas al navegador a través de la UI** para que nunca haya que exponer el
engine: el engine emite `${APP_URL}/api/files/<token>` y la UI tiene una ruta
`apps/web/src/app/api/files/[token]/route.ts` que reenvía al engine en streaming
(`/v1/public/<token>`) sin comprobar SSRF (origen fijo por configuración).

| Recurso | Uso | Caducidad |
|---|---|---|
| Subidas (`uploads`) | adjuntos del chat, campos de fichero del CMS, activos del editor visual | 30 días, renovable |
| `previewImageUrl` | galería | 7 días |
| `source-code` zip | descarga del código | 30 min |
| Export zip | `importCode` | 24 h |
| Captura estática (`cachedDevelopmentUrl`) | preview dormida | mientras esté archivado |

`visual-edit/apply` reconoce las URLs de su propio origen `/api/files/` y las descarga del
engine directamente; las demás URLs siguen pasando por la guardia SSRF sin excepciones.
`/v2/auth/preview` (forward-auth) también es pública: valida el token de la URL.

### 2.4 Mensajes que ve el usuario (por resultado del run)

Los textos salen de plantillas localizadas (`packages/contracts/src/messages/<lang>.ts`,
idioma = `projects.language`), **sin ids de tarea ni nombres de rol**.

| Momento | `author` | `messageType` | Contenido |
|---|---|---|---|
| `agent/start` | `user` | `regular` | el prompt, `files` |
| `directing` empieza | `agent` | `starting` | "Analizando tu petición…" |
| cada cambio de fase y cada tarea | `agent` | `building` | "Diseñando la identidad visual", "Creando la página de producto", "Comprobando 6 de 11 puertas" |
| `question` respondido | `agent` | `finished` | la respuesta del director; sin `versionId` |
| run `done` (verde) | `agent` | `finished` | mensaje del director, `versionId`, `secretKeysNeeded` (con `isProvided` calculado) |
| run `done` con puertas rojas | `agent` | `finished` | mensaje del director que enumera lo que falla; `versionId` |
| `limit-reached` | `agent` | `limit-reached` | qué quedó fuera y el coste |
| `failed` (error interno, sin proveedor…) | `agent` | `error` | causa en lenguaje llano |
| `cancelled` | `agent` | `error` | "Detenido por el usuario…" |
| publish éxito | (local en la UI) | — | la UI lo inyecta ella misma |

Emisión real en la fase 2 (`apps/engine/src/services/runs/`): `starting` al empezar;
`building` en cada cambio de fase (`phase.<estado>`), al empezar cada tarea y cada ronda de
arreglo (`task.<rol>`, sin título ni ids) y, en la primera ronda de verificación, uno por
puerta (`gates.progress`). El mensaje final se escribe **antes** del estado terminal. Con
puertas rojas, el director las enumera; si su mensaje falla se usa `run.finishedWithFailures`
con los nombres localizados de las puertas (`gate.*`). `versionId` = sha del commit de merge
(= `versions.id` = `_id` de `GET versions`). `secretKeysNeeded` = los `envNeeds` con
`required:true` de los informes, con `isProvided` calculado contra `secrets` (el supervisor
los aportará en la fase 3). Sin cambios de ficheros no hay versión (`run.nothingChanged`).

## 3. API v2

Prefijo `/v2`, misma clave, JSON plano. Además de lo listado antes: `POST
/v2/projects/:id/undelete`, `POST /v2/deployments/:id/rollback`, `GET /v2/projects/:id/preview/*`
(proxy interno para la UI, con `?target=verify`), `GET /v2/auth/preview` (público),
`GET /v2/projects/:id/budget` (página de presupuestos que la UI renderiza en
`/project/:id/budget` para el modal de créditos).

**Modelos** (contrato C3): `GET /v2/system/models` →
`{ providers: [{id, kind: "llm"|"image"|"stock", envName, status, adapterReady, models?}],
assignments: RoleAssignment[] }` (proveedores LLM del gateway con sus modelos; `IMAGE_*` y
`STOCK_*` desde el env, `adapterReady` solo para los `STOCK_*` que `packages/media` usa).
Nunca incluye una clave. Con una configuración LLM inválida o incompleta el engine sigue
arrancando y `assignments` muestra `model:null` con el `error` de cada rol.

**Ajustes de la instancia** (contrato C4, `@forja/contracts/media`), con la misma `api-key`:

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `GET /v2/system/settings` | — | `{ images: { mode, source, envDefault, generationAvailable } }` |
| `PUT /v2/system/settings` | `{ images: { mode: "web-search" \| "generate" } }` (estricto; otro campo → 400 `VALIDATION`) | igual que `GET` |
| `DELETE /v2/system/settings/images` | — | igual que `GET` (idempotente) |

`mode` es la estrategia vigente; `source` dice si viene de la UI (`ui`) o de
`IMAGES_FROM_WEB_SEARCH` (`env`); `envDefault` es lo que da el `.env` (para ofrecer "Reset to
.env"); `generationAvailable` es falso si ningún generador `IMAGE_*` puede ejecutarse (entonces
se busca en la web igualmente, `02 §7`). El override se guarda en la tabla `settings` (clave
`images.mode`); un valor guardado inválido se ignora. La UI los consume por
`apps/web/src/app/api/engine/settings/route.ts` (y `…/engine/models/route.ts` para
`GET /v2/system/models`), que añaden la clave del engine en el servidor y copian solo los
campos documentados.

**Streaming:** `GET /v2/runs/:id/events?after=<seq>` (SSE). La UI no lo pasa por el
catch-all (que exige JSON): tiene una ruta dedicada `apps/web/src/app/api/runs/[id]/events/route.ts`
que reenvía el stream. Los deltas de texto (`text`, `reasoning`) se emiten solo en vivo
(pub/sub en memoria, o Redis Streams si `ENGINE_INSTANCES>1`); lo persistido es el texto
final de cada turno. Replay = eventos persistidos + estado actual.

## 4. Catálogo de eventos (`run_events.type`)

```
run.received · run.phase{from,to} · run.finished{status,summary,cost}
plan.created · plan.rejected{reason} · plan.approved
task.started · task.turn{n} · task.finished{report,cost} · task.failed{error} · task.retried · task.checkpoint
text{taskId,role,text}            (final por turno; los deltas son efímeros)
tool.call{taskId,name,argsSummary,blob?} · tool.result{taskId,name,ok,summary,durationMs,blob?}
file.diff{taskId,path,stat,blob} · command.output{taskId,cmd,exitCode,tail,blob?}
scope.violation{taskId,path}
integration.report · rework.requested{from,to,reason}
gate.started{name} · gate.passed{name} · gate.failed{name,parsed[],routedTo}
review.finding{severity,file,line,title} · review.summary
screenshot{path,page,width} · design.review{page,verdict,notes}   (evento; la herramienta es submit_design_review)
cost.tick · budget.warning · budget.exhausted
context.compacted · context.rebuilt
sandbox.status · deploy.status · domain.status
message{author,type,text}
system.pressure{disk,memory}
```

`tool.call` guarda un resumen de argumentos (nombre, ruta, tamaño); el contenido completo
va a `blob_path` con retención. `file.diff` guarda el `stat` y el parche en blob.

Fase 2 emite: `run.received`, `run.phase`, `run.finished`, `plan.created`,
`plan.rejected`, `plan.approved`, `task.started`, `task.turn`, `task.finished`,
`task.failed`, `task.retried`, `text`, `tool.call`, `tool.result`, `command.output`,
`scope.violation`, `gate.started`, `gate.passed`, `gate.failed`, `cost.tick`,
`budget.warning`, `budget.exhausted`, `context.compacted` y `message`. Un payload de más de
8 KB se escribe en `DATA_DIR/projects/<id>/runs/<runId>/blobs/` y la fila guarda
`blob_path`. `file.diff` (el diff queda en el commit de cada tarea) llega en la fase 3.
Cada llamada al modelo deja una fila en `llm_calls` (también las fallidas, `outcome:
"error"`); cada petición de `packages/media`, una en `media_calls`.

## 5. Webhooks

Como antes: eventos `run.finished`, `run.failed`, `deploy.succeeded`, `deploy.failed`,
`domain.active`, `budget.warning`, `budget.exhausted`, `version.created`; firma
`X-Forja-Signature: t=<ts>,v1=<hmac>`; reintentos 1, 5, 25, 125, 625 s; alias
`agent.prompt.finished`.

## 6. CMS de base de datos: del DSL de la UI a SQL

### 6.1 Convenciones que la plantilla garantiza (y `database.md` exige)
- PK `id` de tipo `text` (UUID v7) en toda tabla de negocio; `created_at`, `updated_at`
  `timestamptz` en toda tabla.
- Tablas puente `<a>_<b>` con exactamente dos FKs y PK compuesta.
- Campos de fichero: columna `jsonb` cuyo nombre termina en `_file` o `_image`, con la forma
  `{name, url?}` (o array para múltiples). La app los sirve mediante el `storage` port.
- Enums cerrados como enums de Postgres.
- Tablas internas (BetterAuth salvo `user`, `drizzle.*`) no se exponen.

### 6.2 Introspección (`tables-structure`)
Tipos: `text/varchar` → `string` (o `long-string` si `text` sin `CHECK` de longitud);
`int/numeric` → `number`; `boolean`; `timestamp[tz]` → `date` con `includeHour`; `date` →
`date`; enum → `options` (valores del tipo); `jsonb` `*_file`/`*_image` → `file`; otro
`jsonb` → `object`; FK → `objectReference` `manyToOne` (`objectReferenceTypeId` = tabla
destino); puente → `manyToMany` en ambas con el **mismo `DbProperty.id`**; FK entrante →
`oneToMany`. `label` humanizado del nombre. Cada `type` = nombre de tabla; `_id` = PK.

### 6.3 Compilador `queryOptions → SQL` (Kysely, parametrizado)
- `_sort`: si la columna existe; si no, `created_at`; si tampoco, la PK. Nunca error.
- `_filter` por tipo de columna: texto → `regex` `~*`, `contains`/`startsWith`/`endsWith`
  → `ILIKE` con escape de `%`, `_`, `\`; numérico/fecha → comparadores con cast validado (un
  valor no parseable → filtro `FALSE`, no error); `{in:[null,""]}` sobre no-texto → `IS NULL`;
  `{nin:[null,""]}` → `IS NOT NULL`; `_or` → `OR`; relación `{_has:"some", _filter}` → `EXISTS`.
- `_count:true` → `COUNT(*) OVER()` expuesto como `results[0]._count._total`.
- Expansión: clave por nombre de propiedad → `row_to_json` (to-one) o `json_agg` con
  `LIMIT` (to-many, máx 300). Expansión desconocida → se ignora (la UI reintenta sin ella
  de todos modos).
- Límites: 1000 filas, `statement_timeout=10s`, rol `cms_ro`.
- `records`: `INSERT … RETURNING`, `UPDATE`, `DELETE` por PK con rol `cms_rw`; `link`/
  `unlink` reciben en `propertyId` el **nombre** de la propiedad (así lo envía la UI) y lo
  resuelven a la tabla puente.
- Ficheros: `{name}` = `fileNameId` de `uploads`; lectura añade `url` pública firmada.
  El `storage` port de la app generada sabe leer el mismo `{name}` desde su propio volumen
  o bucket en producción (`06 §3`), así la app **no depende del engine**.
- `snake_case` ↔ `camelCase` en la capa CMS.

## 7. MCP

`GET|POST /v2/mcp`: `forja_projects_list/get/create`, `forja_run_start/status/stop`,
`forja_files_read/write/tree`, `forja_db_query`, `forja_deploy`, `forja_versions_list/restore`,
`forja_logs_tail`. Fase 5.
