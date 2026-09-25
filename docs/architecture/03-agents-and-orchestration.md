# 03 · Agentes y orquestación

## 1. El equipo

Quince roles. Cada uno tiene un prompt propio en `docs/prompts/roles/<rol>.md`, un conjunto
de herramientas permitidas (`11-tool-registry.md`), un modelo elegible por entorno (`02 §3`)
y un presupuesto. Todos comparten la persona base (`docs/prompts/_base-engineer.md`).

**Fuente de verdad de alcances y herramientas:** `packages/agents/src/roles/<rol>.ts`
(globs de escritura, herramientas, requisitos de modelo, esquema de la salida final). La
tabla siguiente se genera desde ahí con `npm run agents:docs`; no se edita a mano.

| Rol | Misión | Alcance de escritura (globs) | Herramientas (además de `read_file`, `grep`, `glob`) | Requisitos de modelo | Salida final |
|---|---|---|---|---|---|
| `director` | Dirección técnica; entiende, decide, planifica, resuelve conflictos, habla con el usuario | ninguno | `git_log`, `git_diff`, `submit_intent`, `submit_plan`, `submit_decision`, `submit_message` | JSON schema, contexto ≥200K, tier frontier | `submit_plan` / `submit_message` |
| `designer` | Sistema de diseño de cada web; revisión visual | `docs/design/**`, `src/app/globals.css`, `src/components/ui/**`, `src/app/fonts/**` | `write_file`, `edit_file`, `contrast_check`, `font_vendor`, `browser_screenshot`, `submit_report` | visión, tier frontier | `submit_report` (+ `submit_design_review` en verificación) |
| `brand` | Logo, favicon, iconos, OG, guía de identidad | `public/brand/**`, `public/favicon.ico`, `src/app/icon.svg`, `src/app/apple-icon.png`, `src/app/opengraph-image.tsx`, `docs/brand/**` | `write_file`, `edit_file`, `image_generate`, `image_optimize`, `svg_validate`, `svg_text_to_path`, `submit_report` | visión | `submit_report` |
| `imagery` | Buscar o generar imágenes, optimizar, registrar licencia | `public/media/**` | `write_file`, `image_search`, `image_generate`, `image_optimize`, `submit_report` | visión (si genera y compara) | `submit_report` |
| `copywriter` | Textos, SEO, metadatos, i18n, `alt` | `src/content/**`, `messages/**`, `docs/content/**`, `public/media/alt.json` | `write_file`, `edit_file`, `seo_audit`, `submit_report` | — | `submit_report` |
| `database` | Esquema, migraciones, seed, consultas | `src/db/**`, `drizzle/**`, `tests/db/**`, `docs/adr/*-data-model.md` | `write_file`, `edit_file`, `bash`, `db_query`, `db_introspect`, `submit_report` | tier strong+ | `submit_report` |
| `backend` | Casos de uso, APIs, auth, integraciones | `src/modules/<feature>/{domain,application,infrastructure}/**`, `src/app/api/**`, `tests/modules/<feature>/**` (según tarea) | `write_file`, `edit_file`, `bash`, `http_probe`, `submit_report` | tier strong+ | `submit_report` (con `envNeeds[]`) |
| `frontend` | Páginas, componentes, responsive, a11y | `src/app/**` (salvo `api`, `globals.css`, iconos), `src/components/layout/**`, `src/modules/<feature>/ui/**`, `tests/components/**`, `src/proxy.ts` | `write_file`, `edit_file`, `bash`, `browser_screenshot`, `browser_axe`, `submit_report` | tier strong+ | `submit_report` |
| `supervisor` | Integración y entorno: merge, `Dockerfile`, compose, env, scripts, CI | raíz (`Dockerfile`, `compose*.yaml`, `.dockerignore`, `.env.example`, `package.json`, lockfile), `scripts/**`, `.github/**`, `src/env.ts` | `write_file`, `edit_file`, `bash`, `git_merge`, `compose_validate`, `request_rework`, `submit_report` | tier strong+ | `submit_report` (con `secretKeysNeeded`) |
| `qa` | Escribe e2e; triaje de fallos de las puertas | `e2e/**`, `tests/**` (solo añadir) | `write_file`, `edit_file`, `bash` (solo `playwright`, `vitest`), `browser_*`, `http_probe`, `submit_triage` | — | `submit_triage` |
| `reviewer` | Revisión contra spec y arquitectura, otra familia de modelo | ninguno | `git_diff`, `git_log`, `submit_review` | tier frontier, familia ≠ implementador | `submit_review` |
| `security` | Revisión de seguridad | ninguno | `bash` (solo `npm audit`, `security_scan`), `http_probe`, `submit_review` | tier frontier | `submit_review` |
| `docs` | README, AGENTS.md, ADRs, changelog, READMEs de módulo | `README.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/**`, `src/modules/*/README.md` | `write_file`, `edit_file`, `git_log`, `bash` (solo `--help`, `--dry-run`), `submit_report` | — | `submit_report` |
| `fixer` | Arreglos mecánicos de tipos y lint | ficheros de la lista de errores y sus imports directos | `edit_file`, `bash` (solo `tsc`, `eslint`, `prettier`, `next build`), `submit_report` | tier fast | `submit_report` |
| `summarizer` | Compactación y handoff | ninguno | `submit_summary` | tier fast, contexto ≥128K | `submit_summary` |

