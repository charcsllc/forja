# 02 · Gateway LLM y proveedores

`packages/llm` es la única puerta a los modelos. Ningún otro paquete importa un SDK de
proveedor. Expone un **registro de proveedores** construido desde el entorno, un **router**
que resuelve "rol → modelo concreto con fallbacks", y un **bucle de generación** uniforme
(mensajes + herramientas → eventos) que oculta las diferencias entre proveedores.

## 1. Activación por variable de entorno (formato de dos valores)

Cada proveedor se activa con **una** variable cuyo valor tiene **dos partes** separadas por
`|`: el interruptor y la clave. **Siempre entre comillas** en `.env` (Docker Compose y
`dotenv` no ejecutan el valor; un shell que haga `source` sin comillas interpretaría `|`).

```dotenv
LLM_ANTHROPIC="true|sk-ant-api03-…"
LLM_OPENAI="false|"
LLM_ZAI="true|a1b2c3.…"
LLM_QWEN="true|sk-…"
LLM_DEEPSEEK="true|sk-…"
LLM_GOOGLE="true|AIza…"
LLM_NVIDIA="true|nvapi-…"       # NVIDIA NIM (build.nvidia.com); nivel gratuito ≈ 40 peticiones/min
LLM_OLLAMA="true|"              # local: la clave puede ir vacía
```

Reglas de parseo (`packages/llm/src/env.ts`):
- Se parte por el **primer** `|`. Primer valor (sin distinguir mayúsculas): `true`, `1`,
  `yes` u `on` activan; cualquier otro valor desactiva. Segundo valor: la clave, recortada.
  No hay codificación especial: si una clave contuviera `|` (ninguna conocida lo hace), se
  usa la forma separada.
- `true` con clave vacía es **error de arranque** salvo en proveedores locales (`ollama`,
  `lmstudio`, `vllm`).
- `false` con clave presente se acepta (permite apagar sin borrar la clave) y registra un
  aviso.
- Ausente = desactivado.
- **Forma separada** para gestores de secretos: `LLM_ANTHROPIC_ENABLED=true` y
  `LLM_ANTHROPIC_API_KEY=…`. Si existen ambas formas y **discrepan**, es error de arranque
  (nunca se desactiva una clave en silencio).
- Ajustes opcionales aparte: `LLM_<P>_BASE_URL`, `LLM_<P>_ORG`, `LLM_<P>_TIMEOUT_MS`
  (espera hasta el primer byte), `LLM_<P>_MAX_CONCURRENCY`, `LLM_<P>_RPM` (peticiones por
  minuto; NVIDIA 40 por defecto), `LLM_<P>_EXTRA_MODELS`.
- Variables de instancia que solo comparten prefijo (`IMAGES_FROM_WEB_SEARCH`) nunca se
  informan como variables desconocidas.

Lo mismo para medios: `IMAGE_OPENAI`, `IMAGE_GOOGLE`, `IMAGE_FAL`, `IMAGE_REPLICATE`,
`IMAGE_STABILITY`, `STOCK_UNSPLASH`, `STOCK_PEXELS`, `STOCK_PIXABAY`.

Al arrancar, el engine imprime la tabla de proveedores (`enabled`, `disabled`,
`misconfigured`) y la asignación por rol, sin claves. Un `misconfigured` impide arrancar.

## 2. Registro de proveedores

