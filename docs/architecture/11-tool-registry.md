# 11 · Registro canónico de herramientas

Fuente de verdad: `packages/agents/src/tools/registry.ts`. Nombres en `snake_case`
(`^[a-z][a-z0-9_]{0,63}$`, válidos en Anthropic, OpenAI, Google y compatibles). Cada
herramienta declara: esquema zod de entrada, dónde se ejecuta, política de truncado de
salida, y qué roles la reciben (`03 §1`). Toda salida se pasa por el **redactor de
secretos** (valores de `secrets` del proyecto y patrones de claves → `[redacted]`) antes de
llegar al modelo o a `run_events`.

## Ficheros y búsqueda (engine, sobre el checkout `run/`)

| Herramienta | Entrada | Salida / límites |
|---|---|---|
| `read_file` | `path`, `offset?`, `limit?` (líneas) | Texto con números de línea; máx 400 líneas por llamada; binarios → error con tamaño y tipo |
| `write_file` | `path`, `content` | Crea carpetas; rechaza fuera de `scope.write`; rechaza `.env*`; máx 512 KB |
| `edit_file` | `path`, `old_string`, `new_string`, `replace_all?` | Coincidencia exacta; 0 o >1 coincidencias → error con contexto; formato SEARCH/REPLACE aceptado en modelos `fast`/locales |
| `glob` | `pattern` | Máx 500 rutas |
| `grep` | `pattern`, `glob?`, `context?` | Máx 200 líneas |
| `list_dir` | `path`, `depth?` | Máx 500 entradas |

## Ejecución (contenedor `forja-verify-<id>`, cwd `/workspace`, usuario 1000)

| Herramienta | Entrada | Notas |
|---|---|---|
| `bash` | `command`, `timeout_sec?` (≤600) | Sin TTY; salida truncada a 8 KB (resto a blob); por rol, allowlist de binarios cuando la tabla de `03 §1` lo indica (`fixer`, `qa`, `security`, `docs`); la frontera de seguridad es el contenedor, no una lista negra |
| `http_probe` | `url`, `method?`, `headers?`, `body?`, `as_user?` | Solo hosts internos del proyecto; `as_user` = sesión de un usuario sembrado (`user`, `admin`, `other`) |

## Git (engine)

| Herramienta | Entrada | Notas |
|---|---|---|
| `git_log` | `limit?`, `path?` | |
| `git_diff` | `from?`, `to?`, `path?` | Contra la versión anterior por defecto; truncado a 20 KB con índice de ficheros |
| `git_merge` | `branch` | Solo supervisor; v2 |

## Base de datos (engine → `forja-db-<id>`, base `verify_<runId>`)

| Herramienta | Entrada | Notas |
|---|---|---|
| `db_query` | `sql` | Solo lectura (`cms_ro`), 200 filas, 10 s |
| `db_introspect` | — | Tablas, columnas, FKs, índices |

## Navegador e imágenes (sidecar `forja-browser`)

| Herramienta | Entrada | Notas |
|---|---|---|
| `browser_screenshot` | `path` (ruta de la app), `width` (375/768/1440), `full_page?` | Contra `forja-verify-<id>`; devuelve ruta de la imagen y, para modelos con visión, la imagen |
| `browser_axe` | `path` | Violaciones por severidad |
| `browser_flow` | `spec` (pasos declarativos) | Solo qa; para reproducir bugs antes de escribir el e2e |
| `image_find` | `slot`, `query` (inglés), `alt` (idioma de la app), `orientation?`, `minWidth?` | Una imagen por slot vía `ImageSourcingPort` (`packages/media`, engine, no el sidecar). Escribe `public/images/<slot>.<ext>` y devuelve `{path, publicUrl, width, height, mediaType, alt, mode, attribution}`; mantiene `public/images/credits.json`. Búsqueda web o generación según `images.mode` (02 §7), nunca según el modelo |
| `image_optimize` | `source`, `variants[]`, `focal?` | `sharp`; AVIF/WebP + fallback |
| `svg_validate` | `path` | Bien formado, `viewBox`, sin scripts ni referencias externas, tamaño |
| `svg_text_to_path` | `path`, `font` | Convierte `<text>` a `<path>` con las fuentes vendorizadas |
| `font_vendor` | `family` | Copia una familia OFL de `/opt/forja/fonts` a `src/app/fonts/<family>/` y devuelve el snippet `next/font/local` |
| `contrast_check` | `pairs[{fg,bg}]` | Ratios WCAG |
| `seo_audit` | — | Longitudes, duplicados, campos ausentes en `src/content/seo.ts` |

