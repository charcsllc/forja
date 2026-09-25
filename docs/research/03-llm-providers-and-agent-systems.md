# Investigación 3: proveedores LLM y sistemas de agentes de código (2026-09-25)

Leyenda: ✔ verificado contra la documentación oficial en esta sesión; ~ fuente secundaria,
verificar antes de fijar en código; ✗ no verificado, conocimiento previo. Las cadenas exactas
(IDs de modelo, URLs) deben confirmarse contra la página viva antes de entrar en código.

## A. Catálogo de proveedores

### A.1 Endpoints y auth

| Proveedor | Base URL | Auth | OpenAI-compatible | SDK / notas |
|---|---|---|---|---|
| Anthropic | `https://api.anthropic.com/v1/messages` ✗ | `x-api-key` + `anthropic-version: 2023-06-01` ✗ | capa compat limitada, no usar para agentes | `@anthropic-ai/sdk` 0.128.0 ✔ |
| OpenAI | `https://api.openai.com/v1` ✗ | Bearer | Chat Completions **y** Responses | `openai` 7.23.0 ✔ |
| Google Gemini | nativo `https://generativelanguage.googleapis.com/v1beta` ✗; compat `…/v1beta/openai/` ✔ | `x-goog-api-key` ✗ / Bearer ✔ | sí (beta; params desconocidos ignorados) | `@google/genai` ✗ |
| Z.ai (internacional) | `https://api.z.ai/api/paas/v4` ✔; coding plan `https://api.z.ai/api/coding/paas/v4` ✔; estilo Anthropic `https://api.z.ai/api/anthropic` ✔ | Bearer ✔ | sí | `zhipu-ai-provider` 0.4.0 ✔ |
| Zhipu (China) | `https://open.bigmodel.cn/api/paas/v4` ~; coding `…/api/coding/paas/v4` ~ | Bearer ~ | sí | igual |
| Alibaba Qwen (Model Studio) | **nuevo, por workspace** ✔: `https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` (SG), `…cn-beijing…`, `us-east-1`. **Legacy** ~: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, `https://dashscope.aliyuncs.com/compatible-mode/v1` | Bearer | sí; también endpoint estilo Anthropic ~ | `@ai-sdk/alibaba` 2.0.54 ✔ |
| DeepSeek | `https://api.deepseek.com` ✔; estilo Anthropic `…/anthropic` ✔ | Bearer | sí; también Responses ✔ | `@ai-sdk/deepseek` 3.0.52 ✔ |
| Moonshot Kimi | `https://api.moonshot.ai/v1` ~ (China `api.moonshot.cn` ✗); docs en `platform.kimi.ai` ✔ | Bearer | sí | `@ai-sdk/moonshotai` 3.0.56 ✔ |
| MiniMax | `https://api.minimax.io/v1` ~; estilo Anthropic `…/anthropic` ~ (China `api.minimaxi.com` ✗) | Bearer | sí (recomiendan el SDK Anthropic ~) | sin provider oficial ✗ |
| Mistral | `https://api.mistral.ai/v1` ✔ (Codestral FIM `codestral.mistral.ai` ✗) | Bearer ✔ | sí | `@ai-sdk/mistral` 4.0.50 ✔ |
| xAI | `https://api.x.ai/v1` ~ | Bearer | sí; Responses recomendado; compat Anthropic **deprecada** ~ | `@ai-sdk/xai` 5.0.8 ✔ |
| Groq | `https://api.groq.com/openai/v1` ✔ | Bearer | sí | `@ai-sdk/groq` 4.0.48 ✔ |
| Together | `https://api.together.xyz/v1` ✗ | Bearer | sí | `@ai-sdk/togetherai` 3.0.56 ✔ |
| Fireworks | `https://api.fireworks.ai/inference/v1` ~; IDs `accounts/fireworks/models/<name>` ~ | Bearer | sí | `@ai-sdk/fireworks` 3.0.58 ✔ |
| OpenRouter | `https://openrouter.ai/api/v1` ✗ (`/chat/completions` ✔) | Bearer; opcional `HTTP-Referer`, `X-Title` ✗ | sí, normalizado ✔ | `@openrouter/ai-sdk-provider` 3.1.0 ✔ |
| Ollama | `http://localhost:11434/v1/` ✔ (clave requerida pero ignorada); Cloud `https://ollama.com/v1` ✔ | dummy | sí | `ollama-ai-provider-v2` 4.0.1 ✔ |
| LM Studio | `http://localhost:1234/v1` ✔ | ninguna | sí (+ `/v1/messages` estilo Anthropic ✔) | — |
| vLLM | `http://host:8000/v1` ✗ | `--api-key` opcional ✗ | sí | — |