Regla de salida: **cada rol termina llamando a su herramienta `submit_*`**, cuyo esquema
zod es el contrato con el orquestador. El texto libre después de la llamada se ignora. Como
`tool_choice` nunca se fuerza (`02 §4`), el prompt lo exige y el orquestador reintenta un
turno con el recordatorio "call submit_report now" si el modelo termina sin llamarla; a la
segunda vez, la tarea queda `failed` con el último texto como informe.

Todas las herramientas se ejecutan con el lease de la tarea: una escritura fuera de
`scope.write` devuelve un error al modelo y emite `scope.violation`.

## 2. Ciclo de vida de un run

```
 prompt ─▶ received ─▶ directing ─┬─ question ─▶ answering ─▶ done
                                  ├─ tweak | bugfix ─▶ implementing ─▶ integrating ─▶ verifying ─▶ done
                                  └─ feature | refactor | infra | full
                                        ▼
                                     designing      designer → (brand ∥ imagery) → copywriter   [solo si hay UI nueva]
                                        ▼
                                     modelling      database                                    [solo si hay datos nuevos]
                                        ▼
                                     implementing   backend, frontend (orden topológico del DAG; v1 secuencial)
                                        ▼
                                     integrating    supervisor: merge, entorno, migrar DB de verificación
                                        ▼
                                     verifying      orquestador: puertas deterministas; qa: triaje; designer: revisión visual
                                        │  fallo → owner | fixer (política de reintentos §6) → verifying
                                        ▼
                                     reviewing      reviewer ∥ security  (bloqueante → implementing, máx AGENT_MAX_REVIEW_ROUNDS)
                                        ▼
                                     documenting    docs
                                        ▼
                                     finishing      merge a main, tag, migrar DB de dev, captura, coste, mensaje
                                        ▼
                                     done | failed | limit-reached | cancelled
```

`runs.status` ∈ {`received`, `directing`, `answering`, `designing`, `modelling`,
`implementing`, `integrating`, `verifying`, `fixing`, `reviewing`, `documenting`,
`finishing`, `cancelling`, `done`, `failed`, `limit-reached`, `cancelled`}.
`tasks.status` ∈ {`pending`, `running`, `checking`, `done`, `failed`, `cancelled`, `skipped`}.

Proyección a la API v1: cualquier estado no terminal → `init`; `done`/`failed`/
`limit-reached`/`cancelled` → `done`; sin runs → `idle`. Los mensajes que ve el usuario se
generan según la tabla de `05 §2.1`.

**Paralelismo.** En la v1 las tareas de implementación se ejecutan **en secuencia** sobre
una única rama `run/<runId>` y un único checkout (`04 §1`). El DAG sigue existiendo para el
orden y para los alcances disjuntos, que la v2 aprovechará con worktrees por tarea y
contenedores de comprobación por tarea. La investigación (`research/03 §B.2`) respalda
empezar así: los implementadores paralelos sobre un mismo código son la principal fuente
de decisiones contradictorias.

### Clasificación de intención (director, herramienta `submit_intent`)