```ts
type ProviderId = "anthropic" | "openai" | "google" | "zai" | "qwen" | "deepseek" | "moonshot"
  | "minimax" | "mistral" | "xai" | "groq" | "together" | "fireworks" | "openrouter"
  | "nvidia" | "ollama" | "lmstudio" | "vllm";

interface ProviderDefinition {
  id: ProviderId; displayName: string;
  adapter: "anthropic" | "openai-responses" | "google" | "openai-compatible";
  adapterReady: boolean;                        // false → el router lo salta con un aviso
  family?: "anthropic" | "openai" | "google" | "glm" | "qwen" | "deepseek" | "kimi" | "minimax"
    | "mistral" | "llama" | "grok" | "gpt-oss" | "nemotron";
  defaultBaseUrl?: string; local: boolean;
  appendFamilyNote: boolean;                    // agregadores y locales
  models: ModelDefinition[]; quirks: ProviderQuirks;
  limits: { rpm?: number; maxConcurrency?: number; firstByteTimeoutMs: number; idleTimeoutMs: number };
  verifiedAt: string; verifiedFrom: string;
}

interface ModelDefinition {
  id: string; tier: "frontier" | "strong" | "fast" | "local";
  family: ProviderDefinition["family"];        // para las notas de familia en agregadores/locales
  contextTokens: number; maxOutputTokens: number;
  price: PriceFn;                               // función (tokens, hora UTC, cache) → USD; tramos, pico/valle, cache-write
  capabilities: {
    nativeTools: boolean; parallelTools: boolean; forcedToolChoice: boolean;
    jsonSchema: boolean; vision: boolean;
    thinking: "none" | "optional" | "always";
    reasoningEcho: "none" | "thinking-blocks" | "reasoning_content" | "thought_signature" | "encrypted" | "reasoning_details";
    streamingToolCalls: boolean;
  };
  verifiedAt: string; verifiedFrom: string;    // fecha y URL; sin esto no entra en el catálogo
}
```

Capacidad que no se pudo verificar = `false`; contexto dudoso = el valor conservador; precio
sin publicar = cota superior con `priceNote`. `LLM_<P>_EXTRA_MODELS` añade modelos
(visión y herramientas nativas `false` salvo que se declaren, precio 0) y, con un `id` ya
catalogado, corrige ese modelo campo a campo. El código vive en
`packages/llm/src/catalog/`: `providers/nvidia.ts`, `providers/first-party.ts` (proveedores
de la investigación `research/03 §A.2`) y `providers/local.ts` (sin modelos: solo
`EXTRA_MODELS`).

**Adaptadores en la v1: cuatro** (`anthropic`, `openai-responses`, `google`,
`openai-compatible`). Los 18 proveedores son entradas de catálogo sobre esos cuatro; los
`providerOptions` específicos (Z.ai `thinking`/`tool_stream`, Qwen `enable_thinking`,
DeepSeek `thinking`, Kimi `reasoning_effort`, Mistral `prompt_mode`, OpenRouter
`reasoning`, etc.) se declaran por proveedor en `quirks.extraBody`. Escape a SDKs crudos en
`packages/llm/src/raw/`.

**Estado (fase 2).** Implementado: `openai-compatible` (`fetch` sin SDK), que sirve a
`nvidia`, `zai`, `qwen`, `deepseek`, `moonshot`, `minimax`, `mistral`, `groq`, `together`,
`fireworks`, `openrouter`, `ollama`, `lmstudio` y `vllm`. Pendientes (`adapterReady: false`):
`anthropic` (Messages), `openai` y `xai` (`openai-responses`: xAI siempre devuelve
razonamiento cifrado y OpenAI solo combina herramientas y razonamiento en Responses) y
`google` (nativo, `thought_signature`). Un proveedor pendiente activado en `.env` no impide
arrancar: el gateway lo salta y registra una vez "provider `anthropic` is enabled but its
adapter arrives later; it is skipped". El eco de `reasoning_details` de OpenRouter llega con
el trabajo de agregadores; hasta entonces su catálogo va vacío (`EXTRA_MODELS`).

Para agregadores y locales (`nvidia`, `groq`, `openrouter`, `together`, `fireworks`,
`ollama`, `lmstudio`, `vllm`), el ensamblador de prompts añade las notas del adaptador del
proveedor **y** las de la `family` del modelo (`docs/prompts/providers/<family>.md`), en ese
orden; `promptNotesFor("nvidia", glm)` → `["nvidia", "zai"]`. Las familias sin nota propia
(`llama`, `gpt-oss`, `nemotron`) solo llevan la del proveedor.

### 2.1 NVIDIA NIM