Vercel AI SDK core es **`ai@7.0.114`** ✔. Otros: `@ai-sdk/openai-compatible` 3.0.55, `@ai-sdk/anthropic` 4.0.63,
`@ai-sdk/openai` 4.0.75, `@ai-sdk/google` 4.0.80, `bullmq` 6.3.8, `pg-boss` 12.34.0, `testcontainers` 12.1.0, `dockerode` 5.0.1 ✔.

### A.2 Modelos, contexto y precio (USD por 1M tokens, entrada / salida)

**Anthropic** ✔
- `claude-fable-5-1`: 1M ctx, 128K salida, $10 / $50. Thinking siempre activo (adaptativo); control solo `output_config.effort` (`low|medium|high|xhigh|max`). **`tool_choice` forzado (`any`/`tool`) → 400.**
- `claude-opus-5-5`: 1M / 128K, $4 / $20. Thinking siempre activo, effort por defecto `medium`. `tool_choice` forzado → 400. Anthropic recomienda empezar aquí.
- `claude-sonnet-5`: 1M / 128K, $2 / $10. Thinking adaptativo, desactivable.
- `claude-haiku-4-5-20251001` (alias `claude-haiku-4-5`): 200K / 64K, $1 / $5. Thinking antiguo (`thinking:{type:"enabled",budget_tokens}`), sin `effort`. Retiro no antes de **2026-10-15**: planificar sustituto.
- Legacy servidos: `claude-opus-5` ($5 / $25), `claude-fable-5`.
- Gotchas: `system` top-level; `max_tokens` obligatorio; `budget_tokens`, `temperature`, `top_p` → 400 en 5.x; prefill → 400; thinking oculto salvo `thinking:{type:"adaptive",display:"summarized"}`; bloques de thinking deben devolverse intactos (historial append-only); `eager_input_streaming:true` en herramientas con inputs grandes; salida estructurada con `output_config.format` o `strict:true`; manejar `stop_reason:"refusal"`.

**OpenAI** ✔
- `gpt-6-astra`: 1,05M / 128K, $10 / $50. `gpt-6-sol`: "complex coding and agentic workflows", 1,05M / 128K, $2 / $10 (cache $0,20); effort `none|low|medium|high|xhigh|max`; por encima de 272K de entrada el precio se dobla. `gpt-6-luna` $0,10 / $0,50. Anteriores: `gpt-5.6-sol` $4 / $20, `gpt-5.6-terra` $2 / $12, `gpt-5.5` $5 / $30, `gpt-5.3-codex` $1,75 / $14.
- **Gotcha ✔:** en `gpt-6-sol` por Chat Completions, **las funciones solo funcionan con `reasoning_effort:"none"`**. Herramientas con razonamiento → **Responses API**.
- Nombres ✗: Chat usa `max_completion_tokens`; Responses `max_output_tokens` y `reasoning:{effort}`; sistema = `instructions` o rol `developer`. Estructurado: `response_format:{type:"json_schema",…,strict:true}` o `text.format`.

**Google Gemini** ✔
- `gemini-3.8-flash` (sept 2026): 1.048.576 / 65.536, thinking `low|medium|high`, tools, salida estructurada, caching, ejecución de código; recomendado para "long-horizon software engineering"; $0,75–1,50 / $3,75–7,50 por tramo. `gemini-3.1-pro-preview` $2–4 / $12–18. `gemini-3.5-flash` $1,50 / $9; `gemini-3.5-flash-lite` $0,30 / $2,50.
- Compat OpenAI: `reasoning_effort` → `thinking_level`; no enviar ambos. **Gotcha ~:** Gemini 3 exige **replay literal de `thought_signature`** en turnos con herramientas (`tool_calls[].extra_content.google.thought_signature`); si se pierde → `400 "Function call is missing a thought_signature"`. Preferir `@ai-sdk/google` nativo.