**`image_find` en detalle.** `slot` (`^[a-z0-9][a-z0-9-]{0,47}$`) es el nombre del fichero:
volver a llamar con el mismo slot reemplaza la imagen y su crédito. El fichero real se mide
(bytes mágicos y cabecera), así que `width`/`height` son los de la imagen escrita, listos
para `next/image`. `attribution` = `{provider, title?, author?, authorUrl?, pageUrl?,
license, licenseUrl?, attributionRequired}`. `public/images/credits.json` es un array
`[{slot, path, alt, attribution}]` (`path` = URL pública, p. ej. `/images/hero.jpg`), una
entrada por slot, ordenado por slot; las entradas sin `slot` escritas a mano se conservan.
Si `attributionRequired` es true (CC BY, CC BY-SA, Unsplash), la app debe mostrar el
crédito (p. ej. página `/credits` que lee ese fichero, enlazada desde el pie). Errores:
`IMAGE_NOT_FOUND` (ningún proveedor dio una imagen utilizable; el agente usa un
placeholder y lo anota) y cancelación del run. Cada petición a un proveedor se registra
en `media_calls` (búsqueda: coste 0). El runtime pasa también `readFile` (el checkout
`run/`) en el contexto del puerto para que `credits.json` se fusione con lo escrito en runs
anteriores.

## Orquestación (engine)

| Herramienta | Quién | Notas |
|---|---|---|
| `submit_intent` | director | `{intent, confidence, reason}` |
| `submit_plan` | director | `RunPlan`; validación determinista; error de vuelta al modelo |
| `submit_decision` | director | ADR durante el run |
| `submit_message` | director | Mensaje final o respuesta a `question` |
| `submit_report` | designer, brand, imagery, copywriter, database, backend, frontend, supervisor, docs, fixer | `TaskReport` (`_base-engineer.md`) + campos por rol (`envNeeds[]`, `secretKeysNeeded[]`, `screenshots[]`) |
| `submit_design_review` | designer | Hallazgos visuales por captura |
| `submit_triage` | qa | Fallos de puertas → rol, observación, evidencia |
| `submit_review` | reviewer, security | Hallazgos `{severity, category|cwe, file, line, title, why|scenario, fix, verified?}` + veredicto |
| `submit_summary` | summarizer | Bloque de resumen |
| `request_rework` | supervisor | Abre una tarea de arreglo para un rol con la observación |
| `compose_validate` | supervisor | `docker compose config` sobre los ficheros indicados, en el engine |
| `security_scan` | security | Patrones de secretos y APIs peligrosas (`scripts/security-scan.sh` vive en `packages/agents/scripts`, no en la plantilla) |

No existen: `plan.emit`, `task.assign`, `build.request`, `supervisor.alert`,
`gate.report`, `apply_patch` (los diffs de OpenAI se traducen a `edit_file` en el adaptador),
ni ninguna herramienta con punto en el nombre.

## Estado fase 2

Implementadas en `packages/agents/src/tools/` (los puertos los implementa el engine en
`apps/engine/src/services/runs/environment.ts`): `read_file`, `write_file`, `edit_file`,
`glob`, `grep`, `list_dir`, `bash`, `db_query`, `db_introspect`, `git_log`, `git_diff`,
`image_find`, `submit_intent`, `submit_plan`, `submit_decision`, `submit_message`
(`{text}`), `submit_report`, `submit_summary`. Detalles:

- Las rutas son relativas a la raíz del proyecto (se acepta el prefijo `/workspace/`);
  `.env*` nunca se escribe y solo se leen los `*.example`; ningún enlace simbólico escapa del
  checkout. Una escritura fuera de `scope.write` devuelve `SCOPE_VIOLATION` al modelo con su
  alcance y emite `scope.violation`.
- `bash` corre `bash -lc` en `forja-verify-<id>` (cwd `/workspace`) y espera a que el
  contenedor esté listo; salida 8 KB (cabeza + cola). La allowlist del fixer se comprueba por
  segmento (`&&`, `||`, `;`, `|`) y rechaza sustitución de comandos.
- `db_query` y `db_introspect` usan `psql` como `cms_ro` sobre `verify_<runId>`, dentro de
  una transacción `READ ONLY` con `statement_timeout` de 10 s; 200 filas.
- `git_diff` sin argumentos compara el checkout `run/` (incluidos ficheros nuevos) con la
  versión de la que partió el run.
- `submit_plan` aplica `validatePlan` y las reglas de la fase (roles `frontend`, `backend`,
  `database`; ≤10 tareas; alcance no vacío). Un envío rechazado vuelve con la lista exacta.
- Los esquemas JSON que ve el modelo se derivan del mismo esquema zod con el que se validan
  los argumentos (`toJsonSchema`, sin dependencias).
- Pendientes (fase 3): `http_probe`, `browser_*`, `image_optimize`, `svg_*`, `font_vendor`,
  `contrast_check`, `seo_audit`, `git_merge`, `submit_design_review`, `submit_triage`,
  `submit_review`, `request_rework`, `compose_validate`, `security_scan`, y el formato
  SEARCH/REPLACE de `edit_file` para modelos `fast`/locales.

