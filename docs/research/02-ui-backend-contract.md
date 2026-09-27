# Investigación 2: contrato que la UI de Forja espera del backend

Auditoría de solo lectura del árbol de trabajo el 2026-09-25. Los números de línea son de ese
día. Todo bajo `src/`. Este contrato es lo que un backend propio debe cumplir para que la UI
actual siga funcionando sin reescribirla (capa de compatibilidad, ver `docs/architecture/`).

## 0. El reemplazo mínimo

- El navegador solo llama a `/api/*` del propio origen. El servidor Next reenvía a
  `VCAAS_BASE_URL = "https://api-accounts.totalum.app/api/v1/vcaas"` (`lib/vcaas-server.ts:16`)
  y añade `api-key` (`:113-115`, `:144`). `resolveVcaasUrl` (`:49-67`) solo acepta rutas bajo
  ese pathname.
- **Cambio más barato:** implementar el formato de cable de Totalum en otro origen y cambiar
  esa constante y la cabecera. Las dos piezas son el envelope `{errors, data}` (§2) y las
  rutas de §1.
- **Supuestos Totalum hardcodeados que también hay que cambiar o satisfacer:**
  - allowlist de hosts de `git-diff` (`app/api/vcaas/git-diff/route.ts:19-24`);
  - fallback de host publicado `${projectId}.totalum-project.com` (`lib/project-status.ts:350`,
    `app/project/[projectId]/page.tsx:568`);
  - marcadores de página placeholder (`lib/preview-health.ts:67-73`);
  - guardia SSRF (`lib/safe-url.ts`), que rechaza IPs privadas para URLs de parches y de
    activos subidos (§8).

## 1. Endpoints que llama la UI

Notación: `P` = `/projects/{projectId}`. Ruta cliente = `/api/vcaas` + ruta upstream. El
catch-all reenvía método, ruta, query y cuerpo sin tocar (`app/api/vcaas/[...path]/route.ts:33-55`).
Constructores en `lib/vcaas.ts`, tipos en `lib/vcaas-types.ts`.

### 1.1 Proyectos

| Fn (vcaas.ts) | Método + ruta | Petición | `data` | Uso / cadencia |
|---|---|---|---|---|
| `projects.list` :220-270 | GET `/projects` | `limit, skip, search, sortDirection, sortField("lastModified"), groupId, createdFrom, createdTo`. **La home no envía nada** (`app/page.tsx:332`). Duplicar envía `limit=100` | `VcaasProjectSummary[]` (types:121-155) | Galería, una vez. Orden, búsqueda y paginación (20) en cliente. **El backend debe devolver todos los proyectos sin `limit`.** |
| `projects.get` :273 | GET `P` | – | `VcaasProject` (§4) | Carga del workspace, tras cada run/publish/operación, recheck de pestaña, wake (5 s), watcher (8 s), modal Dominio (20 s), y resolución de origen del proxy de preview (servidor) |
| `projects.create` :282-288 | POST `/projects` | `{projectId, description, label?, groupId?}` | `VcaasProject`; solo se lee `data.projectId`, **que puede diferir del pedido** | Hero con adjuntos; import/clon |
| `projects.launch` :315-329 | POST `/projects/launch` | La UI envía solo `projectId, prompt, description(≤200), figma?` (`page.tsx:443-448`) | `ProjectLaunchResult` (types:549-559): `{projectId, requestedProjectId?, agent:{started, status?, message?}, warnings?:{step?, message?, endpoint?}[]}` | Hero sin adjuntos. Si `agent.started` es false, la UI guarda el prompt y lo manda el workspace vía `agent/start`. Fallo Figma = `warnings[].step === "figma"` |
| `projects.update` :343-347 | PATCH `P` | `{label?, description?, groupId?}` | – | **Sin uso** |
| `projects.remove` :350 | DELETE `P` | – | – | Borrar en home (`page.tsx:572`) |
| `projects.exportProject` :365-369 | POST `P/export` | `{includeRecords}` | `{importCode, includeRecords, message?}` | Exportar y Duplicar |
| `projects.importProject` :381-385 | POST `P/import` | `{importCode}` | `{projectId, status, message?}` | Import/Duplicar; después la UI escribe el slot `import` y depende de `project.importInProgress` |

