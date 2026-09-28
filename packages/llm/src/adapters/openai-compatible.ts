/**
 * The `openai-compatible` adapter: Chat Completions over plain `fetch`, always streamed.
 * Serves NVIDIA NIM, Z.ai, Qwen, DeepSeek, Moonshot, MiniMax, Mistral, Groq, Together,
 * Fireworks, OpenRouter, Ollama, LM Studio and vLLM (differences live in catalog quirks).
 *
 * What this file protects:
 * - Exactly one HTTP request per `stream()` call. Retries, fallbacks and rate limits are
 *   the gateway's job; the smoke CLI relies on this to spend exactly one request.
 * - The request carries no `temperature`/`top_p`, and `tool_choice` is only ever `"auto"`
 *   (docs/architecture/02 §4 invariants 3–4). The output limit uses the provider's field.
 * - Tool-call deltas are assembled by `index`, whether they arrive split across chunks or
 *   whole in one delta (NIM), and are emitted only once the stream finished, with their
 *   arguments parsed (unparseable arguments are passed through as the raw string so the
 *   agent loop can report the validation error to the model).
 * - The assistant message is kept native (`provider-message`) and echoed verbatim on the
 *   next turn when provider and model match; it carries `reasoning_content` only when the
 *   model requires it back (`capabilities.reasoningEcho`).
 * - Two timeouts: until the first body byte (free tiers can take minutes), then between
 *   chunks. Either one aborts the request and throws `LlmError("timeout")`. The caller's
 *   `abortSignal` aborts the request and throws `LlmError("aborted")`.
 */
import { LlmError } from "../errors.js";
import type { ModelDefinition, ProviderDefinition } from "../catalog/types.js";
import type { AgentMessage, ContentPart, FinishReason, GenerateEvent, GenerateRequest } from "../types.js";
import { classifyStatus, errorBodyMessage, httpError, parseRetryAfter } from "./http-errors.js";
import { SseParser, type SseEvent } from "./sse.js";

/** What the gateway needs from any adapter. */
export interface ChatAdapter {
  readonly providerId: string;
  /** One request, streamed. Never emits `route`; the gateway does. */
  stream(model: ModelDefinition, req: GenerateRequest): AsyncGenerator<GenerateEvent>;
}

export interface OpenAICompatibleOptions {
  provider: ProviderDefinition;
  baseUrl: string;
  apiKey?: string;
  firstByteTimeoutMs: number;
  idleTimeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}

// ── Request building ───────────────────────────────────────────────────────

type ChatMessage = Record<string, unknown>;

function userContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    if (part.type === "image") return { type: "image_url", image_url: { url: `data:${part.mediaType};base64,${part.data}` } };
    return { type: "image_url", image_url: { url: part.url } };
  });
}

function argumentsText(args: unknown): string {
  return typeof args === "string" ? args : JSON.stringify(args ?? {});
}

/**
 * Agent messages → Chat Completions messages. An assistant turn produced by this same
 * provider and model is sent back exactly as received (`native.raw`); any other assistant
 * turn is rebuilt from its text and tool calls.
 */
export function toChatMessages(providerId: string, modelId: string, system: string, messages: AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system !== "") out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: userContent(m.content) });
    } else if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
    } else if (m.native && m.native.provider === providerId && m.native.model === modelId && m.native.raw !== null && typeof m.native.raw === "object") {
      out.push(m.native.raw as ChatMessage);
    } else {
      const msg: ChatMessage = { role: "assistant", content: m.text };
      if (m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: argumentsText(tc.args) } }));
      }
      out.push(msg);
    }
  }
  return out;
}

export function buildChatBody(provider: ProviderDefinition, model: ModelDefinition, req: GenerateRequest): Record<string, unknown> {
  const { quirks } = provider;
  if (quirks.maxTools !== undefined && req.tools.length > quirks.maxTools) {
    throw new LlmError("bad_request", `${provider.id} accepts at most ${quirks.maxTools} tools per request; got ${req.tools.length}`, {
      retryable: false,
      provider: provider.id,
      model: model.id,
    });
  }
  const body: Record<string, unknown> = { model: model.id, stream: true };
  if (quirks.streamUsage) body.stream_options = { include_usage: true };
  body[quirks.maxTokensParam] = Math.max(1, Math.min(req.maxOutputTokens, model.maxOutputTokens));
  body.messages = toChatMessages(provider.id, model.id, req.system, req.messages);
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    body.tool_choice = "auto";
  }
  const extra = quirks.extraBody?.({ model, ...(req.effort ? { effort: req.effort } : {}), hasTools: req.tools.length > 0 });
  return extra ? { ...body, ...extra } : body;
}