**Z.ai / Zhipu GLM** ✔
- `GLM-5.3`, `GLM-5.2`, `GLM-5.1`, `GLM-5`, `GLM-4.7`, `GLM-4.6`, `GLM-4.5*`, `GLM-5.3-flash`, `GLM-5.3-flashx`. Salida máx 128K (`max_tokens` 1–131072). Contexto GLM-5.3 1M ~.
- Precios: GLM-5.3/5.2 $1,40 / $4,40 (cache $0,26); 5.3-Flash $0,15 / $0,50; 5.3-FlashX $0,37 / $1,25; GLM-4.7-Flash y 4.5-Flash gratis.
- Thinking `thinking:{type:"enabled"|"disabled", clear_thinking:true}`; **GLM-5.3 no puede desactivarlo**; profundidad `reasoning_effort: low|high|max` (defecto `max`).
- Tools: máx 128; **`tool_choice` solo `"auto"`**; **`tool_stream:true`** para deltas de tool-call. JSON solo `json_object`. La clave de coding plan solo vale en `/coding/paas/v4` o `/anthropic` ~.

**Alibaba Qwen** ✔/~
- Comerciales ✔: `qwen3.8-max`, `qwen3.7-plus`, `qwen3.8-flash`. Coder ✔: `qwen3-coder-next`, `qwen-coder-turbo` (`qwen3-coder-plus` aún en docs de terceros ~).
- Precios ~: qwen3.8-max ≈ $2 / $6 (1M ctx, 131K salida); qwen3.7-plus ≈ $0,32 / $1,28 (1M).
- Thinking ✔: `enable_thinking` (vía `extra_body`) y `thinking_budget` (1–32768); activo por defecto en qwen3.6+; razonamiento en `reasoning_content`. Algunos modelos abiertos solo aceptan `stream:true` ✔. **≤20 herramientas por llamada** ✔. Base URL migrando a hosts por workspace: hacerla variable de entorno.

**DeepSeek** ✔
- `deepseek-flash` (V4.1-Flash, visión) y `deepseek-v4-pro` (V4-Pro-0813): 1M ctx, 384K salida, JSON, tools, FIM (sin thinking). Precios pico/valle: flash $0,15–0,30 / $0,60–1,20; pro $0,66–1,32 / $1,98–3,96 (pico 01–04 y 06–10 UTC laborables).
- Thinking activo por defecto; `thinking:{type}` (OpenAI) o `reasoning:{effort}` (Anthropic). **Gotcha:** con tools hay que **devolver todo `reasoning_content` previo** o 400. En thinking, `temperature` y penalties ignorados, `top_p` ≥0,95. IDs antiguos `deepseek-chat`/`deepseek-reasoner` ya no aparecen ✗.

**Moonshot Kimi** ✔/~
- `kimi-k3`: 1.048.576 ctx, $3 (cache $0,30) / $15; thinking siempre activo vía `reasoning_effort: low|high|max` ~; `tool_choice:"required"` funciona ~. `kimi-k2.7-code`: 262.144, $0,95 / $4 (cache $0,19); `-highspeed` $1,90 / $8; `kimi-k2.6` $0,95 / $4. Conservar `reasoning_content` en cada mensaje previo del asistente ~.

**MiniMax** ✔/~
- `MiniMax-M3`: 1.000.000 ctx, multimodal, ≈ $0,60 / $2,40 (doble >512K) ~. `MiniMax-M2.7`/`-highspeed`, `M2.5`, `M2.1`, `M2`: 204.800. La familia M2 emite `<think>…</think>` en el contenido por la ruta OpenAI ✗; ruta Anthropic recomendada ~.

**Mistral** ✔
- `mistral-medium-3505` (agentic y coding), `mistral-large-2512`, `mistral-small-2603`, `codestral-2508` (FIM), `ministral-3-*`; revende `zai-glm-5-3`. Devstral ~: `devstral-2512` (262K, ≈ $0,40 / $0,90), verificar. Params ✔: `max_tokens`; `response_format` json_object|json_schema; `tool_choice` `auto|none|any|required|{function}`; `parallel_tool_calls`; `prompt_cache_key`; `reasoning_effort` `none…xhigh` con `prompt_mode:"reasoning"`.