| Intención | Pipeline | Ejemplo |
|---|---|---|
| `question` | responde desde el repo; sin cambios; mensaje `finished` sin `versionId` | "¿qué base de datos usa?" |
| `tweak` | una tarea `frontend` o `copywriter`; puertas reducidas (tsc, lint, build, captura) | "pon el botón en azul" |
| `bugfix` | qa reproduce (e2e que falla) → owner arregla → puertas completas | "el login da error 500" |
| `feature` | designing (si hay UI nueva) → modelling (si hay datos) → implementing → … | "añade un carrito" |
| `refactor` | director y reviewer fijan el objetivo → implementing → verifying (tests verdes) → reviewing | "separa la lógica de pagos" |
| `infra` | supervisor → verifying | "añade Redis para caché" |
| `full` | todo, primer prompt de un proyecto | "una tienda de velas artesanales" |

`confidence < 0.6` → el pipeline más completo de los candidatos.

## 3. El plan (`RunPlan`, herramienta `submit_plan`)

Validado con zod (`packages/contracts/src/plan.ts`), persistido en `runs.plan`, evento
`plan.created`. Contrato entre todos los agentes.

```ts
interface RunPlan {
  intent: Intent;
  summary: string;                          // una frase, idioma del usuario
  spec: {
    goal: string; users: string[];
    pages: PageSpec[];                      // ruta, propósito, secciones, slots de contenido, estados, datos
    features: FeatureSpec[];                // historias de usuario, reglas de negocio
    dataModel: EntitySpec[];                // entidades, campos, relaciones, invariantes
    integrations: string[];
    nonFunctional: { seo: boolean; auth: "none"|"email"|"oauth"; i18n: string[]; a11y: "AA" };
  };
  decisions: Decision[];                    // ADRs
  tasks: Task[];
  budgetWeights: Record<string, number>;    // peso relativo por tarea; el orquestador reparte USD
  verification: { pages: string[]; flows: FlowSpec[] };
}

interface Task {
  id: string; role: AgentRole; title: string;
  description: string;                      // autocontenida: el agente no ve el prompt del usuario
  dependsOn: string[];
  scope: { write: string[]; read?: string[] };
  acceptance: string[];
  weight: number;
}
```

Reglas del plan (validador determinista; un plan inválido vuelve al director con el error):
- Los alcances de escritura de tareas sin dependencia mutua son disjuntos (aunque la v1
  las ejecute en secuencia, la regla se mantiene para que el plan sirva en v2).
- Ficheros calientes (`package.json`, lockfile, `src/db/schema/index.ts`,
  `src/app/layout.tsx`, `globals.css`, `next.config.ts`, `src/env.ts`, `.env.example`)
  pertenecen a una sola tarea o al supervisor.