Base `https://integrate.api.nvidia.com/v1`, Bearer. Modelos del catálogo (todos presentes
en `GET /v1/models`, capturado el 2026-09-28): `z-ai/glm-5.3` (frontier, herramientas
nativas verificadas), `z-ai/glm-5.3-flash` (fast, herramientas inferidas de la misma
familia), `moonshotai/kimi-k3`, `moonshotai/kimi-k2.6`, `deepseek-ai/deepseek-v4.1-flash`,
`openai/gpt-oss-20b`, `nvidia/nemotron-3-super-120b-a12b` y
`meta/llama-3.2-90b-vision-instruct` (única con visión). Contexto 131 072 en todos, precio 0
(nivel gratuito: limitado por peticiones, no facturado). Comportamiento observado: el tool
call llega **completo en un solo delta** con `finish_reason: "tool_calls"`; GLM-5.3 emite
`reasoning_content` antes del texto; el uso llega en un chunk con `choices: []` e incluye
`prompt_tokens_details.cached_tokens`; un historial sin `reasoning_content` se acepta.
Latencia: **131 s hasta el primer byte** y 178 s hasta completar en el endpoint gratuito,
de ahí el tiempo de espera de 300 s. Capturas en `packages/llm/test/fixtures/nvidia/`.

## 3. Router: rol → modelo

```dotenv
AGENT_DIRECTOR_MODEL=anthropic:claude-fable-5-1
AGENT_DIRECTOR_FALLBACKS=anthropic:claude-opus-5-5,openai:gpt-6-sol
AGENT_DIRECTOR_EFFORT=high
AGENT_FRONTEND_MODEL=anthropic:claude-opus-5-5
AGENT_FRONTEND_FALLBACKS=zai:glm-5.3,qwen:qwen3-coder-next
AGENT_FRONTEND_TOOL_PROTOCOL=auto
AGENT_FRONTEND_MAX_OUTPUT_TOKENS=32000
```

**Asignación automática** cuando falta la variable de un rol. Cada rol declara en
`packages/agents/src/roles/<rol>.ts`:

```ts
modelRequirements: {
  capabilities: ["nativeTools" | "jsonSchema" | "vision" | ...],   // obligatorias
  minContextTokens: number,
  preferredTier: "frontier" | "strong" | "fast",
  maxPricePer1MOutput?: number,                                     // techo opcional
  differentFamilyThan?: AgentRole[],                                // reviewer ≠ implementadores
}
```

El router filtra los modelos de los proveedores activos por requisitos, ordena por
cercanía al tier preferido y precio, y elige; los siguientes son fallbacks. Si ningún
modelo activo satisface un rol, el engine **no arranca** y dice exactamente qué falta
("role `designer` needs `vision`; enabled providers: groq"). Así "una clave basta" es
verdad para proveedores completos (Anthropic, OpenAI, Google, Z.ai, Qwen, DeepSeek,
Moonshot, MiniMax, Mistral, xAI, OpenRouter) y explícitamente falso, con mensaje claro,
para configuraciones solo-Groq o solo-Ollama sin modelo con visión. La asignación se
imprime al arrancar y se expone en `GET /v2/system/models`.

Orden de la asignación automática: filtro por requisitos (capacidades, contexto, techo de
precio), luego cercanía de tier, precio de salida por 1M, tier más alto en empate y orden del
catálogo; los dos siguientes son fallbacks. `differentFamilyThan` es **preferencia**: si
ningún modelo de otra familia cumple, se usa la misma con un aviso (con solo NVIDIA, el
`reviewer` comparte familia GLM). Con solo `LLM_NVIDIA`: director, frontend, backend y
database → `nvidia:z-ai/glm-5.3`; fixer y summarizer → `nvidia:z-ai/glm-5.3-flash`; un rol
que pida `nativeTools` + `vision` no tiene modelo (la visión solo está en Llama 3.2 Vision,
sin herramientas verificadas).