**xAI Grok** ✔
- `grok-4.7`: 500K, $2 / $6 (≥200K: $4 / $12); `reasoning_effort` `low|medium|high|xhigh`; **siempre devuelve razonamiento cifrado** → Responses API. `grok-4.20-0309-reasoning`/`-non-reasoning`/`grok-4.20-multi-agent-0309`: 1M, $1,25 / $2,50. `grok-build-0.1`: 256K, $1 / $2. Sin `logprobs` ≥4.20.

**Groq** ✔: `openai/gpt-oss-120b`, `openai/gpt-oss-20b` ($0,075 / $0,30), `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` (131K); preview `qwen/qwen3.8-27b`, `minimaxai/minimax-m2.7`. Todos con tools; **gpt-oss sin tool calls paralelos**.

**Together** ✔: `deepseek-ai/DeepSeek-V4-Flash-0731` (1M, $0,14 / $0,28), `zai-org/GLM-5.3-Flash` (1M, $0,15 / $0,50), `deepseek-ai/DeepSeek-V4-Pro-0813` (1M, $1,32 / $3,96), `Qwen/Qwen3.5-9B`, `meta-llama/Llama-3.3-70B-Instruct-Turbo`.

**Fireworks** ~: IDs `accounts/fireworks/models/<name>`; router `kimi-k3-fast` mencionado.

**OpenRouter** ✔: esquema OpenAI normalizado con `tools`, `response_format` json_schema, SSE y coste en `usage`. `reasoning:{effort, max_tokens, exclude, enabled}`. **Hay que devolver `reasoning_details` intacto en turnos con tools.** Routing `provider.order/only/require_parameters` ✗. Comisión ≈ 5,5 % ✗.

**Local**: Ollama ✔ sin `tool_choice`, sin `logprobs`, imágenes solo base64; contexto vía `PARAMETER num_ctx` (por defecto pequeño: causa clásica de "el agente olvida sus herramientas"). LM Studio ✔ tools y estructurado. vLLM ✔ tools con `--enable-auto-tool-choice --tool-call-parser <hermes|mistral|llama3_json|pythonic|deepseek_v3|glm45|kimi_k2|…>` y a menudo `--chat-template`; `--reasoning-parser` para thinking ✗; deltas de streaming pueden traer JSON malformado sin modo estricto.

### A.3 Gotchas transversales que el gateway debe normalizar

1. **Arrastrar el estado de razonamiento entre turnos con herramientas.** Anthropic (bloques thinking), Gemini (`thought_signature`), DeepSeek y Kimi (`reasoning_content`), OpenAI y xAI (razonamiento cifrado en Responses), OpenRouter (`reasoning_details`). **Guardar el mensaje del asistente nativo del proveedor tal cual; nunca reconstruirlo desde texto.**
2. **Nombre del límite de salida:** Anthropic `max_tokens` (obligatorio); OpenAI Chat `max_completion_tokens`; Responses `max_output_tokens`; Gemini nativo `maxOutputTokens`; resto `max_tokens`.
3. **Tool choice forzado:** rechazado por Fable 5.1 y Opus 5.5 (400) y por Z.ai (solo auto); gpt-oss en Groq sin paralelas. Diseñar el bucle sobre `auto` + instrucción en el prompt.
4. **Toggles de thinking:** Anthropic `thinking` + `output_config.effort`; OpenAI `reasoning.effort`; Gemini `thinking_level`/`thinking_config`; GLM `thinking.type` + `reasoning_effort`; Qwen `enable_thinking`/`thinking_budget`; DeepSeek `thinking.type`; Kimi K3 `reasoning_effort`; Mistral `prompt_mode:"reasoning"` + `reasoning_effort`. Forzado en Fable 5.1, Opus 5.5, GLM-5.3, Kimi K3.
5. **Muestreo:** `temperature`/`top_p` rechazados en Anthropic 5.x e ignorados en DeepSeek thinking. No enviar por defecto.
6. **Prompt de sistema:** campo top-level (Anthropic), `instructions`/`developer` (OpenAI Responses), `systemInstruction` (Gemini nativo), mensaje `system` (resto).
7. **Streaming de tool calls:** Z.ai `tool_stream:true`; Anthropic `eager_input_streaming`; vLLM/Ollama deltas malformados. Validar siempre los argumentos parseados contra un esquema antes de ejecutar.