### 1.2 Agente

| Fn | Método + ruta | Petición | `data` | Uso / cadencia |
|---|---|---|---|---|
| `agent.status` :392 | GET `P/agent/status` | – | `AgentStatus` (types:289-299): `{projectId, status:"init"\|"done"\|"idle", startedAt, realtimeConversation[], creditsSpent?, expectedMinutes?, expectedFinishAt?}` | Poll cada **10 s** (`page.tsx:536`), o **3 s** hasta 3 veces mientras espera ver `init` (`:525-528`). Para en `done`/`idle` |
| `agent.fullConversation` :411-422 | GET `P/agent/full-conversation` | sin query (`page.tsx:463`) | `{conversation[], totalCount?, hasMore?}` | Carga, tras cada run y tras publicar |
| `agent.start` :425-435 | POST `P/agent/start` | `{prompt, inputFiles[], model?, effort?, fastMode?}` | solo se lee `ok` | Envío del composer (`page.tsx:660`). Con `ok`, la UI pone `agentProcessStatus:"init"` local y empieza el poll |
| `agent.stop` :438 | POST `P/agent/stop` | `{}` | – | Botón Stop (`page.tsx:1143`) |
| `agent.restartServer` :442 | POST `P/agent/server/start-or-restart` | `{}` | – | Reinicio manual (`:1191-1203`) y auto-wake (`:760`) |

### 1.3 Despliegues

- GET `P/deployments/status` → `{status: "deploying"|"success"|"error"|null, createdAt?}`.
  Poll cada **10 s sin tope** hasta `success`/`error` (`page.tsx:550-581`). Empieza justo tras
  `deploy`, y al cargar si `project.deployment.status==="deploying"`.
- POST `P/deployments/deploy` `{}` (`handleDeploy`, `page.tsx:1155-1190`).

### 1.4 GitHub (`vcaas.ts:476-500`)

- GET `P/github/status` → `{connected, tokenValid, tokenExpired, repositoryFullName?, developBranch?, productionBranch?}`. Al cargar.
- GET `P/github/pull-status` → `{status:"pulling"|"success"|"error"|null, createdAt?}` (watcher 8 s).
- POST `P/github/connect` `{token, repositoryFullName, syncDirection}` → `{connected, repositoryFullName, syncAction, repoHasContent, requiresRebuild}`; solo se lee `ok`.
- DELETE `P/github/connect`. POST `P/github/pull` `{}` → `{status:"pulling"|"no_changes", message, filesUpdated}`. GET `P/github/env` → `{envDev, envProd}`.

### 1.5 Figma (`vcaas.ts:516-547`)

- GET `P/figma/status[?verify=true]` → `{connected, account?, connectedAt?, tokenValid?, tokenError?}`.
- POST/DELETE `P/figma/connect` `{token}`. POST `/figma/validate` `{token}` → `{valid, account?}` (hero).

### 1.6 Base de datos (detalle en §6)

- GET `P/database/tables-structure` → `{tables}`; POST `P/database/query` `{tableName, queryOptions}` → `{results}`;
  POST `P/database/records` → registro con `_id`; PATCH `…/records/{id}`; DELETE `…/records/{id}?tableName=`;
  POST/DELETE `…/records/{id}/link` `{tableName, propertyId, referenceId}` (DELETE **con cuerpo JSON**).

### 1.7 Secretos, dominio, versiones

- POST `P/secrets` `{secretName, secretValue, environment:"development"|"production"|"both"}`; DELETE `P/secrets/{_id}`.
- PUT `P/domain` `{hostname}`; DELETE `P/domain`. Resultado ignorado; la UI relee `projects.get().customDomain`.
- GET `P/versions?limit&skip` → `{versions[], totalCount}` (página 10; DiffViewer pagina hasta 200 para mapear versionId→commitSha).
- POST `P/versions/{id}/recover` `{}`. GET `P/version-diff?commitSha=` → `{commitSha, diff}`; la UI trata `NO_DIFF_CONTENT`, `NO_ACTIVE_SANDBOX` y `SERVER_NOT_READY`.

