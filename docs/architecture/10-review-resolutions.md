# 10 · Registro de resoluciones de la revisión de diseño

El 2026-09-25 un revisor adversarial (agente Opus 5.5) auditó el diseño completo contra el
código de la UI y la investigación. Este registro deja constancia de cada hallazgo y de
cómo quedó resuelto en los documentos, para que nadie "restaure" lo anterior.

## Contradicciones (todas resueltas)

| # | Hallazgo | Resolución |
|---|---|---|
| 1 | Turbopack ignora el hook `webpack` del editor visual | Plantilla con `next dev --webpack`; loader Turbopack en backlog (`04 §5`, `06 §1`) |
| 2 | Flujos sin `api-key` (forward-auth, capturas, subidas, diffs) | Superficie pública firmada servida a través de la UI (`05 §2.3`) |
| 3 | `gitDiffUrl` rechazado por la ruta `git-diff` (https obligatorio) | No se emite `gitDiffUrl`; la UI cae a `version-diff` (`04 §6`) |
| 4 | Paralelismo designer ∥ brand ∥ copywriter contradice sus entradas | Orden designer → (brand ∥ imagery) → copywriter (`03 §2`) |
| 5 | Alcances de la tabla ≠ lo que escriben los prompts | Tabla regenerada desde `packages/agents` y alineada con cada prompt (`03 §1`) |
| 6 | ¿Puertas por código o por agente? | Orquestador ejecuta; qa escribe e2e y hace triaje (`03 §6`, `qa.md`) |
| 7 | Tres descripciones del contenedor de arranque | Solo `forja-check` con la imagen del `Dockerfile` (`03 §6` puerta 6, `04 §1`) |
| 8 | Mensajes con ids de tarea y nombres de rol, en castellano fijo | Plantillas localizadas sin ids ni roles; `projects.language` (`05 §2.4`) |
| 9 | Borrado soft vs hard | Soft + purga a los N días + `undelete` (`04 §3`) |
| 10 | Apps publicadas con forward-auth | Solo previews (`07 §1`) |
| 11 | `frame-ancestors` rompe el iframe de preview | `ALLOWED_FRAME_ANCESTORS` desde env (`06 §4`) |
| 12–24 | Nombres de variables, límites de reintento repartidos, enum de intención, `PREVIEW_PUBLIC`, ejemplo de arranque, wording de `contracts`, `migrate.mjs`, egress, reserva de cierre, semántica de stop, Codestral como fixer, "sandbox desechable", flecha del diagrama | Política de reintentos única (`03 §6`); `_SEC`; `full` en `01`; defaults en `09`; ejemplo corregido; `migrate.mjs` empaquetado; `00` apunta a `07`; reserva 10 % (`02 §6`); stop aborta y no fusiona (`03 §8`); Codestral eliminado; prompt de Anthropic corregido; diagrama corregido |

## Huecos frente al contrato de la UI (resueltos)

| # | Hallazgo | Resolución |
|---|---|---|
| 1 | URLs del engine inalcanzables desde navegador y bloqueadas por SSRF | `/api/files/<token>` en la UI que hace stream del engine; `visual-edit` reconoce su origen (`05 §2.3`) |
| 2 | Canario del editor visual crea versiones basura; 200 escrituras = 200 versiones | `.forja`/`.totalum` scratch no versionado; agrupación de commits en 3 s (`04 §5`) |
| 3 | Rebuild reinicia aunque HMR ya aplicó | Rebuild no-op sin cambios de configuración; UI honra `rebuildRequired` (`04 §5`, `08` fase 1) |
| 4 | Web no puede resolver `forja-app-<id>` | Proxy de preview vía engine `/v2/projects/:id/preview/*` (`04 §4`) |
| 5 | Sandbox → web sin auth → clave del engine | Web fuera de `forja-apps`, publicada en loopback, regla `DOCKER-USER` (`04 §1`, `07 §1`) |
| 6 | Transiciones síncronas incompletas; `createdAt` colisiona; wake en lecturas git | `pull-status` null; `created_at` estrictamente creciente; tabla endpoint → necesita sandbox/DB/nada (`05 §2.2`) |
| 7 | Disciplina de mensajes sin especificar | Tabla de emisión por resultado (`05 §2.4`); `isProvided` calculado por el orquestador |
| 8 | DSL → SQL: sort por defecto, casts, escape ILIKE, `propertyId`=nombre, ficheros, rol, UUID | Convenciones de la plantilla + compilador especificado (`05 §6`) |
| 9 | Campos de fichero sin historia en producción | Puerto `storage` en la plantilla (`06 §1`, `05 §6.3`) |
| 10 | Secretos legibles vía `.env` en el worktree | `.env*` prohibido en `files/*`; `env_file` temporal; redactor (`07`) |
| 11 | Modal de créditos apunta a JSON | Página `/project/:id/budget` en la UI (`08` fase 1) |
| 12–14 | Esquema `https://` hardcodeado; `NEXT_PUBLIC_PUBLISH_DOMAIN` en build; clave del engine "generada" sin forma de compartirla | `/api/config` entrega esquema y dominios; servicio `init` de compose escribe la clave en fichero compartido (`05 §2.1`, `08`, `09`) |

## Riesgos técnicos (resueltos o acotados)