## B. Cómo están construidos los agentes de código open source (2025–2026)

| Sistema | Bucle y herramientas | Sin tools nativas | Sandbox | Notas |
|---|---|---|---|---|
| OpenHands ~ | Stream **acción → observación** event-sourced con replay determinista; tools tipadas + MCP; LLM vía LiteLLM | shim prompt-based ✗ | Contenedor Docker por sesión con servidor de ejecución dentro; workspaces `Local` → `Docker` → `RemoteAPI` | El stream de eventos es el feed de UI (WebSocket) ✗ |
| SWE-agent / mini-swe-agent ✔ | SWE-agent introdujo la "agent-computer interface"; **mini-swe-agent ≈100 líneas, solo bash, sin tool-calling, historial lineal** | un bloque bash por turno | Docker/Singularity/local ✗ | >74 % SWE-bench Verified: bash basta con modelos fuertes |
| Aider ✔ | Sin tool calls; repo-map (tree-sitter) en el prompt ✗; formatos `whole`, `diff` (SEARCH/REPLACE), `diff-fenced` (Gemini), `udiff`, `editor-diff`/`editor-whole` | protocolo de texto puro, referencia para modelos débiles | host; auto-lint y test tras editar ✗; commit por edición ✗ | **Modo architect:** modelo fuerte planifica, modelo barato "editor" emite edits |
| Cline / Roo Code ✔ | Modos Plan/Act, aprobación por paso, checkpoints ✗ | Era **protocolo XML**; Roo v3.37+ fuerza nativas y rompió backends (SGLang gpt-oss) | host VS Code | Lección: mantener fallback XML |
| Codex CLI ✔ | `shell` + `apply_patch` (gramática propia) ✗ + MCP, AGENTS.md | n/a | **A nivel de SO:** macOS Seatbelt; Linux **bwrap + seccomp** + Landlock; niveles Read-only/Auto/Full | red apagada por defecto ✗ |
| Claude Code ✔ | Read/Write/Edit/Bash/Glob/Grep/WebFetch + MCP, CLAUDE.md, hooks | solo Claude | modos de permiso; sandbox de SO ✗ | Subagentes: **contexto aislado**, `tools` y `model` por agente, **`isolation: worktree`**, hasta 20 concurrentes, anidamiento 3, resumen al volver, reanudables, "agent teams" |
| Gemini CLI ✗ | read_file, write_file, replace, glob, search_file_content, run_shell_command, web_fetch; GEMINI.md | solo Gemini | Docker/Podman o Seatbelt ✗ | — |
| Devin ~ | Un agente de contexto largo con VM completa ✗ | — | VM cloud ✗ | Argumenta contra subagentes paralelos que dividen decisiones |
| Bolt.new ~ | El LLM emite "artifacts" de fichero y shell como texto etiquetado ✗ | protocolo texto/XML ✗ | **WebContainers** (Node en WASM en el navegador) | sin coste de sandbox servidor |
| v0 ✔ | Pipeline compuesto: RAG, modelo frontera, modelo "Quick Edit", **detección de errores en streaming**, `vercel-autofixer-01` (10–40× más rápido), fixers deterministas, lint | — | sandboxes Vercel ✗ | La puerta de calidad vive en el pipeline, no en el agente |
| Lovable ~ | Agente + un contenedor de preview por proyecto ~ | — | Firecracker/gVisor ~ | — |

### B.1 Patrones extraíbles