### 1.8 Ficheros, rebuild, logs

- GET `P/files/tree?path&limit&offset` → `{entries[{path,name,type,size?,depth}], totalEntries, offset, limit, hasMore, commitSha, filesCount}`. La UI pide `limit=5000`.
- GET `P/files/content?path=` → `{path,name,size,encoding,content,commitSha}` (solo servidor, visual-edit).
- PUT `P/files/content` `{path, content:<base64>, encoding:"base64"}` → `{path, bytesWritten, created, commitSha?, filesCount?, rebuildRequired}`.
- POST `P/rebuild` `{}` → `{status, startedAt}`. GET `P/rebuild/status` → `{status:"idle"|"rebuilding"|"success"|"error", errorMessage?}`. Poll 8 s ×40 (CodePanel), 8 s (watcher), 6 s (visual-edit).
- GET `P/backend/dev/logs` → `{logs: string}`. GET `P/backend/prod/logs?getOnlyLastLogs&from&to&regexSearch` → forma Cloudflare, cada campo opcional; normalizado por `lib/logs.ts:98-113`.

### 1.9 Sin uso por la UI

`projectGroups.*`, `webhooks.*`, `projects.update`, `files.content` (solo servidor).

### 1.10 Rutas dedicadas

- **Upload:** `POST /api/vcaas/upload/{id}` → upstream `POST P/files/upload`, multipart campo `file`. `data` debe ser `{url, fileNameId}`. Reintento 3× a 1,5 s salvo `retryable:false`. 8 MB comprobados en navegador. **Bug:** `db/FileField.tsx:186-190` envía JSON `{url}` a una ruta solo multipart.
- **Código fuente:** `GET /api/vcaas/source-code/{id}` → upstream `{filesCount?, lastCommitSha?, downloadUrl}`; el servidor descarga con `redirect:"error"`, 60 s, y devuelve zip con `x-files-count` y `x-commit-sha`. Acepta zip, tar.gz o tar.
- **Git diff:** `GET /api/vcaas/git-diff?url=` → `{ok, data:{diff}}`; https en hosts permitidos, SSRF, sin redirecciones, 20 s, 10 MB.
- **Config:** `GET /api/config` → `{ok:true, data:{configured}}`.

## 2. Envelope y códigos de error

Formato upstream esperado por el catch-all (`[...path]/route.ts:11-26,57-78`):

```ts
{ errors: { errorCode: string; errorMessage: string; errorDetails?: {...} } | null, data: unknown }
```

- Cuerpo siempre JSON; si no, 500 `UNKNOWN`. `errors === null` → HTTP 200 `{ok:true, data}`
  sea cual sea el estado upstream. Cabeceras upstream descartadas (`meta` nunca se rellena).
- Envelope de fallo (`vcaas-errors.ts:247-271`): `{ok:false, error, code, upstreamCode, details, data:null}`.
- Unión `VcaasErrorCode`: `INSUFFICIENT_CREDITS | PLAN_REQUIRED | PROJECT_LIMIT_REACHED | PROJECT_NOT_FOUND | RATE_LIMITED | VALIDATION | UPLOAD_QUOTA_EXCEEDED | UNKNOWN`.
  Mapeo: `INSUFFICIENT_CREDITS` ← `INSUFFICIENT_CREDITS, VCAAS_INSUFFICIENT_CREDITS, PROJECT_CREDIT_LIMIT_REACHED, PROJECT_EXPORT_LIMIT_REACHED, PROJECT_IMPORT_LIMIT_REACHED`, HTTP 402;
  `PROJECT_LIMIT_REACHED` ← `MAX_PROJECTS_REACHED`; `PLAN_REQUIRED` ← `PLAN_*`, `FREE_PLAN_*`, `PAID_PLAN_REQUIRED`;
  `PROJECT_NOT_FOUND` ← `PROJECT_NOT_FOUND, MISSING_PROJECT_ID, TABLE_NOT_FOUND, WEBHOOK_NOT_FOUND, NO_DEPLOYMENT`, HTTP 404 (**también "no es tuyo"**);
  `RATE_LIMITED` ← `RATE_LIMIT_EXCEEDED, TOO_MANY_PROMPTS`, 429; `VALIDATION` ← `MISSING_*`, `INVALID_*`, `PROJECT_ALREADY_EXISTS`, `PROMPT_SECURITY_VIOLATION`, `RESERVED_PROJECT_NAME`, 400/422.