Reglas: validación zod al arrancar (un `AGENT_*` mal formado es `LlmConfigError`; un
`AGENT_<X>_MODEL` con rol desconocido, aviso); modelo en proveedor desactivado, pendiente o
fuera de catálogo → aviso y primer fallback válido (si no queda ninguno, asignación
automática); degradación tras 3 errores transitorios seguidos (429, 5xx, timeout) con 60 s
de enfriamiento, en los que el modelo pasa al final de la cadena; `effort` genérico
traducido por adaptador; las pistas de la UI (`model`, `effort`, `fastMode`) nunca fallan la
petición (→ `warnings[]`); `AGENT_<ROL>_MAX_OUTPUT_TOKENS` por rol (defecto 16K; 32K para
implementadores) y presupuesto comprobado con la **salida esperada** (media móvil por rol,
tope en `maxOutputTokens`), no con el máximo teórico del modelo.

### 3.1 Reintentos, límite de peticiones y tiempos de espera

- Cadena por petición: `req.model` si viene fijado, luego el modelo del rol y sus fallbacks.
  429/5xx → hasta 2 reintentos en el mismo modelo (espera `Retry-After`, tope 120 s, o
  2 s · 2ⁿ); timeout y demás errores → siguiente modelo; `aborted` y `budget` cortan.
  **Nunca se reintenta si ya salió contenido** al llamante: se lanza el error.
- Límite propio por proveedor: ventana deslizante de `LLM_<P>_RPM` peticiones por 60 s
  (NVIDIA 40 por defecto) y `LLM_<P>_MAX_CONCURRENCY`. Quien lo supera **espera en cola**
  (FIFO), nunca falla. El hueco se libera al acabar el stream y durante las esperas de
  reintento.
- Dos tiempos de espera: hasta el primer byte del cuerpo (`LLM_<P>_TIMEOUT_MS`; 300 s en
  NVIDIA, 180 s en el resto de alojados, 600 s en locales) y entre chunks (120 s; 300 s en
  locales). Cualquiera aborta la petición con `LlmError("timeout")`.
- Errores: `LlmError { code: "auth" | "rate_limited" | "unavailable" | "bad_request" |
  "context_length" | "budget" | "aborted" | "timeout"; retryable; provider?; model?; status?;
  retryAfterMs? }`. 401/403 auth; 402 unavailable no reintentable (créditos agotados);
  404 bad_request; 408 timeout; 413 y 400 con texto de contexto → context_length; 429
  rate_limited; 5xx unavailable reintentable; fallo de red → unavailable reintentable.

### 3.2 API del gateway

```ts
const gateway = createLlmGateway({ env: process.env, requirements, logger });
gateway.report;                          // informe de env serializable, sin claves
gateway.assignments();                   // RoleAssignment[] (GET /v2/system/models)
gateway.assertRolesSatisfiable(roles);   // LlmConfigError con el mensaje exacto
gateway.roleSettings(role);              // effort, maxOutputTokens, toolProtocol
gateway.providerSummaries();             // proveedores LLM con adapterReady y modelos
gateway.warnings();                      // avisos no fatales de configuración
gateway.generate(req);                   // AsyncIterable<GenerateEvent>, empieza por `route`
```

## 4. Bucle de generación uniforme

```ts
interface GenerateRequest {
  role: AgentRole; system: string; messages: AgentMessage[];
  tools: ToolDefinition[]; effort?: Effort; maxOutputTokens: number;
  abortSignal: AbortSignal; budget: BudgetHandle;
}
type GenerateEvent =
  | { type: "route"; provider: string; model: string; attempt: number }   // siempre el primero
  | { type: "text-delta"; text: string } | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "usage"; input: number; output: number; cachedInput: number; cacheWrite: number; costUsd: number }
  | { type: "finish"; reason: "stop" | "tool-calls" | "length" | "refusal" | "error" }
  | { type: "provider-message"; raw: unknown };
```

`route` abre cada generación; otro `route` (con `attempt` mayor) solo llega antes de
cualquier otro evento de ese intento, así que nunca hay que descartar nada ya recibido.
`usage.input` son los tokens de entrada **no cacheados** (`cachedInput` aparte); `output`
incluye el razonamiento. `costUsd` sale del `price` del catálogo (0 en NVIDIA) o del
`usage.cost` del proveedor (OpenRouter); el gateway lo carga en `budget.charge()` y rechaza
la llamada con `LlmError("budget")` si `budget.remainingUsd() <= 0` antes de empezarla.
En `native` del mensaje del asistente van `provider` y `model` del evento `route`; el
adaptador lo reenvía tal cual solo si coinciden con el modelo de la nueva petición.