- **Conjunto mínimo de herramientas que funciona en todos los modelos:** `read_file(path, offset?, limit?)`, `write_file(path, content)`, `edit_file(path, old_string, new_string)` (exacto; falla con 0 o >1 coincidencias), `bash(cmd, timeout)`, `grep(pattern, glob?)`, `glob/list(pattern)`, `finish(summary)`. Extras: `apply_patch` (familia OpenAI), web fetch, todo/plan.
- **Modelos sin tools nativas:** protocolo de texto parseado, una acción por turno, stop sequence tras la etiqueta de cierre. Dos formas probadas: bloques SEARCH/REPLACE (Aider) y XML (`<tool name="edit_file"><path>…</path>…</tool>`, Cline/Bolt). Mantener **ambos** adaptadores.
- **Evitar conflictos entre agentes paralelos:** (1) worktree + rama por worker, merge por el orquestador; (2) **leases de propiedad de ficheros** (globs disjuntos por tarea; la herramienta de edición rechaza escrituras fuera); (3) serializar los puntos calientes (`package.json`, lockfile, esquema y migraciones, índice de rutas) a través de un único integrador; (4) los conflictos vuelven a un agente con contexto completo (principio de Cognition).
- **Sandboxing, de menor a mayor:** host + sandbox de SO (Seatbelt, bwrap/Landlock/seccomp) → contenedor Docker por sesión → gVisor (`runsc`) → Kata/Firecracker → WebContainers.
- **Streaming a la UI:** log de eventos tipado y append-only (acción, observación, delta de tokens, inicio/fin de herramienta, estado) persistido y empujado por SSE/WebSocket con reanudación por offset. El mismo log es replay y auditoría.
- **Plan → descomponer → implementar → verificar:** el planificador escribe spec + DAG de tareas con criterios de aceptación y alcances de ficheros; los workers implementan; el verificador ejecuta puertas deterministas (typecheck, lint, build, tests, arrancar la app y sondear la preview) y devuelve fallos como observaciones con reintentos acotados; un revisor (otro modelo o contexto fresco) compara el diff con la spec.
- **Puertas de calidad:** deterministas primero (`tsc`, eslint, `next build`, unit tests, smoke Playwright, dry-run de migraciones), después revisión LLM; v0 añade autofix rápido durante el streaming.

### B.2 Patrones multiagente y cómo fallan

- **Orquestador / worker** (sistema de research de Anthropic ~): ≈15× los tokens de un chat y ≈4× los de un agente único. Funciona para trabajo **paralelizable y de lectura**. Fallos: delegación vaga → trabajo duplicado; spawning descontrolado y resultados de herramientas enormes multiplican coste; sin topes por ejecución.
- **Planificador / ejecutor** (Aider architect, v0): barato y robusto. Falla cuando el plan omite restricciones o el ejecutor "arregla" el plan en silencio. Remedio: esquema de plan estructurado y criterios de aceptación.
- **Crítico / revisor:** aprueban con demasiada facilidad (sicofancia); revisores del mismo modelo comparten puntos ciegos; los bucles de revisión oscilan. Usar otro modelo o contexto fresco, checklist atada a la spec, máximo N rondas, y puertas deterministas como verdad.
- **Implementadores paralelos sobre un mismo código** (aviso de Cognition): decisiones implícitas contradictorias (estilo, APIs, esquema). Mitigar con spec compartida o decision log que todos leen, propiedad disjunta de ficheros, un único integrador y worktrees.

## C. Recomendaciones para un stack TypeScript

### C.1 Gateway LLM

| Opción | Pros | Contras |
|---|---|---|
| **Vercel AI SDK v7 con providers de primera parte** | TypeScript nativo; una interfaz `LanguageModel`; providers oficiales para anthropic, openai (Responses), google (nativo, maneja thought signatures), deepseek, mistral, xai, groq, togetherai, fireworks, alibaba, moonshotai, más `@ai-sdk/openai-compatible` para Z.ai/MiniMax/Ollama/LM Studio/vLLM; `providerOptions` para params de vendor; streaming, tools, estructurado, helpers de bucle | Retraso en params nuevos; major anual (v6→v7 en 2026); el eco de razonamiento difiere por proveedor, probar cada uno |
| LiteLLM proxy | agnóstico de lenguaje, claves virtuales, presupuestos, fallbacks, logs de gasto | sidecar Python; **compromiso de supply-chain en PyPI en marzo 2026 (1.82.7/1.82.8)** ~; su normalización OpenAI puede perder campos de razonamiento |
| OpenRouter | una clave, cientos de modelos, `reasoning_details` normalizado | contradice "cada proveedor con su clave"; margen y salto a terceros; sin endpoints solo-China; cuantizaciones distintas |
| Propio | control total | reimplementar las rarezas de 15 proveedores (A.3) |

