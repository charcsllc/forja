# 04 · Sandbox, preview y publicación

## 1. Anatomía del sandbox de un proyecto

Rutas: `DATA_DIR` es la ruta **dentro del engine**; `DATA_DIR_HOST` es la misma carpeta vista
por el daemon de Docker (los bind mounts de `dockerode` usan rutas de host). El engine
comprueba al arrancar que ambas apuntan al mismo directorio (escribe un nonce y lo lee vía
un contenedor efímero) y se niega a arrancar si no.

```
/data/projects/<id>/
├── repo.git/            # repositorio bare (fuente de verdad)
├── work/                # checkout de main  → montado en forja-app-<id>:/workspace   (lo que ve el usuario)
├── run/                 # checkout de run/<runId> → montado en forja-verify-<id>:/workspace (agentes y puertas)
├── home/                # $HOME de node en ambos contenedores (npm cache, playwright no)
├── uploads/ · snapshot/ · backups/ · runs/<runId>/logs/
```

| Recurso | Nombre | Detalle |
|---|---|---|
| Red compartida | `forja-apps` (bridge `fj-apps`) | Traefik, engine, **todos** los contenedores de app y verificación. Nunca `web`. |
| Red de plataforma | `forja-core` (bridge `fj-core`) | web, engine, postgres. |
| Red del socket Docker | `forja-docker` (bridge `fj-docker`, interna) | Solo el socket proxy, el engine y Traefik. El proxy admite `POST` (el engine crea contenedores), por eso no vive en `forja-core`. |
| Red interna por proyecto | `forja-int-<id>` (bridge `fj-i-<hash>`) | `internal: true`. App, verify y DB del proyecto. Se elimina al archivar. Los nombres de bridge llevan prefijo fijo para que las reglas de firewall los reconozcan. |
| Volumen DB | `forja-pgdata-<id>` | Postgres. |
| Contenedor DB | `forja-db-<id>` | `postgres:17-alpine`; bases `app` (dev), `verify_<runId>` (por run, se borra al terminar) y roles `app_rw`, `cms_ro`, `cms_rw` creados en la provisión. Sin puertos publicados. |
| Contenedor app (dev) | `forja-app-<id>` | Imagen `forja-runner`; `npm run dev` (= `next dev --webpack`, ver §5) en `:3000` sobre `work/`; labels de Traefik. |
| Contenedor verify (por run) | `forja-verify-<id>` | Misma imagen; `next dev --webpack` sobre `run/` en `:3000` **sin** labels de Traefik; solo el engine y el sidecar de navegador lo alcanzan. Existe mientras hay run. |
| Contenedor check (efímero) | `forja-check-<id>-<runId>` | Imagen construida con el `Dockerfile` del proyecto para la puerta 6; se destruye tras la puerta. |
| Contenedor prod | `forja-prod-<id>-v<N>` | Imagen `forja/<id>:v<N>`; §7. |
| Sidecar de navegador | `forja-browser` (uno por instancia) | Playwright + Chromium + `sharp`; en `forja-apps`; **sin** socket Docker. El engine le pide capturas, axe, flujos y optimización de imágenes por HTTP interno. |

Endurecimiento (app, verify, check, prod): `user: 1000:1000`, `cap_drop: [ALL]`,
`security_opt: [no-new-privileges:true]`, `read_only: true` con escritura solo en
`/workspace` (bind), `/home/node` (bind a `home/`), `/tmp` (`tmpfs` con `exec,size=512m`) y
`/workspace/.next` (volumen `forja-next-<id>`); `pids_limit: 512`; `mem_limit: SANDBOX_MEM`
(2g); `cpus: SANDBOX_CPUS` (2); `ulimit nofile 65536`; `HOME=/home/node`;
`npm_config_cache=/home/node/.npm`; sin `privileged`; sin socket Docker; sin más montajes.
`SANDBOX_RUNTIME=runsc` activa gVisor. El engine corre como uid 1000 y marca
`safe.directory=/data/projects/*` en su `gitconfig` para evitar "dubious ownership".

Aislamiento sandbox → host (obligatorio, `07 §1`): la web se publica solo en
`127.0.0.1:3000` en local (o detrás de Traefik en servidor); `infra/README.md` da las reglas
de firewall en **dos cadenas**: `INPUT` (tráfico desde los bridges `fj-apps` y `fj-i-*`
hacia el propio host, que no pasa por `FORWARD`) y `DOCKER-USER` (tráfico entre redes),
permitiendo solo los puertos de Traefik. El engine escucha en `forja-apps` solo con
`api-key`.

Red: por defecto los sandboxes salen a Internet (`npm install`). `SANDBOX_EGRESS=registry-only`
los limita a Verdaccio (`infra/`) y a su red interna; recomendado en servidor.
`default-address-pools` de Docker se documenta en `infra/README.md` (una red interna por
proyecto activo; las de proyectos archivados se eliminan, así que el límite de ~30 redes
no se alcanza con `SANDBOX_MAX_ACTIVE=5`).