- Códigos upstream que la UI lee directamente: `SERVER_NOT_READY` (409, llega como `code:"UNKNOWN"`, se compara `upstreamCode ?? code`, `use-server-wake.ts:47,264`), `SANDBOX_NOT_REACHABLE` (con `details.reason: "starting"|"app_error"`, abre `ServerBlockedDialog`), `NO_DIFF_CONTENT`, `NO_ACTIVE_SANDBOX`, y las claves de copy de transferencia (`lib/project-transfer.ts:141-170`).
- **Dos comportamientos especiales:** `INSUFFICIENT_CREDITS` dispara el evento `totalum:insufficient-credits` (`vcaas.ts:130-145`); `SERVER_NOT_READY` arranca el wake (stamp en localStorage, poll 5 s, fin cuando `Active` y no cacheado, o **4 min** de estimación; los 10 min son solo para descartar stamps viejos).

## 3. Enumeraciones y máquinas de estado

- Run: `"init" | "done" | "idle"`. **No existe `error`**; el fallo va en la conversación como `messageType:"error"` o `"limit-reached"`.
- Servidor: `"Active" | "Creating" | "Starting" | "Archived" | "Unarchiving" | "Archiving"`.
- Deploy: `"deploying" | "success" | "error"`, `null` si nunca. Rebuild: `"idle" | "rebuilding" | "success" | "error"`. Pull: `"pulling" | "success" | "error" | null`.
- `versionRecovery {status:"recovering"|"error", versionId, startedAt, errorMessage?} | null`. `importInProgress {startedAt, errorMessage?} | null`.
- Dominio: `status` `pending_validation | pending_deployment | active | blocked | pending_deletion`; `sslStatus` `initializing | authorizing | issuing | active | expired | timing_out | validation_timed_out`.
- Operaciones: `publish 15 min | rebuild 10 | githubPull 10 | restartServer 8 | restoreVersion 10 | import 30`, persistidas en `localStorage["totalum:project-op:<id>"]`.

Predicados derivados (`page.tsx`): `getPreviewUrlFromProject` = `proj[developmentUrlFieldToUse || "temporalDevelopmentProjectUrl"]`;
`hasNoLiveServer` = `Archived || (!agentServerStatus && isCachedPreview)`; `liveReady` = `Active && campo === "temporalDevelopmentProjectUrl" && !!url` (abre el editor visual);
`isBuilding` = `agentProcessStatus === "init"`; `isFirstBuild` = `isBuilding && !messages.some(m => m.messageType === "finished")`;
`isPublished` = `deployment.status === "success"`; URL de producción = `customDomain.hostname || productionProjectUrl` (hostname pelado); fallback `${projectId}.totalum-project.com`.

**Transiciones que el polling exige:**

1. **Run.** Tras `agent/start` ok, poll inmediato; `done`/`idle` se re-consulta 3 s después, máximo 3 veces → **poner `init` de forma síncrona antes de responder**. Mientras `init`, `startedAt` y `expectedMinutes` alimentan la barra; los mensajes de `realtimeConversation` se deduplican por `${createdAt}|${message.slice(0,60)}` → **`createdAt` estable por mensaje**. En `done`/`idle` se relee proyecto y conversación completa (reemplaza la lista) y se remonta la preview.
2. **Deploy.** Poll inmediato sin tope → **el estado debe pasar a `deploying` antes de responder al deploy**. En `success`/`error`, `waitForPreview` sondea `/api/preview/{id}/` cada 3 s ×40 hasta que no sea placeholder; luego inyecta el mensaje local "🚀 Your app is now live at …" con `messageType:"finished"`.
3. **Watcher de operaciones** (8 s, 60 intentos, salta `publish`). `restartServer`: fin cuando `agentServerStatus === "Active"` → **salir de `Active` de forma síncrona al reiniciar**. `rebuild`: `success`/`error`; 3× `idle` = fin silencioso → **`rebuilding` síncrono**. `githubPull`: `status !== "pulling"` incl. `null` → **`pulling` síncrono**. `import`: `importInProgress` hasta que se limpia, luego `Active` + página no placeholder o 90 s. `restoreVersion`: fin cuando `versionRecovery` es null o `error` → **ponerlo síncrono**. Adopción al cargar: `rebuilding` sin op local → adopta `rebuild`; `importInProgress` → adopta `import`; `versionRecovery` no se adopta.
4. **Rebuild del editor visual.** 6 s, tope 10 min, 3× `idle` = `REBUILD_NOT_FOUND`; en `success`, HEAD al proxy 3 s ×10 o `REBUILD_OK_APP_DOWN`.
5. **Auto-wake.** Una vez por montaje si: cargado, clic fuera de `[data-workspace-header]`, sin operación ni `init`, `hasNoLiveServer`, y ≥1 mensaje de usuario.
6. **Pestaña obsoleta.** En focus/blur/pointerdown/visibility relee si la última lectura tiene >5 min y nada activo.