**Recomendación:** un `ModelRouter` propio y fino sobre **AI SDK v7**: providers `@ai-sdk/*` donde existan; `createOpenAICompatible` para Z.ai (ambos hosts), MiniMax, Ollama, LM Studio y vLLM; escape a SDKs crudos (`@anthropic-ai/sdk`, `openai` Responses) para lo que el AI SDK no cubra; OpenRouter como un proveedor más, no como gateway; sin LiteLLM salvo necesidad multi-tenant fuera de TypeScript. Guardar las partes crudas del mensaje del proveedor para el replay de razonamiento. Adaptador XML/texto para modelos `nativeTools:false`.

### C.2 Sandbox para Next.js + Postgres generados (Docker local)

- **No montar `/var/run/docker.sock` en contenedores de agente o app.** Es root en el host.
- **Recomendado:** el orquestador (proceso de host de confianza) habla con Docker vía `dockerode` y crea: un **contenedor de app por proyecto** (imagen `node:22`, volumen de workspace, usuario no root, `--cap-drop=ALL`, `no-new-privileges`, límites cpu/mem/pids, root de solo lectura + tmpfs, sin montajes de host salvo el volumen); un Postgres por proyecto (o uno compartido con base y rol por proyecto, más barato); una red interna por proyecto con salida limitada a un proxy de registro npm (Verdaccio).
- **Aislamiento para código no confiable:** `--runtime=runsc` (**gVisor**), cambio drop-in. **sysbox** solo si las apps generadas deben ejecutar Docker. DinD privilegiado no es aceptable.
- **Testcontainers** es para la suite de tests propia, no para runtime. Multi-tenant o remoto después: Firecracker/Kata o sandbox alojado (E2B, Daytona, Modal ✗).

### C.3 Enrutado de previews

- **Traefik v3 con provider Docker y labels**, `exposedByDefault=false`. Cada contenedor de app: `traefik.http.routers.p-<id>.rule=Host(\`<id>.preview.localhost\`)`. Traefik v3 **rechaza comodines en `Host()`**; usar `HostRegexp` ~. Descubrimiento sin recarga, WebSockets (HMR), middlewares. Traefik necesita el socket Docker: montarlo de solo lectura vía **socket proxy** (tecnativa/docker-socket-proxy) ✗.
- Caddy: config más simple y TLS bajo demanda, pero necesita `caddy-docker-proxy`. Buena opción si hacen falta certificados públicos automáticos.
- Ruta proxy de Next.js (como `/api/preview/[id]` de Forja): solo para necesidades same-origin (iframe del editor visual). Mantenerla para editar y usar Traefik para ver.

### C.4 Cola / eventos

- **pg-boss sobre el Postgres ya existente:** enqueue transaccional, reintentos, cron, singleton/throttle. Evita un segundo datastore. Latencia de cientos de ms. **Recomendado para v1.**
- BullMQ + Redis: más throughput, rate limiters, flows (padre/hijo mapean bien a un DAG). Elegir si hacen falta cientos de pasos concurrentes o ya hay Redis.
- In-process: solo prototipo mono-proceso.
- Separar **control de jobs** (cola) de **streaming a UI** (tabla `events` append-only o Redis Stream + SSE con `Last-Event-ID`).

### C.5 Selección de modelo por rol vía variables de entorno

Un registro de credenciales de proveedor y un mapa rol → modelo separado. Cadenas `provider:model` evitan la explosión combinatoria.

