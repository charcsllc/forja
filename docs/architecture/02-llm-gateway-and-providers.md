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
- Ajustes opcionales aparte: `LLM_<P>_BASE_URL`, `LLM_<P>_ORG`, `LLM_<P>_TIMEOUT_MS`,
  `LLM_<P>_MAX_CONCURRENCY`, `LLM_<P>_EXTRA_MODELS`.

Lo mismo para medios: `IMAGE_OPENAI`, `IMAGE_GOOGLE`, `IMAGE_FAL`, `IMAGE_REPLICATE`,
`IMAGE_STABILITY`, `STOCK_UNSPLASH`, `STOCK_PEXELS`, `STOCK_PIXABAY`.

Al arrancar, el engine imprime la tabla de proveedores (`enabled`, `disabled`,
`misconfigured`) y la asignación por rol, sin claves. Un `misconfigured` impide arrancar.

## 2. Registro de proveedores

```ts
type ProviderId = "anthropic" | "openai" | "google" | "zai" | "qwen" | "deepseek" | "moonshot"
  | "minimax" | "mistral" | "xai" | "groq" | "together" | "fireworks" | "openrouter"
  | "ollama" | "lmstudio" | "vllm";

interface ProviderDefinition {
  id: ProviderId; displayName: string;
  adapter: "anthropic" | "openai-responses" | "google" | "openai-compatible";
  family?: "anthropic" | "openai" | "google" | "glm" | "qwen" | "deepseek" | "kimi" | "minimax" | "mistral" | "llama";
  defaultBaseUrl?: string; local: boolean;
  models: ModelDefinition[]; quirks: ProviderQuirks;
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

**Adaptadores en la v1: cuatro** (`anthropic`, `openai-responses`, `google`,
`openai-compatible`). Los 17 proveedores son entradas de catálogo sobre esos cuatro; los
`providerOptions` específicos (Z.ai `thinking`/`tool_stream`, Qwen `enable_thinking`,
DeepSeek `thinking`, Kimi `reasoning_effort`, Mistral `prompt_mode`, OpenRouter
`reasoning`, etc.) se declaran por proveedor en `quirks`. Escape a SDKs crudos en
`packages/llm/src/raw/`.

Para agregadores y locales (`openrouter`, `together`, `fireworks`, `ollama`, `lmstudio`,
`vllm`), el ensamblador de prompts añade las notas del adaptador del proveedor **y** las de
la `family` del modelo (`docs/prompts/providers/<family>.md`), en ese orden.

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

Reglas: validación zod al arrancar; modelo en proveedor desactivado → aviso y primer
fallback válido; degradación tras N errores 5xx/429 con enfriamiento; `effort` genérico
traducido por adaptador; las pistas de la UI (`model`, `effort`, `fastMode`) nunca fallan la
petición (→ `warnings[]`); `AGENT_<ROL>_MAX_OUTPUT_TOKENS` por rol (defecto 16K; 32K para
implementadores) y presupuesto comprobado con la **salida esperada** (media móvil por rol,
tope en `maxOutputTokens`), no con el máximo teórico del modelo.

## 4. Bucle de generación uniforme

```ts
interface GenerateRequest {
  role: AgentRole; system: string; messages: AgentMessage[];
  tools: ToolDefinition[]; effort?: Effort; maxOutputTokens: number;
  abortSignal: AbortSignal; budget: BudgetHandle;
}
type GenerateEvent =
  | { type: "text-delta"; text: string } | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  | { type: "usage"; input: number; output: number; cachedInput: number; cacheWrite: number; costUsd: number }
  | { type: "finish"; reason: "stop" | "tool-calls" | "length" | "refusal" | "error" }
  | { type: "provider-message"; raw: unknown };
```

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

Como antes (búsqueda: Pexels, Pixabay, Unsplash; generación: OpenAI Images, Imagen, fal,
Replicate, Stability; placeholders locales sin proveedores). Unsplash exige llamar a su
endpoint de descarga y atribuir: el adaptador lo hace y lo registra en el manifest; si el
operador prefiere no depender de esos términos, lo deja desactivado. `image_generate`
genera **como máximo 2 candidatos por slot** y solo compara con modelos con visión; sin
visión, uno. Coste en `media_calls` contra el presupuesto del run.

## 8. Medidas y salud

Por llamada: TTFT, tokens/s, reintentos, degradaciones. Por run: coste por rol y modelo,
tool calls, rondas. `GET /v2/system/models`: estado por proveedor.

## 9. Cómo añadir un proveedor

1. Definición en `packages/llm/src/catalog/<id>.ts` con modelos verificados (`verifiedAt`,
   `verifiedFrom`) y `quirks`.
2. Adaptador de los cuatro; `providerOptions` en `quirks`.
3. `docs/prompts/providers/<id>.md`.
4. Variable en `09` y `.env.example`.
5. `npm run llm:smoke -- <id>`: una llamada con herramienta en streaming y un segundo
   turno que comprueba el eco del razonamiento.