## 2. Imagen `forja-runner`

`node:22-bookworm-slim` + `git`, `curl`, `bash`, `tini`, usuario 1000, **fuentes OFL
curadas** en `/opt/forja/fonts/` (Inter, Geist, Geist Mono, Source Serif, Fraunces, JetBrains
Mono, Space Grotesk, Manrope…) que la herramienta `font_vendor` copia al repo, y un almacén
npm precalentado en `/opt/forja/npm-cache` que la provisión **copia** a `home/.npm` del
proyecto (así es escribible). Se etiqueta por versión de plantilla (`forja-runner:<template-version>`).

## 3. Ciclo de vida y estados (`agentServerStatus`)

`Creating → Starting → Active → Archiving → Archived → Unarchiving → Starting`

- **Creating**: red interna, volúmenes, DB (+ roles y base `app`), copia del caché npm,
  `npm ci`. **Starting**: `next dev` arrancando; sondeo hasta 200 o
  `SANDBOX_START_TIMEOUT_SEC` (300). **Active**.
- **Archiving/Archived**: tras `SANDBOX_IDLE_MINUTES` (120) sin runs, ediciones ni tráfico
  de Traefik: captura estática (HTML + PNG) a `snapshot/`, `pg_dump` a `backups/`,
  `docker stop` de app y DB, eliminación de la red interna. `developmentUrlFieldToUse` →
  `"cachedDevelopmentUrl"`. Nada se destruye.
- **Unarchiving**: `docker start` (5–20 s). Cualquier endpoint que **necesite sandbox o DB**
  (tabla en `05 §2.2`) lo despierta y devuelve `409 SERVER_NOT_READY`; los que solo
  necesitan git (`files/tree`, `files/content GET`, `versions`, `version-diff`,
  `source-code`) responden sin despertar.
- `agent/server/start-or-restart` reinicia `forja-app-<id>`; `Starting` síncrono.
- **Borrado**: `DELETE /projects/:id` = despublicar, parar y eliminar contenedores y redes,
  marcar `deleted_at` (soft). Un job `project.purge` borra volúmenes, bind mounts y repo a
  los `PROJECT_PURGE_AFTER_DAYS` (7). Hasta entonces `POST /v2/projects/:id/undelete`.

## 4. Preview: URLs y enrutado

Traefik v3 con provider Docker vía el socket proxy compartido de `forja-docker`
(`CONTAINERS`, `EVENTS` para el provider; el mismo proxy da al engine `IMAGES`, `NETWORKS`,
`VOLUMES`, `EXEC`, `BUILD`, `POST`), `exposedByDefault=false`, y **provider de ficheros**
(`/data/traefik/dynamic/*.yml`, escrito por el engine) para dominios personalizados y rutas
que no caben en labels. Un segundo proxy de solo lectura exclusivo para Traefik queda como
endurecimiento opcional de la fase 4.

Labels de `forja-app-<id>`:
```
traefik.enable=true
traefik.docker.network=forja-apps
traefik.http.routers.app-<id>.rule=Host(`<id>.${PREVIEW_DOMAIN}`)
traefik.http.routers.app-<id>.entrypoints=web|websecure
traefik.http.services.app-<id>.loadbalancer.server.port=3000
traefik.http.routers.app-<id>.middlewares=forja-preview-auth@file   # solo si PREVIEW_PUBLIC=false
```
Sin rate limit en previews (rompería HMR).

- `PREVIEW_DOMAIN=forja.localhost`. Chrome y Firefox resuelven `*.localhost` a loopback;
  **Safari se verifica en la fase 1** y, si falla, la documentación indica `dnsmasq` o
  `/etc/hosts`. `temporalDevelopmentProjectUrl = http://<id>.forja.localhost` (puertos 80/443
  de Traefik obligatorios; si el operador no puede usar 80, `PREVIEW_PORT` se añade a la
  URL y `productionProjectUrl` deja de ser un hostname pelado: en ese caso la UI recibe el
  esquema y puerto por `/api/config`, ver `08`).
- **Dentro de contenedores `*.localhost` no resuelve.** Todo lo que se ejecute en servidor
  usa URLs internas: el proxy de preview de la UI llama a
  `engine /v2/projects/:id/preview/*` (el engine reenvía a `forja-app-<id>:3000` o, si se
  pide `?target=verify`, a `forja-verify-<id>:3000`); Playwright usa `forja-verify-<id>:3000`;
  las apps generadas reciben `NEXT_PUBLIC_APP_URL` (público) y `INTERNAL_APP_URL` (propio
  contenedor) y BetterAuth `trustedOrigins` con ambos más el dominio de producción.