## 4. Objeto proyecto (`VcaasProject`, types:14-99)

Campos leídos: `projectId`, `label?`, `description`, `agentProcessStatus?`, `agentServerStatus?`,
`deployment? {status, createdAt, versionId?}|null`, `versionRecovery?`, `importInProgress?`,
`secrets {_id, secretName, environment}[]`, `customDomain? {hostname, status, sslStatus, dnsRecordsToAdd?[{type,name,value}], createdAt?, updatedAt?}|null`,
`temporalDevelopmentProjectUrl?` (URL absoluta), `cachedDevelopmentUrl?`, `developmentUrlFieldToUse?` (nombre de campo),
`productionProjectUrl?` (hostname sin esquema), `createdAt`. Sin uso: `plan`, `groupId`, `totalCreditsSpent`, `previewImageUrl` en detalle.

`VcaasProjectSummary` (lista): `{projectId, description, label?, groupId?, plan, createdAt, lastModifiedAt?, previewImageUrl?}`; la home lee `projectId, label, description, createdAt, previewImageUrl`.

Slug: crear `/^[a-z]([a-z0-9]|-(?!-))*(?<!-)$/`, 4–35, sin `-dev-` (`lib/project-slug.ts:24-55`); rutear ≤63.

## 5. Modelo de conversación

```ts
ConversationMessage {
  author: "user" | "agent";
  message: string;               // markdown ligero: **bold**, [text](url), `code`
  messageType: "regular" | "starting" | "building" | "finished" | "error" | "limit-reached";
  createdAt: string;             // ISO; clave de dedupe con message[0..60]
  versionId?: string;            // en el mensaje final; puente a versions/diff
  secretKeysNeeded?: Record<string, { isProvided: boolean; description: string }>;
  gitDiffUrl?: string;           // en el mensaje final; https en host permitido
  files?: { name; url; imageDescription }[];   // adjuntos del usuario persistidos
}
```

Render (`ChatPanel.tsx:93-120`): un mensaje del agente `starting`/`building` abre un grupo de
build que absorbe los siguientes hasta `finished`/`error`/`limit-reached` (finishMsg) o un
mensaje de usuario; `building` = pasos colapsables con el último en vivo; `starting` =
spinner. finishMsg: `secretKeysNeeded` → formulario inline que hace `secrets.create`;
`gitDiffUrl` → DiffViewer. Sin streaming: poll de `realtimeConversation` y reemplazo total al
terminar. `isFirstBuild` depende de que exista un `finished`. No hay tipo de evento de
herramienta: el progreso son mensajes `building`.

## 6. Contrato del CMS de base de datos

- `tables-structure` → `{tables: DbTable[]}`. `DbTable {_id, type, label, description, icon, properties: Record<string, DbProperty>}`.
  `DbProperty {id, name, propertyType, label, description?, objectReference?:{objectReferenceTypeId?, objectReferenceRelation?:"manyToMany"|"oneToMany"|"manyToOne"|"oneToOne"}|null, typeExtras?, showInTree?}`.
  `propertyType`: `string | number | date | long-string | options | file | objectReference | boolean` (+ `array`/`object` → editor JSON).
  `typeExtras`: `date.includeHour`, `file.multiple`, `optionsConfig.multiple`, `options: {id,value,color?}[]`, `string.type`, `long-string.type`.
  **Ambos lados de una relación comparten el mismo `DbProperty.id`** (`inverseLinkPropertyOf`, `totalum-schema.ts:266-288`).