// ── Stream decoding ────────────────────────────────────────────────────────

interface PendingToolCall {
  id?: string;
  name?: string;
  args: string;
}

interface ChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number | null } | null;
  prompt_cache_hit_tokens?: number;
  cost?: number;
}

interface StreamState {
  text: string;
  reasoning: string;
  toolCalls: Map<number, PendingToolCall>;
  finishReason?: string;
  usage?: ChunkUsage;
  done: boolean;
}

export function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  if (hasToolCalls) return "tool-calls";
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool-calls";
    case "length":
      return "length";
    case "content_filter":
    case "refusal":
      return "refusal";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

function parseArgs(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function streamError(payload: unknown, ctx: { provider: string; model: string }): LlmError {
  const err = (payload as { error?: unknown }).error ?? payload;
  const e = (typeof err === "object" && err !== null ? err : { message: String(err) }) as { message?: unknown; code?: unknown; status?: unknown };
  const status = typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : undefined;
  const text = JSON.stringify(err);
  const { code, retryable } = status !== undefined ? classifyStatus(status, text) : { code: "unavailable" as const, retryable: true };
  return new LlmError(code, `${ctx.provider}:${ctx.model} reported an error mid-stream: ${errorBodyMessage(JSON.stringify({ error: err }))}`, {
    retryable,
    ...ctx,
    ...(status !== undefined ? { status } : {}),
  });
}

/** Applies one SSE event to the state; returns the deltas to emit now. */
function applyEvent(ev: SseEvent, state: StreamState, ctx: { provider: string; model: string }): GenerateEvent[] {
  const data = ev.data.trim();
  if (data === "") return [];
  if (data === "[DONE]") {
    state.done = true;
    return [];
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(data) as Record<string, unknown>;
  } catch {
    if (ev.event !== "message") return []; // named non-JSON events (pings) carry nothing for us
    throw new LlmError("unavailable", `${ctx.provider}:${ctx.model} sent a malformed stream chunk`, { retryable: true, ...ctx });
  }
  if (ev.event === "error" || (json.error !== undefined && json.error !== null)) throw streamError(json, ctx);

  const out: GenerateEvent[] = [];
  if (json.usage && typeof json.usage === "object") state.usage = json.usage as ChunkUsage;
  const choices = Array.isArray(json.choices) ? (json.choices as Array<Record<string, unknown>>) : [];
  const choice = choices.find((c) => (c.index ?? 0) === 0) ?? choices[0];
  if (!choice) return out;

  const delta = (choice.delta ?? choice.message ?? {}) as Record<string, unknown>;
  const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
  if (reasoning !== "") {
    state.reasoning += reasoning;
    out.push({ type: "reasoning-delta", text: reasoning });
  }
  if (typeof delta.content === "string" && delta.content !== "") {
    state.text += delta.content;
    out.push({ type: "text-delta", text: delta.content });
  }
  if (Array.isArray(delta.tool_calls)) {
    (delta.tool_calls as Array<Record<string, unknown>>).forEach((tc, position) => {
      const index = typeof tc.index === "number" ? tc.index : position;
      const pending = state.toolCalls.get(index) ?? { args: "" };
      if (typeof tc.id === "string" && tc.id !== "" && !pending.id) pending.id = tc.id;
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      if (typeof fn.name === "string" && fn.name !== "" && !pending.name) pending.name = fn.name;
      if (typeof fn.arguments === "string") pending.args += fn.arguments;
      else if (fn.arguments !== undefined && fn.arguments !== null) pending.args = JSON.stringify(fn.arguments);
      state.toolCalls.set(index, pending);
    });
  }
  if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") state.finishReason = choice.finish_reason;
  return out;
}

// ── Timers ─────────────────────────────────────────────────────────────────

/** Races `p` against a timeout and the caller's abort; the loser's error is thrown. */
function race<T>(p: Promise<T>, ms: number, signal: AbortSignal, onTimeout: () => LlmError, onAbort: () => LlmError): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(onAbort());
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      reject(onTimeout());
    }, Math.max(0, ms));
    const abort = () => {
      cleanup();
      reject(onAbort());
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    p.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e: unknown) => {
        cleanup();
        reject(e);
      },
    );
  });
}