Invariantes:
1. El mensaje del asistente se guarda **nativo** y se devuelve idéntico (bloques de
   thinking, `thought_signature`, `reasoning_content`, razonamiento cifrado,
   `reasoning_details`). Cambio de modelo a mitad de tarea → reconstrucción desde texto y
   tool calls + evento `context.rebuilt`.
2. Argumentos de tool call validados con zod antes de ejecutar; inválidos → error como
   resultado de la herramienta.
3. `tool_choice` siempre `auto`. La terminación se pide en el prompt (`submit_*`) y el
   orquestador reintenta un turno de recordatorio (`03 §1`).
4. Sin `temperature`/`top_p` por defecto (solo `imagery` y `copywriter`, en modelos que lo
   aceptan).
5. Streaming siempre; `tool_stream`/`eager_input_streaming` por adaptador; deltas
   malformados → un reintento sin streaming de herramientas.
6. Límite de salida mapeado al parámetro correcto del proveedor.
7. **Compactación**: al superar `AGENT_CONTEXT_SOFT_LIMIT` (60 % del contexto), el
   `summarizer` resume los turnos antiguos; el resumen se inserta como mensaje de rol
   **`user`** (los proveedores rechazan `system` intermedio) marcado `[context summary]`, y
   el **último turno del asistente se conserva nativo** para no perder bloques de
   razonamiento. Evento `context.compacted`.

## 5. Protocolo de herramientas: nativo y XML

Igual que antes: nativo cuando `nativeTools`; XML (`<tool name="…">…</tool>`, un bloque por
turno, `stop: ["</tool>"]`) cuando no o cuando `AGENT_<ROL>_TOOL_PROTOCOL=xml`; `auto` cae a
XML tras dos errores de formato seguidos. SEARCH/REPLACE dentro de `edit_file` solo en
modelos `fast`/`local`. **En la v1 el adaptador XML se implementa pero solo se activa para
modelos locales**; el resto usa nativo.

## 6. Contabilidad y presupuestos (`ledger`)

`llm_calls` por llamada (run, tarea, rol, proveedor, modelo, tokens de entrada, salida,
cacheados, escritura de caché, coste por `PriceFn`, latencia, TTFT, resultado). OpenRouter
devuelve el coste en `usage`: se usa tal cual.

```dotenv
BUDGET_PER_RUN_USD=8            # reparto: 65 % tareas del plan, 25 % verificación/revisión/arreglos, 10 % cierre
BUDGET_PER_PROJECT_MONTH_USD=60
BUDGET_GLOBAL_MONTH_USD=
```

Los presupuestos por tarea los deriva el orquestador del peso del plan; no hay
`BUDGET_PER_TASK_USD`. Al 80 % del run: `budget.warning`. Al 90 %: se cancelan tareas
pendientes y la reserva de cierre (10 %) paga integración mínima, puertas y el mensaje
`limit-reached`. Los valores por defecto se recalibran con las mediciones de la fase 3
(`08`). Presupuesto de proyecto o global agotado antes de empezar → `INSUFFICIENT_CREDITS`
(la UI abre su modal, que enlaza a la página de presupuestos `/project/:id/budget`).

## 7. Proveedores de medios (`packages/media`)

`@forja/media` implementa `ImageSourcingPort` (`@forja/contracts/media`), que el engine
inyecta en el runtime como `ctx.imageSourcing` y usa la herramienta `image_find` (`11`).
El agente pide **un slot** (`slot`, `query` en inglés, `alt` en el idioma de la app,
`orientation?`, `minWidth?`) y recibe un fichero dentro del proyecto y su atribución; nunca
sabe ni decide si la imagen se buscó o se generó.

