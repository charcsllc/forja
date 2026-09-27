# 07 · Seguridad y privacidad

## 1. Modelo de amenazas (v1: un operador, una instancia)

| Activo | Amenaza | Control |
|---|---|---|
| Claves de proveedores | Fuga por logs, API, código generado, salida de herramientas | Solo el engine las lee; nunca al sandbox; redactor de secretos en toda salida de herramienta y en `run_events`; `/v2/system/models` no las devuelve |
| Clave web ↔ engine | Reutilización desde un sandbox o desde fuera | El engine escucha en `forja-core` (web, postgres) y en `forja-apps` solo con `api-key`; la web **no** está en `forja-apps`; la web se publica en `127.0.0.1` en local o tras Traefik en servidor; regla `DOCKER-USER` que bloquea sandbox → puerta de enlace del host salvo puertos de Traefik |
| Código generado | Escape de contenedor, acceso a otros proyectos | No root, `cap_drop ALL`, `no-new-privileges`, root de solo lectura, límites, red interna por proyecto, sin socket Docker; gVisor opcional; **la frontera es el contenedor**, no una lista negra de comandos |
| Socket Docker del engine | Explotación del engine vía contenido (navegador, imágenes) | Playwright y `sharp` en el sidecar `forja-browser` sin socket; engine → Docker vía socket proxy con solo las operaciones necesarias (`CONTAINERS`, `IMAGES`, `NETWORKS`, `VOLUMES`, `EXEC`, `BUILD`) |
| Secretos de proyecto | Lectura por API, por agentes o por otro proyecto | AES-256-GCM con `FORJA_MASTER_KEY`; API nunca devuelve valores; `.env*` prohibido en `files/*`; renderizado a `env_file` temporal (600) al arrancar contenedores, no al worktree; redacción de valores en salidas de herramientas |
| Previews | Acceso público no deseado | `forward-auth` con token en URL → cookie de primera parte; `PREVIEW_PUBLIC=true` solo en local. **Las apps publicadas son públicas por definición** y no llevan este control |
| Prompts y ficheros del usuario | Salida a proveedores no autorizados | Solo proveedores con `LLM_*=true`; evento `privacy.egress` por destino nuevo |
| SSRF | URLs pegadas por el usuario o construidas por agentes | Guardia SSRF en toda descarga (sin IPs privadas, sin metadatos, `redirect: error`, timeouts); `visual-edit/apply` solo salta la guardia para su propio origen `/api/files/` |
| Inyección de prompt | Contenido de paquetes o páginas que "instruye" | Resultados etiquetados como datos; prompts lo dicen; hallazgo `info` de `security` |
| Dependencias | Paquetes maliciosos | `npm audit` en puerta (con Verdaccio audit habilitado en `registry-only`); `NPM_ALLOWLIST_FILE` opcional; distancia de nombres a paquetes populares |
| Disco y recursos | Agotamiento del host | Límites por contenedor, `SANDBOX_MAX_ACTIVE`, `DISK_MIN_FREE_GB`, `PROJECT_MAX_SIZE_MB`, `UPLOAD_MAX_MB` |
| Subidas | Contenido malicioso | MIME por contenido, tamaño, imágenes re-codificadas, nombres aleatorios, nunca ejecutables |

## 2. Secretos

- `FORJA_MASTER_KEY` obligatorio en servidor; en local, generado por el servicio `init` de
  compose en `/data/engine/master.key` (600). Rotación por `key_version` + `secrets:rotate`.
- `github/env` devuelve nombres y `***` salvo `ALLOW_ENV_EXPORT=true`.
- Grep determinista de patrones antes de cada commit del run; positivo → commit rechazado.
- Copias de seguridad del engine (`backup.engine`): base del engine cifrada + `master.key`
  por separado.

## 3. Privacidad: qué sale de la máquina

| Destino | Cuándo | Qué |
|---|---|---|
| Proveedores LLM activados | Cada turno | Prompt de sistema, tarea, fragmentos de código, resultados de herramientas (redactados) |
| Proveedores de imágenes activados | `imagery`/`brand` | Prompts de imagen, consultas |
| Registro npm (o Verdaccio) | `npm ci` | Nombres de paquetes |
| Let's Encrypt y proveedor DNS | Solo con `*_TLS=true` | Hostnames, desafío DNS-01 |
| GitHub / Figma | Solo si el usuario conecta | Código / diseños |
| `registry.npmjs.org` | `next dev` de la UI, una vez por sesión | Comprobación de versión de Next (`AGENTS.md §11`) |

Test de integración del engine con red bloqueada salvo loopback: sin proveedores activos,
cero conexiones salientes.

## 4. Auditoría

`run_events` inmutable (sin deltas; blobs con retención). Logs del engine con `runId`,
`taskId`, `role`, sin prompts ni claves.

## 5. Preparación multi-tenant (no en v1)

`projects.owner_id` nullable, `api_keys(owner_id, hash, scopes)`, middleware de auth único,
`enforceProjectScope`, presupuestos por `owner_id`. La UI conserva `_shared.ts`.