- Preview privada (`PREVIEW_PUBLIC=false`, valor por defecto en modo servidor;
  `true` en local): middleware `forward-auth` → `engine /v2/auth/preview` valida un
  **token en la URL** (`?_forja_token=`) que la UI añade al abrir el proyecto y que el
  engine cambia por una cookie de primera parte en `<id>.${PREVIEW_DOMAIN}`; así no depende
  de cookies de terceros en el iframe.
- Página "no listo": Traefik devuelve 503 (no 2xx) → la UI lo interpreta como pendiente.
- Captura `previewImageUrl`: sidecar tras cada run y antes de archivar; servida por la
  superficie pública firmada (`05 §2.3`).

## 5. Ediciones manuales, HMR y "rebuild"

- La plantilla arranca `next dev --webpack`: el editor visual de la UI depende del hook
  `webpack` de `next.config.ts` para etiquetar el origen de cada elemento
  (`visual-edit-upgrade.ts`). Portar `source-tags.js` a un loader de Turbopack queda en el
  backlog; hasta entonces webpack en desarrollo, Turbopack no.
- `PUT files/content` (fuera de un run) escribe en `work/` y hace commit; HMR lo aplica al
  instante. `rebuildRequired` es `true` solo para ficheros de configuración (`next.config.*`,
  `package.json`, lockfile, `.env*`, `drizzle.config.*`, `postcss`/`tailwind` config,
  `tsconfig.json`). Acepta `baseCommitSha` opcional y devuelve `409 STALE_WRITE` si `main`
  avanzó (pestañas concurrentes). Las escrituras del mismo cliente en 3 s se agrupan en un
  commit (`visual-edit/apply` escribe hasta 200 ficheros: una versión, no 200).
- `.forja/**` y `.totalum/**` son scratch: no se versionan ni aparecen en `files/tree`,
  pero `files/content` los lee y escribe fielmente (el canario del editor visual pasa).
- `POST rebuild`: pone `rebuilding` síncrono; si el último commit no tocó configuración
  es un **no-op** que pasa a `success` en el siguiente sondeo; si la tocó, reinstala
  dependencias si cambió el lockfile, aplica migraciones pendientes a `app`, reinicia
  `forja-app-<id>` y espera `GET /` 200 (10–40 s). La UI se actualiza en la fase 1 para
  honrar `rebuildRequired` (`08`).

## 6. Versiones = git

- Ramas: `main` (usuario), `run/<runId>` (trabajo), v2: `wt/<runId>/<taskId>`. Al terminar
  un run: `git merge --no-ff run/<runId>` en `main`, tag `v<N>`, checkout de `work/`.
- `versions`: `{id, projectId, runId?, tag, commitSha, parentSha, message, prompt?,
  recoveredFromId?, checks, createdAt}`.
- **Diff**: `git diff <parent> <sha>` en el engine. Los mensajes **no** llevan `gitDiffUrl`
  (la ruta `git-diff` de la UI exige https y un host externo); la UI ya cae a
  `version-diff?commitSha`, que responde sin sandbox.
- **Restaurar** `versions/:id/recover`: `versionRecovery` síncrono; `pg_dump` de `app`;
  `git read-tree -u --reset <sha>` sobre `work/` + commit "restore v<N> (from v<M>)"
  (hacia delante; los merges no estorban); si el lockfile cambió, `npm ci`; reinicio de la
  app. El esquema de base de datos **solo avanza**: las migraciones aplicadas se conservan
  y se documenta; `?restoreDatabase=true` (v2) restaura también el `pg_dump` tomado en la
  versión destino si existe.
- Cada escritura manual y cada pull es un commit y una versión.
- Copias: `git bundle` + `pg_dump` diarios a `BACKUP_DIR` o S3 (`BACKUP_S3_*`). La base del
  engine y `master.key` se incluyen en el mismo job (`backup.engine`).

## 7. Publicación

### 7.1 Local (por defecto)
1. `deploy` → `deploying` síncrono; job `deploy.build`.
2. `docker build` con el `Dockerfile` del proyecto → `forja/<id>:v<N>` (BuildKit, caché
   por proyecto).
3. Base de producción `forja-proddb-<id>` (volumen propio, contraseña generada y guardada
   en `secrets` como `POSTGRES_PASSWORD@production`). **Migraciones como job separado**
   (`docker run --rm forja/<id>:v<N> node migrate.mjs`) **antes** del cambio de
   tráfico; la plantilla exige migraciones compatibles (expand/contract), así la versión
   anterior sigue funcionando durante el cambio.
4. Arranque de `forja-prod-<id>-v<N>` con env de producción (secretos `production|both`
   renderizados a un `env_file` temporal con permisos 600, borrado tras el arranque),
   labels `Host(<id>.${PUBLISH_DOMAIN})`, `traefik.docker.network=forja-apps`.