**Estrategia (`images.mode`).** `IMAGES_FROM_WEB_SEARCH=true` (`09`) significa: **nunca**
usar un modelo de generación de imágenes, buscar en la web. Es el valor por defecto de la
instancia; la UI (modal Settings) puede sobrescribirlo, se guarda en la tabla `settings`
(clave `images.mode`) y **gana hasta que se restablece** (`DELETE
/v2/system/settings/images`, `05 §3`). Modo `generate`: usa un generador `IMAGE_*` si hay
uno activo **y con adaptador**; si no, cae a búsqueda web y lo registra en el log
(`generationAvailable: false` en la respuesta). Hoy no hay adaptadores de generación: la
interfaz `ImageGenerator` existe para añadirlos sin tocar a los llamadores. (El modelo
actual del operador, GLM 5.3 en NVIDIA, no genera imágenes; por eso existe el interruptor.)

**Búsqueda web, en orden.** Proveedores `STOCK_*` activos con clave (Pexels, Unsplash,
Pixabay; mejores fotos), después **Openverse** y **Wikimedia Commons**, ambos sin clave. Se
pregunta proveedor a proveedor y se para en el primero que da una imagen buena y
descargable, así las cuotas gratuitas se gastan de una en una; las respuestas se cachean
una hora por consulta. Solo licencias que permiten uso comercial y modificación: CC0,
Public Domain Mark / dominio público, CC BY, CC BY-SA (nunca NC ni ND), o la licencia
propia del proveedor de stock. Openverse (anónimo: 20/min, 200/día) y el resto tienen un
limitador local que **no espera**: con la cuota agotada o tras un 429 (`Retry-After`), el
proveedor se salta hasta que se enfría. User-Agent descriptivo en todas las peticiones
(Wikimedia lo exige). Unsplash exige llamar a su endpoint de descarga y atribuir: el
adaptador lo hace solo para la foto elegida; si el operador prefiere no depender de esos
términos, lo deja desactivado.

**Ranking sin visión**, determinista: orientación pedida, anchura mínima (por defecto
1000 px), tamaño (hasta 2× el mínimo) y relevancia de título/etiquetas/descripción frente a
la consulta; empates por el orden del propio proveedor.

**Descarga segura** (`07`): solo https; guardia SSRF en cada salto (resolución DNS, rangos
privados, link-local/metadatos, IPv4 mapeada, NAT64, nombres internos); redirecciones
manuales re-comprobadas (máx. 3); timeout; ≤ 8 MB; tipo por bytes mágicos (JPEG, PNG,
WebP, AVIF, GIF; **nunca SVG**) y dimensiones leídas de la cabecera sin dependencias
nativas. Escribe `public/images/<slot>.<ext>` y mantiene `public/images/credits.json`
(`[{slot, path, alt, attribution}]`, una entrada por slot, reemplazada al volver a buscar)
para que la app muestre los créditos.

**Coste.** Cada petición a un proveedor se notifica por `onCall` con la forma de
`media_calls` (búsqueda: coste 0). `image_generate` (cuando exista un adaptador) generará
**como máximo 2 candidatos por slot** y solo compara con modelos con visión; sin visión,
uno; su coste va contra el presupuesto del run.

## 8. Medidas y salud

Por llamada: TTFT, tokens/s, reintentos, degradaciones. Por run: coste por rol y modelo,
tool calls, rondas. `GET /v2/system/models`: estado por proveedor.

## 9. Cómo añadir un proveedor

1. Id en `LLM_PROVIDER_IDS` (`src/env.ts`) y definición en `packages/llm/src/catalog/providers/`
   con modelos verificados (`verifiedAt`, `verifiedFrom`), `quirks` y `limits`.
2. Adaptador de los cuatro (`adapterReady: true` solo cuando existe); opciones de
   proveedor en `quirks.extraBody`.
3. `docs/prompts/providers/<id>.md`.
4. Variable en `09` y `.env.example`.
5. Capturas reales en `packages/llm/test/fixtures/<id>/` y tests que las reproducen.
6. A mano, nunca en CI: `npm run llm:smoke -- --provider <id> [--model <id>] [--tools]
   [--env-file infra/.env] --yes-spend-one-request`. Hace **exactamente una** petición
   (máx. 256 tokens de salida, sin reintentos ni fallbacks) e imprime ruta, latencia,
   motivo de fin, uso y tool call. Sin `--yes-spend-one-request` se niega a correr.