| # | Hallazgo | Resolución |
|---|---|---|
| 1 | Rutas host vs contenedor en bind mounts | `DATA_DIR_HOST` + comprobación al arrancar (`04 §1`) |
| 2–3 | Worktrees paralelos vs un solo bind mount; qué muestra la preview durante un run | v1 secuencial sobre `run/` en `forja-verify`; `work/` (main) en `forja-app`; escrituras manuales → `AGENT_RUNNING` durante el run (`03 §2`, `04 §1`) |
| 4 | Restore con `revert` falla en merges y no toca la DB | `git read-tree -u --reset` + commit; esquema solo avanza; `pg_dump` previo (`04 §6`) |
| 5 | DB de dev compartida y migrada desde ramas no fusionadas | Base `verify_<runId>` por run; `app` se migra al terminar (`04 §9`) |
| 6 | pg-boss expira jobs largos; reanudación repite efectos | Jobs inician fases; lease + heartbeat; checkpoints y diario de efectos; cancel por NOTIFY (`03 §8`) |
| 7 | Nombres de herramienta con punto | Registro `snake_case` (`11`) |
| 8 | Read-only root vs npm/Next; uid; `safe.directory` | Montajes escribibles explícitos, `HOME`, `npm_config_cache`, tmpfs `exec`, engine uid 1000 (`04 §1`) |
| 9 | Una red por proyecto agota el pool | `forja-apps` compartida + `forja-int-<id>` interna eliminada al archivar (`04 §1`) |
| 10 | `*.localhost` no resuelve en contenedores; Safari | URLs internas en servidor; `INTERNAL_APP_URL`; Safari en fase 1 (`04 §4`) |
| 11 | Engine con socket Docker ejecuta Chromium y `sharp` | Sidecar `forja-browser` sin socket; socket proxy acotado (`04 §1`, `07`) |
| 12 | Blue/green con migraciones al arrancar; rollback sobre esquema nuevo | Migraciones como job previo, expand/contract, contenedores versionados, rollback solo sin migraciones (`04 §7`) |
| 13 | Dockerfile no arranca (migrador sin deps, `HOSTNAME`, caché de imágenes) | Migrador empaquetado, `HOSTNAME=0.0.0.0`, volúmenes (`06 §5`) |
| 14 | Presupuestos incoherentes; estimación con salida máxima; precios planos | Reparto por pesos, salida esperada, `PriceFn`, `maxOutputTokens` por rol (`02 §3`, `§6`) |
| 15 | Asignación automática mal definida | Requisitos por rol + tier + techo de precio; rechazo al arrancar con mensaje (`02 §3`) |
| 16 | Volumen SSE; catch-all no pasa streams | Deltas efímeros; blobs; retención; ruta SSE dedicada en la UI (`05 §3–4`) |
| 17 | Dominios: labels inmutables, HTTP-01 "bajo demanda", límite LE, DNS-01 sin credenciales | Provider de ficheros; DNS-01 con `ACME_DNS_*`; HTTP-01 por router; aviso de límite (`04 §7`) |
| 18 | Formato `true|key`: shell, regla de parseo, `%7C`, "compuesta gana" | Comillas obligatorias; parseo aclarado; sin `%7C`; discrepancia = error (`02 §1`) |
| 19 | Compactación con `system` intermedio | Rol `user`, último turno nativo (`02 §4.7`) |
| 20 | `env.ts` falla sin claves de integraciones | Claves opcionales + adaptadores mock (`06 §4`) |
| 21 | Lista negra de bash inútil | La frontera es el contenedor (`07`, `11`) |
| 22–23 | Rate limit en previews; cookie de terceros en iframe | Sin rate limit; token en URL → cookie de primera parte (`04 §4`) |
| 24 | Haiku 4.5 se retira | `summarizer` por defecto `claude-sonnet-5` o auto `fast` (`09`) |
| 25 | Términos de Unsplash | Adaptador cumple descarga+atribución; opcional (`02 §7`) |

## Carencias añadidas

Storage, mailer, jobs y cron en la plantilla (`06`); pagos y OAuth con adaptadores mock y
documentación de Stripe CLI en el README generado; hoja de Next 16 en el contexto de cada
tarea y `src/proxy.ts` asignado a `frontend` (`03 §4`); migración de proyectos Totalum
existentes como ruptura documentada (`08` fase 6); `template_version` por proyecto e
intención `upgrade` (`06`); `baseCommitSha` en escrituras (`04 §5`); reanudación y copias
del engine (`03 §8`, `04 §6`); arneses de prueba en la fase 0 (`08`); ids reservados
(`05 §1`); idioma por proyecto (`05 §2.4`); cambios del monorepo listados (`08` fase 0);
Docker Desktop (`04 §10`); límites y validación de subidas (`05 §1`, `07`).

## Alcance v1 (decisión)

Se **mantienen los quince roles** en el diseño y los prompts, porque son un requisito del
producto, pero se implementan en dos fases (`08` fases 2 y 3). Se **difiere a v2**: tareas
paralelas con worktrees, protocolo XML activo para modelos no locales, MCP, webhooks,
export/import, aprobación de plan y preguntas bloqueantes, Lighthouse como puerta, índice de
símbolos, rollback con base de datos, `?env=production`. Los cuatro adaptadores LLM cubren
los diecisiete proveedores desde el principio.

## Pendiente de verificar en la fase 1 (no resoluble en papel)

- Resolución de `*.localhost` en Safari.
- Compatibilidad de gVisor con `next dev --webpack` y `sharp`.
- Rendimiento de HMR sobre bind mounts en Docker Desktop.
- IDs de modelos locales de Ollama citados en `prompts/providers/ollama.md`.