- `query` con `queryOptions` (`totalum-query.ts:163-224`): `_limit` (25/50/100), `_offset`, `_sort:{[f]:"asc"|"desc"}` (por defecto `createdAt`), `_count:true` → total en `results[0]._count._total`.
  `_filter` = mapa AND; valor pelado = eq; operadores `ne|gt|gte|lt|lte|contains|startsWith|endsWith`, `{regex, options:"i"}`, `{in}`, `{nin}`; vacíos `{in:[null,""]}`; OR = `_or:[...]`; búsqueda = `_or` de regex sobre campos string; filtro por relación `{<link>: {_has:"some", _filter}}` (`join-filter.ts`).
  Expansión: clave top-level por nombre de propiedad, `true` (to-one) o `{_limit:5}` (to-many); si se rechaza, la UI reintenta sin ella.
- Filas: `_id` (24 hex), campos de sistema `createdAt, updatedAt, createdBy, lastUpdatedBy, metadata`. Enlace to-one = id o `{_id,...}` expandido; to-many = array.
- Crear/actualizar `{tableName, data}`: vacíos omitidos; coerción de números, booleanos, fechas ISO y JSON; manyToOne/oneToOne → id|null; oneToMany no se escribe; manyToMany solo por link/unlink tras guardar. La respuesta de crear incluye `_id`.
- Link/unlink `{tableName, propertyId, referenceId}`: **la UI envía el `name` de la propiedad como `propertyId`** (`DatabasePanel.tsx:2012-2029`).
- Campos fichero: lectura `{name, url?, type?}`; escritura `{name}` = `fileNameId` de upload.

## 7. Otros contratos

- Código: archivo fuente (§1.10); guardar = `files.write` base64 → `rebuildNeeded`; rebuild manual; barra de direcciones deriva páginas del App Router de `files.tree`.
- Versiones: `{_id, name, commitSha?, commitMessage?, prompt?, createdAt}`; recuperar por `_id`; diff por `gitDiffUrl` o `version-diff?commitSha`.
- Secretos: valores de solo escritura. Dominio: progreso derivado de `status + sslStatus + createdAt`; tabla DNS de `dnsRecordsToAdd`.

## 8. Proxy de preview y aplicación del editor visual

### 8.1 Proxy `/api/preview/{id}/[[...path]]`

- Resuelve el origen en servidor con `GET P` → `getPreviewUrl` → `origin`; caché 15 s por `accountUserId:projectId`.
  → **El backend debe devolver una URL de dev alcanzable desde el servidor Next** en `temporalDevelopmentProjectUrl`.
- Reenvía a `${origin}/${path}?${search}` quitando `host, cookie, origin, referer`; `accept-encoding: identity`; `redirect:"manual"`; descarta redirecciones cross-origin; elimina `set-cookie`, CSP, XFO, HSTS, content-encoding y content-length.
- Reescribe HTML (rutas absolutas y `/_next/`) e inyecta el `<script>` del agente en `<head>`; reescribe `url(/…)` en CSS. Sirve el editor en `__totalum-visual-editor.js` (**local a este repo**; el backend no aporta nada). El shim asume Next.js.
- También es sonda de salud: `waitForPreview` tras publicar, `appIsServing` del import, HEAD tras rebuild visual.
- Placeholder detectado si <4000 chars, sin `<script>` y ≥2 marcadores de `preview-health.ts:67-73`. → **Una página "no listo" propia debe devolver no-2xx o coincidir con los marcadores.**

### 8.2 `POST /api/visual-edit/{id}/apply` `{changes: VisualChange[]}` (≤100)

