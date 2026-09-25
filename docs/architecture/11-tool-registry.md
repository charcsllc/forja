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
| `image_search` | `query`, `orientation?`, `color?`, `count?` | Proveedores `STOCK_*` activos; devuelve candidatos con licencia y autor |
| `image_generate` | `prompt`, `aspect`, `count?` (≤2), `style?` | Proveedores `IMAGE_*`; coste registrado en `media_calls`; presupuesto por slot |
| `image_optimize` | `source`, `variants[]`, `focal?` | `sharp`; AVIF/WebP + fallback |
| `svg_validate` | `path` | Bien formado, `viewBox`, sin scripts ni referencias externas, tamaño |
| `svg_text_to_path` | `path`, `font` | Convierte `<text>` a `<path>` con las fuentes vendorizadas |
| `font_vendor` | `family` | Copia una familia OFL de `/opt/forja/fonts` a `src/app/fonts/<family>/` y devuelve el snippet `next/font/local` |
| `contrast_check` | `pairs[{fg,bg}]` | Ratios WCAG |
| `seo_audit` | — | Longitudes, duplicados, campos ausentes en `src/content/seo.ts` |

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