// ── Adapter ────────────────────────────────────────────────────────────────

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleOptions): ChatAdapter {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const provider = opts.provider;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  async function* stream(model: ModelDefinition, req: GenerateRequest): AsyncGenerator<GenerateEvent> {
    const ctx = { provider: provider.id, model: model.id };
    const aborted = () => new LlmError("aborted", "generation aborted", { retryable: false, ...ctx });
    if (req.abortSignal.aborted) throw aborted();

    const body = buildChatBody(provider, model, req);
    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    req.abortSignal.addEventListener("abort", forwardAbort, { once: true });
    const started = now();
    const firstByteDeadline = started + opts.firstByteTimeoutMs;
    const firstByteTimeout = () =>
      new LlmError("timeout", `${ctx.provider}:${ctx.model} sent no data within ${opts.firstByteTimeoutMs} ms`, { retryable: true, ...ctx });
    const idleTimeout = () =>
      new LlmError("timeout", `${ctx.provider}:${ctx.model} stalled for ${opts.idleTimeoutMs} ms mid-stream`, { retryable: true, ...ctx });

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let completed = false;
    try {
      let response: Response;
      try {
        response = await race(
          fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal }),
          firstByteDeadline - now(),
          req.abortSignal,
          firstByteTimeout,
          aborted,
        );
      } catch (err) {
        if (err instanceof LlmError) throw err;
        if (req.abortSignal.aborted) throw aborted();
        throw new LlmError("unavailable", `${ctx.provider}:${ctx.model} request failed: ${err instanceof Error ? err.message : String(err)}`, {
          retryable: true,
          ...ctx,
          cause: err,
        });
      }

      if (!response.ok) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
        const text = await race(response.text().catch(() => ""), opts.idleTimeoutMs, req.abortSignal, idleTimeout, aborted);
        throw httpError(response.status, text, { ...ctx, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      }
      if (!response.body) throw new LlmError("unavailable", `${ctx.provider}:${ctx.model} returned an empty body`, { retryable: true, ...ctx });

      reader = response.body.getReader();
      const parser = new SseParser();
      const state: StreamState = { text: "", reasoning: "", toolCalls: new Map(), done: false };
      let gotFirstByte = false;

      while (!state.done) {
        const { value, done } = await race(
          reader.read(),
          gotFirstByte ? opts.idleTimeoutMs : firstByteDeadline - now(),
          req.abortSignal,
          gotFirstByte ? idleTimeout : firstByteTimeout,
          aborted,
        );
        const events = done ? parser.end() : parser.push(value);
        if (!done && value.byteLength > 0) gotFirstByte = true;
        for (const ev of events) {
          for (const out of applyEvent(ev, state, ctx)) yield out;
          if (state.done) break;
        }
        if (done) break;
      }

      if (!state.done && state.finishReason === undefined) {
        throw new LlmError("unavailable", `${ctx.provider}:${ctx.model} closed the stream before finishing`, { retryable: true, ...ctx });
      }

      const indexes = [...state.toolCalls.keys()].sort((a, b) => a - b);
      const calls = indexes.map((index) => {
        const p = state.toolCalls.get(index) as PendingToolCall;
        return { id: p.id ?? `call_${index}`, name: p.name ?? "", argsText: p.args };
      });
      for (const c of calls) yield { type: "tool-call", id: c.id, name: c.name, args: parseArgs(c.argsText) };

      const raw: Record<string, unknown> = { role: "assistant", content: state.text };
      if (calls.length > 0) raw.tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argsText } }));
      if (model.capabilities.reasoningEcho === "reasoning_content" && state.reasoning !== "") raw.reasoning_content = state.reasoning;
      yield { type: "provider-message", raw };

      const u = state.usage ?? {};
      const prompt = u.prompt_tokens ?? 0;
      const cachedInput = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
      const usage = { input: Math.max(0, prompt - cachedInput), output: u.completion_tokens ?? 0, cachedInput, cacheWrite: 0 };
      const costUsd = provider.quirks.usageCost && typeof u.cost === "number" ? u.cost : model.price(usage, new Date(now()));
      yield { type: "usage", ...usage, costUsd };
      yield { type: "finish", reason: mapFinishReason(state.finishReason, calls.length > 0) };
      completed = true;
    } finally {
      req.abortSignal.removeEventListener("abort", forwardAbort);
      if (!completed) controller.abort();
      reader?.cancel().catch(() => undefined);
    }
  }

  return { providerId: provider.id, stream };
}