El backend debe ofrecer: (1) `files/tree?limit=5000`; (2) `files/content` con `encoding:"utf8"`; (3) `PUT files/content` base64 con `bytesWritten` igual a la longitud UTF-8 decodificada, y un canario por proceso que escribe `.totalum/visual-edit-write-check.txt` con `<div id="c" className="a b">x</div> <ts>` y exige lectura **byte a byte idéntica** (`WRITE_NOT_FAITHFUL` si no); (4) `POST rebuild` + `rebuild/status`; (5) los activos subidos los descarga el servidor Next con guardia SSRF (solo DNS público, sin redirecciones, 20 s, `image/*`/`video/*`, ≤12 MB) y los escribe en `public/uploads/<hash>.<ext>` → **el almacenamiento propio debe ser resoluble públicamente o hay que cambiar la guardia**; (6) opcionalmente instala `scripts/totalum-source-tags.js` y parchea `next.config` si tiene la forma `webpack: (config, { dev }) => {` → **la plantilla generada debería incluir ese loader** (`data-tlm-loc="file:line:col"`).

Respuesta: `applied[]`, `unmapped`, `filesWritten`, `writeFailures`, `rebuildStarted`, `rebuildCode`, `billing`, `filesTruncated`, `unsafeWrites`, `assetsCopied`, `assetFailures`, `sourceTagInstall`, `engine`. Fallos: `NO_CHANGES`, `VALIDATION_ERROR`, `TREE_UNAVAILABLE`, `NO_SOURCE_FILES`, `READ_FAILED`, `UNSAFE_WRITE` (409), `WRITE_NOT_FAITHFUL` (503), `WRITE_FAILED` (502).

## 9. Prescindible vs indispensable

**Prescindible al autoalojar:** créditos y planes (códigos, modal, `creditLimits`, `creditsSpent`, `billing`); export/import/duplicar (si se mantiene, implementar `importInProgress`); grupos, webhooks, `projects.update`; GitHub, Figma, dominio y logs prod son modales aislados (stub `{connected:false}`, `customDomain:null`); captura cacheada y dormir/despertar (nunca devolver `Archived` ni `SERVER_NOT_READY` y el wake queda inactivo); `versionRecovery` solo si hay restaurar; `expectedMinutes`; `previewImageUrl`; `launch` (sustituible por create + start si se devuelve `agent.started`).

**Indispensable:**
1. `GET /projects` (todos) → `{projectId, label?, description, createdAt, previewImageUrl?}[]`.
2. `POST /projects` o `/projects/launch`; el `projectId` devuelto es la autoridad.
3. `GET /projects/:id` con `projectId, label?, agentProcessStatus, agentServerStatus ("Active")`, `temporalDevelopmentProjectUrl` (absoluta, alcanzable desde iframe y servidor), `secrets: []`, `deployment`, `customDomain: null`.
4. `agent/status` con la semántica de §3 (`init` síncrono, `createdAt` estable), `agent/start`, `agent/stop`.
5. `agent/full-conversation` con disciplina `starting → building* → finished|error|limit-reached`; hace falta ≥1 `finished` para salir de `isFirstBuild`.
6. `files/upload` multipart → `{url, fileNameId}`.
7. Envelope `{errors, data}` y JSON en toda respuesta.
8. Para Código/Editor visual: `files/tree`, `files/content` GET/PUT base64 fiel, `rebuild` + `rebuild/status` (`rebuilding` síncrono), `source-code` → `{downloadUrl, filesCount, lastCommitSha}`.
9. Para Base de datos: `tables-structure` + `query` con el DSL, CRUD y link/unlink.

**Constantes Totalum a editar:** `VCAAS_BASE_URL` y `api-key` (`lib/vcaas-server.ts:16,113-115,144`); allowlist de git-diff; fallbacks `*.totalum-project.com` (`project-status.ts:350`, `page.tsx:568`); marcadores placeholder (`preview-health.ts:67-73`); `PROJECT_SLUG_REGEX` y la reserva `-dev-`.

**Bugs preexistentes:** `FileField` "adjuntar desde URL" roto; tope real del wake 4 min (AGENTS.md dice 10); dos definiciones distintas de `isCachedPreview`; `restoreVersion` no se adopta tras recargar; `windowConversation` referenciado pero no implementado.