- Cada página tiene exactamente **una tarea `frontend` propietaria** (el "dueño de la
  página"); designer, copywriter e imagery contribuyen ficheros de su alcance, no la página.
- El orquestador añade las tareas de `supervisor`, `qa`, `reviewer`, `security` y `docs` y
  reparte el presupuesto: `BUDGET_PER_RUN_USD` × 0,65 entre las tareas del plan por peso,
  0,25 para verificación, revisión y arreglos, **0,10 reservado para el cierre** (`02 §6`).
- El director conoce `AGENT_MAX_PARALLEL_TASKS` y los techos por tarea; no los supera.

## 4. Ejecución de una tarea

1. El orquestador registra el lease (`scope.write`) y comprueba que la tarea tiene todas
   sus dependencias en `done`; en la v1 todo ocurre sobre `run/<runId>` en el checkout
   `run/` del proyecto (`04 §1`).
2. Ensambla el prompt: persona base + rol + adaptador del proveedor (+ notas de la familia
   subyacente para agregadores y locales) + "Tool protocol" si es XML + contexto de tarea:
   spec relevante, decisiones, sistema de diseño si es UI, `AGENTS.md` del proyecto, **hoja
   de referencia de Next.js 16** (`packages/agents/src/context/next16.md`: `proxy.ts`, params
   asíncronos, `--webpack`, App Router), árbol de ficheros del alcance, informes de las
   tareas de las que depende, y el esquema exacto de su `submit_*`.
3. Bucle modelo ↔ herramientas hasta `submit_*`, `AGENT_MAX_TURNS_PER_TASK` o presupuesto.
   Cada turno se persiste como checkpoint (mensajes + diario de efectos de herramientas)
   para poder reanudar tras un reinicio del engine sin repetir efectos con coste (`§8`).
4. **Puerta local** (código, no agente): `tsc --noEmit` y `eslint` en el contenedor de
   verificación. Fallo → política de reintentos (§6).
5. Commit en `run/<runId>` con mensaje convencional generado desde el informe.
6. Evento `task.finished` con el informe y el coste.

Eventos por turno: `tool.call`, `tool.result`, `file.diff`, `command.output`, `text`
(`05 §4`).

## 5. Integración (supervisor)

- En la v1 no hay merge de worktrees (una sola rama). El supervisor: instala dependencias si
  cambió `package.json` y regenera el lockfile; aplica migraciones a la **base de datos de
  verificación** del run (`04 §9`); ejecuta `tsc` sobre el árbol integrado y enruta errores
  con `request_rework` (abre una tarea de arreglo para el rol dueño); crea o actualiza
  `Dockerfile`, `compose.yaml`, `compose.prod.yaml`, `.dockerignore`, `.env.example`,
  `src/env.ts` (a partir de los `envNeeds[]` de los informes de backend/frontend),
  `scripts/`, `.github/workflows/ci.yml`; valida `compose config` con `compose_validate`
  (herramienta del engine); reinicia el contenedor de verificación si cambió configuración.
- Emite `integration.report` y `secretKeysNeeded` (variables sin valor ni valor por
  defecto, con descripción). El orquestador calcula `isProvided` contra la tabla `secrets`.
- En la v2, además fusiona worktrees en orden topológico; conflictos triviales los resuelve;
  el resto vuelve al dueño con `request_rework`.

## 6. Verificación: puertas (código) y triaje (qa)

**Las puertas las ejecuta el orquestador**, no un agente. Cada una emite `gate.started` y
`gate.passed` o `gate.failed{output, parsed[]}`. El agente `qa` escribe los e2e del plan
antes de las puertas de flujo y hace triaje de los fallos (a quién van y con qué
observación) mediante `submit_triage`.

| # | Puerta | Dónde | Fallo → |
|---|---|---|---|
| 1 | `tsc --noEmit` | verify container | fixer |
| 2 | `eslint .` | verify container | fixer |
| 3 | `db:migrate` sobre la DB de verificación recién creada + `db:seed` | verify container | database |
| 4 | `vitest run` | verify container | owner (por triaje) |
| 5 | `next build` | verify container | owner |
| 6 | Imagen de producción: `docker build` con el `Dockerfile` del proyecto, arranque con la DB de verificación, `GET /api/health` 200 | engine (`forja-check-<id>-<runId>`) | supervisor |
| 7 | Rutas: cada página del plan → 200, sin `console.error`, sin peticiones 4xx/5xx (salvo lista de cuarentena), un `h1`, `<title>` único, sin overflow horizontal a 375 | sidecar de navegador contra el contenedor de la puerta 6 | owner |
| 8 | Flujos: `npx playwright test e2e/` | sidecar de navegador | owner |
| 9 | Accesibilidad: `axe` por página; `serious`/`critical` fallan | sidecar | frontend |
| 10 | Capturas 375/768/1440 por página → `designer` (`submit_design_review`); `blocking` falla | sidecar | frontend |
| 11 | Lighthouse en la home | sidecar | solo informa (v1) |

Un run con puertas rojas tras agotar los reintentos termina en `done` con mensaje
`finished` que enumera lo que falla (nunca en silencio), y `versions.checks` lo registra.

**Política de reintentos (única, respaldada por env):**

| Situación | Límite | Variable |
|---|---|---|
| Puerta local (tsc/lint) de una tarea | 2 rondas del dueño, luego fixer | `AGENT_TASK_LOCAL_RETRIES=2` |
| Fixer sin progreso sobre el mismo error | 3 pasadas | `AGENT_FIXER_PASSES=3` |
| Rondas de arreglo por run (puertas 1–10) | 4 | `AGENT_MAX_FIX_ROUNDS=4` |
| Mismo error dos veces seguidas | el director decide (re-planifica o cierra) | — |
| Rondas de revisión | 2 | `AGENT_MAX_REVIEW_ROUNDS=2` |
| Turnos por tarea | 60 | `AGENT_MAX_TURNS_PER_TASK=60` |

## 7. Revisión (reviewer, security)

- Reciben el diff **por módulo o tarea** (el orquestador lo trocea por `scope.write`) y una
  ronda final de síntesis con los resúmenes; así el diff de un `full` no desborda el
  contexto.
- Escala de severidad común: `critical`, `high`, `medium`, `low`, `info`.
  `critical`/`high` = bloqueante → `request_rework` automático hacia el dueño (máximo
  `AGENT_MAX_REVIEW_ROUNDS`). `medium` → `docs/backlog.md` y mención al usuario. `low`/`info`
  → backlog.
- El reviewer usa otra familia de modelo que los implementadores cuando hay más de un
  proveedor activo; si no, contexto fresco y checklist obligatorio.
- `security` dispone de usuarios sembrados (`seed.ts` crea `user`, `admin`, `other`) y de
  `http_probe` con `as_user` para probar autorización de verdad.

## 8. Concurrencia, límites, cancelación y reanudación

- `AGENT_MAX_PARALLEL_TASKS` (v1: 1) y `ENGINE_MAX_CONCURRENT_RUNS` (2).
- Un run por proyecto (`AGENT_RUNNING` 409). Durante un run, `files/content PUT` y
  `visual-edit/apply` devuelven `AGENT_RUNNING` (la UI ya trata el 409).
- **Stop** (`agent/stop`): `cancelling` → aborta la llamada LLM en curso en segundos, no
  arranca nada nuevo, hace commit del trabajo en curso en `run/<runId>` **sin fusionar** en
  `main`, y emite un mensaje `error` "Detenido por el usuario; los cambios parciales quedan
  en la versión de trabajo". El siguiente run parte de `main`; la rama queda para
  inspección 7 días.
- **Modelo de jobs (pg-boss)**: los jobs solo **inician fases**; el bucle de una tarea corre
  bajo un lease explícito en `tasks.lease_until` con heartbeat cada 20 s y checkpoints por
  turno. Un job de fase nunca supera 10 min de ejecución propia. Cancelación entre procesos
  por `LISTEN/NOTIFY` (`forja_run_cancel`).
- **Reanudación** tras caída: al arrancar, el engine busca runs con `heartbeat_at` caducado,
  restablece el árbol de `run/` al último commit de tarea, reproduce el diario de efectos
  para no repetir los que tienen coste (generación de imágenes, migraciones) y reanuda la
  tarea desde su último checkpoint.

## 9. Memoria del proyecto entre runs

- `AGENTS.md`, `docs/adr/*`, `docs/backlog.md` del repo generado (mantenidos por `docs`; el
  esqueleto lo siembra la plantilla).
- `projects.language`: idioma del usuario detectado en el primer prompt, usado para los
  mensajes generados por código (`05 §2.1`).
- Índice de símbolos ligero (v2).

## 10. Modos de fallo conocidos y mitigación

| Fallo | Mitigación |
|---|---|
| Delegación vaga → trabajo duplicado | Tareas autocontenidas, alcances disjuntos validados, un dueño por página |
| Decisiones contradictorias | `decisions[]` y `AGENTS.md` en contexto; reviewer comprueba coherencia; v1 secuencial |
| Bucle de arreglo oscilante | Política de reintentos única; el director decide al repetirse un error |
| Revisor complaciente | Otra familia; checklist; puertas deterministas como verdad |
| Modelo que olvida herramientas | Compactación (`02 §4.7`), contexto mínimo, `num_ctx` documentado |
| Coste desbocado | Presupuestos con reserva de cierre; degradación; `maxOutputTokens` por rol |
| Sandbox colgado | Timeouts, `pids_limit`, reinicio por el orquestador, escalado al director |
| Cambios fuera de alcance | Lease en la herramienta; `scope.violation` |
| Secretos en el código | Redacción de valores conocidos en toda salida de herramienta; grep de patrones antes de cada commit; `security` |
| Contenido que "instruye" al agente | Resultados de herramientas etiquetados como datos; prompts lo dicen; hallazgo `info` en `security` |