```dotenv
ANTHROPIC_API_KEY=            # ANTHROPIC_BASE_URL opcional
OPENAI_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
ZAI_API_KEY=                  ZAI_BASE_URL=https://api.z.ai/api/paas/v4
DASHSCOPE_API_KEY=            DASHSCOPE_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
DEEPSEEK_API_KEY=  MOONSHOT_API_KEY=  MINIMAX_API_KEY=  MISTRAL_API_KEY=  XAI_API_KEY=
GROQ_API_KEY=  TOGETHER_API_KEY=  FIREWORKS_API_KEY=  OPENROUTER_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434/v1   LMSTUDIO_BASE_URL=http://localhost:1234/v1   VLLM_BASE_URL=

AGENT_PLANNER_MODEL=anthropic:claude-opus-5-5
AGENT_PLANNER_FALLBACKS=openai:gpt-6-sol,google:gemini-3.8-flash
AGENT_CODER_MODEL=anthropic:claude-sonnet-5
AGENT_CODER_FALLBACKS=zai:glm-5.3,moonshot:kimi-k2.7-code,deepseek:deepseek-v4-pro
AGENT_REVIEWER_MODEL=openai:gpt-6-sol           # familia distinta del coder a propósito
AGENT_FIXER_MODEL=deepseek:deepseek-flash
AGENT_SUMMARIZER_MODEL=anthropic:claude-haiku-4-5
AGENT_PLANNER_EFFORT=high  AGENT_CODER_EFFORT=medium  AGENT_REVIEWER_EFFORT=high
AGENT_CODER_MAX_OUTPUT_TOKENS=64000
AGENT_CODER_TOOL_PROTOCOL=auto   # auto | native | xml
```

Reglas del router: validar env al arrancar (zod); rol cuyo proveedor no tiene clave → fallo rápido o fallback; mapear `effort` genérico al parámetro de cada proveedor; tabla de capacidades por `provider:model` (`nativeTools`, `forcedToolChoice`, `parallelTools`, `thinkingAlwaysOn`, `reasoningEcho`, `maxOutput`, `ctx`); registrar `usage` y coste por rol y ejecución; fijar IDs exactos, nunca alias `-latest` en producción.

## Fuentes

Anthropic: platform.claude.com/docs/en/about-claude/models/overview · OpenAI: developers.openai.com/api/docs/models, /pricing, /models/gpt-6-sol · Gemini: ai.google.dev/gemini-api/docs/models, /models/gemini-3.8-flash, /pricing, /openai · Z.ai: docs.z.ai/api-reference/llm/chat-completion, /guides/overview/pricing, /devpack/tool/others; docs.bigmodel.cn · Qwen: alibabacloud.com/help/en/model-studio/deep-thinking, /qwen-coder, /model-pricing · DeepSeek: api-docs.deepseek.com/quick_start/pricing, /guides/thinking_mode · Kimi: platform.kimi.ai/docs/pricing/chat · MiniMax: platform.minimax.io/docs/api-reference/api-overview · Mistral: docs.mistral.ai/getting-started/models/models_overview, /api · xAI: docs.x.ai/docs/models, /developers/grok-4-7 · Groq: console.groq.com/docs/models, /tool-use · Together: docs.together.ai/docs/serverless-models · Fireworks: docs.fireworks.ai/tools-sdks/openai-compatibility · OpenRouter: openrouter.ai/docs/api-reference/overview, /use-cases/reasoning-tokens · Ollama: docs.ollama.com/api/openai-compatibility · LM Studio: lmstudio.ai/docs/developer/openai-compat · vLLM: docs.vllm.ai/en/latest/features/tool_calling.html · Agentes: developers.openai.com/codex/agent-approvals-security, code.claude.com/docs/en/sub-agents, vercel.com/blog/v0-composite-model-family, cognition.com/blog/dont-build-multi-agents, arxiv.org/pdf/2511.03690, github.com/swe-agent/mini-swe-agent, aider.chat/docs/more/edit-formats.html, github.com/RooCodeInc/Roo-Code/issues/10319 · Infra: docs.litellm.ai/blog/security-update-march-2026, github.com/nestybox/sysbox, github.com/vercel/ai.

**No verificado en esta sesión:** cabeceras de auth de Anthropic, OpenAI y Gemini nativo; base URLs de Together y OpenRouter; comisión y campos de routing de OpenRouter; dominio de Codestral e IDs exactos de Devstral; hosts China de Kimi y MiniMax; lista de herramientas de Gemini CLI; internos de Lovable; compatibilidad gVisor con Next.js; parsers `qwen3_coder`/`minimax` de vLLM.