5. `GET /api/health` 200 → cambio de ruta (el router nuevo sustituye al antiguo por
   prioridad), parada del contenedor anterior (se conserva una versión previa parada),
   `success`; fallo → `error` con el log.
6. `productionProjectUrl = <id>.${PUBLISH_DOMAIN}` (hostname pelado; la UI obtiene el
   esquema por `/api/config`).
7. **Rollback** (`POST deployments/rollback`, v2): arrancar la versión previa **solo si no
   hay migraciones entre ambas**; si las hay, el engine lo rechaza con `ROLLBACK_NEEDS_DB`
   y ofrece redeploy de la versión anterior con migraciones hacia delante.
8. `unpublish`: parar y eliminar contenedores prod y rutas; datos de producción se
   conservan salvo `?purge=true`.

El proyecto no usa `docker compose` dentro de Forja (el engine crea contenedores
directamente con nombres versionados); `compose.prod.yaml` es lo que el usuario se lleva y
la puerta 6 valida que la imagen del `Dockerfile` arranca.

### 7.2 Servidor propio
`PUBLISH_DOMAIN=apps.midominio.com`, DNS comodín, `PUBLISH_TLS=true`, certificado comodín
por **DNS-01** (`ACME_DNS_PROVIDER` + credenciales del proveedor DNS en `ACME_DNS_*`, lista
de proveedores soportados por Traefik). Sin proveedor DNS, HTTP-01 por host, con el aviso
del límite de Let's Encrypt (50 certificados por dominio y semana).

### 7.3 Dominios personalizados
- `PUT /domain {hostname}`: rechaza sin deploy (`NO_DEPLOYMENT`), hostnames reservados y
  apex sin `PUBLISH_IP`. Crea `domains` en `pending_validation` con `dnsRecordsToAdd`:
  `CNAME <hostname> → <id>.${PUBLISH_DOMAIN}` (o `A → PUBLISH_IP`) y
  `TXT _forja-verify.<hostname> = <token>`.
- Job `domain.verify` cada 60 s: DNS correcto → `pending_deployment`; el engine escribe
  `/data/traefik/dynamic/domain-<id>.yml` (router `Host(<hostname>)` → servicio prod,
  `tls.certresolver=http01`); `sslStatus` sigue `initializing → issuing → active` leyendo la
  API de Traefik; `active` cuando `GET https://<hostname>/api/health` responde. `blocked`
  si el DNS apunta a otro sitio más de 24 h. `DELETE` borra el fichero dinámico.

### 7.4 Otros destinos
El proyecto es autosuficiente (`compose.prod.yaml`, `README` con despliegue en VPS,
Fly.io, Railway, Render, Vercel + Postgres gestionado). Adaptadores automáticos
(`DeployTarget`) quedan para después.

## 8. Logs

- Dev: `docker logs forja-app-<id>` (`--since`, `--tail`), texto en v1, SSE en v2.
- Prod: `docker logs` del contenedor prod activo + access log de Traefik del router,
  normalizados a la forma de `lib/logs.ts`; filtro `from/to/regexSearch`; retención
  `LOGS_RETENTION_DAYS` (7).

## 9. Bases de datos del proyecto

| Base | Contenedor | Uso |
|---|---|---|
| `app` | `forja-db-<id>` | Desarrollo: lo que ve el usuario en la preview y en la pestaña Database. Se migra **al terminar** un run (fase `finishing`). |
| `verify_<runId>` | `forja-db-<id>` | Creada al empezar un run desde una plantilla vacía; la usan `forja-verify`, las tareas (`db:migrate` de `database`) y las puertas 3–8; se borra al terminar. |
| `app` | `forja-proddb-<id>` | Producción. |

Roles: `app_rw` (la app), `cms_ro` (consultas del CMS), `cms_rw` (CRUD del CMS), creados en
la provisión con contraseñas generadas guardadas en `secrets` (system). La pestaña
Database trabaja sobre `app` de dev; `?env=production` (v2) exige confirmación explícita
por petición (`X-Forja-Confirm: production`).

## 10. Recursos del host

Cada proyecto activo: ~600 MB–1,5 GB RAM (`next dev` + Postgres), +~1 GB durante un run
(`forja-verify`), ~1–2 GB de disco. `SANDBOX_MAX_ACTIVE` (5) limita los despiertos; se
archiva el menos usado. `system.pressure` cuando el disco libre baja de `DISK_MIN_FREE_GB`
(5); creación rechazada por debajo de la mitad. Docker Desktop (macOS/Windows): `infra/
README.md` documenta `WATCHPACK_POLLING=true` para HMR sobre bind mounts y
`host.docker.internal` para Ollama/LM Studio.
