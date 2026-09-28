/**
 * openai-compatible adapter against the real NVIDIA captures (replayed through an
 * injected fetch; no network). Protects: the exact request NIM accepted, tool calls in
 * both delta forms, reasoning deltas, usage mapping, native echo, error mapping, timeouts
 * and abort.
 */
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter, buildChatBody, mapFinishReason } from "../src/adapters/openai-compatible.js";
import { classifyStatus, parseRetryAfter } from "../src/adapters/http-errors.js";
import { CATALOG } from "../src/catalog/index.js";
import type { ModelDefinition, ProviderDefinition } from "../src/catalog/types.js";
import { LlmError } from "../src/errors.js";
import { collect } from "../src/replay/index.js";
import type { AgentMessage, GenerateEvent } from "../src/types.js";
import { chunkBytes, delta, fakeFetch, fixtureJson, fixtureText, request, sseBody, sseResponse, type FetchHandler } from "./helpers.js";

const nvidia = CATALOG.nvidia;
const glm = nvidia.models.find((m) => m.id === "z-ai/glm-5.3") as ModelDefinition;
const KEY = "nvapi-TEST-not-a-real-key";

function adapter(handler: FetchHandler, overrides: Partial<{ provider: ProviderDefinition; firstByteTimeoutMs: number; idleTimeoutMs: number }> = {}) {
  const fetch = fakeFetch(handler);
  const a = createOpenAICompatibleAdapter({
    provider: overrides.provider ?? nvidia,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: KEY,
    firstByteTimeoutMs: overrides.firstByteTimeoutMs ?? 5_000,
    idleTimeoutMs: overrides.idleTimeoutMs ?? 5_000,
    fetch,
    now: () => Date.UTC(2026, 8, 28, 12),
  });
  return { a, fetch };
}

const toolResultMessages = (native: unknown): AgentMessage[] => [
  { role: "user", content: "Read the file src/app/page.tsx using the tool." },
  {
    role: "assistant",
    text: "",
    toolCalls: [{ id: "b29e0ede-031a-47f7-9810-f00f5eeb022f", name: "read_file", args: { path: "src/app/page.tsx" } }],
    native: { provider: "nvidia", model: "z-ai/glm-5.3", raw: native },
  },
  { role: "tool", toolCallId: "b29e0ede-031a-47f7-9810-f00f5eeb022f", name: "read_file", content: "export default function Page() { return <h1>Hello</h1>; }" },
  { role: "user", content: "In one sentence: what does the page render?" },
];

describe("NVIDIA capture: native tool call (z-ai/glm-5.3)", () => {
  it("sends exactly the request NIM accepted", async () => {
    const { a, fetch } = adapter(() => sseResponse([fixtureText("tool-call.response.sse")]));
    await collect(a.stream(glm, request()));
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0]!;
    expect(call.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(call.body).toEqual(fixtureJson("tool-call.request.json"));
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(call.body).not.toHaveProperty("temperature");
    expect(call.body).not.toHaveProperty("top_p");
  });

  it("emits the single-delta tool call, native message, usage and finish", async () => {
    const { a } = adapter(() => sseResponse([fixtureText("tool-call.response.sse")]));
    const events = await collect(a.stream(glm, request()));
    expect(events).toEqual([
      { type: "tool-call", id: "b29e0ede-031a-47f7-9810-f00f5eeb022f", name: "read_file", args: { path: "src/app/page.tsx" } },
      {
        type: "provider-message",
        raw: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "b29e0ede-031a-47f7-9810-f00f5eeb022f", type: "function", function: { name: "read_file", arguments: '{"path":"src/app/page.tsx"}' } }],
        },
      },
      { type: "usage", input: 187, output: 16, cachedInput: 0, cacheWrite: 0, costUsd: 0 },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  it("is identical whatever the network chunking", async () => {
    const text = fixtureText("tool-call.response.sse");
    const { a: whole } = adapter(() => sseResponse([text]));
    const expected = await collect(whole.stream(glm, request()));
    for (const size of [1, 3, 17, 200]) {
      const { a } = adapter(() => sseResponse(chunkBytes(text, size)));
      expect(await collect(a.stream(glm, request()))).toEqual(expected);
    }
  });
});

describe("NVIDIA capture: tool result turn (reasoning + text)", () => {
  async function firstTurnNative(): Promise<unknown> {
    const { a } = adapter(() => sseResponse([fixtureText("tool-call.response.sse")]));
    const events = await collect(a.stream(glm, request()));
    return (events.find((e) => e.type === "provider-message") as { raw: unknown }).raw;
  }

  it("echoes the native assistant message verbatim: the request equals the accepted one", async () => {
    const native = await firstTurnNative();
    const { a, fetch } = adapter(() => sseResponse([fixtureText("tool-result.response.sse")]));
    await collect(a.stream(glm, request({ messages: toolResultMessages(native) })));
    expect(fetch.calls[0]!.body).toEqual(fixtureJson("tool-result.request.json"));
  });

  it("rebuilds the same assistant message when the native one belongs to another model", async () => {
    const native = await firstTurnNative();
    const messages = toolResultMessages(native).map((m) => (m.role === "assistant" ? { ...m, native: { provider: "zai", model: "glm-5.3", raw: { bogus: true } } } : m));
    const { a, fetch } = adapter(() => sseResponse([fixtureText("tool-result.response.sse")]));
    await collect(a.stream(glm, request({ messages })));
    expect(fetch.calls[0]!.body).toEqual(fixtureJson("tool-result.request.json"));
  });

  it("streams reasoning then text, maps cached tokens, finishes with stop", async () => {
    const { a } = adapter(() => sseResponse(chunkBytes(fixtureText("tool-result.response.sse"), 50)));
    const events = await collect(a.stream(glm, request({ messages: toolResultMessages(await firstTurnNative()) })));
    const reasoning = events.filter((e): e is Extract<GenerateEvent, { type: "reasoning-delta" }> => e.type === "reasoning-delta").map((e) => e.text).join("");
    const text = events.filter((e): e is Extract<GenerateEvent, { type: "text-delta" }> => e.type === "text-delta").map((e) => e.text).join("");
    expect(reasoning.startsWith("The user wants a one-sentence summary")).toBe(true);
    expect(text).toMatch(/page renders a single `<h1>` heading containing the text "Hello"\.$/);
    const firstText = events.findIndex((e) => e.type === "text-delta");
    const lastReasoning = events.map((e) => e.type).lastIndexOf("reasoning-delta");
    expect(lastReasoning).toBeLessThan(firstText);
    expect(events.filter((e) => e.type === "tool-call")).toEqual([]);
    expect(events.at(-2)).toEqual({ type: "usage", input: 234 - 128, output: 55, cachedInput: 128, cacheWrite: 0, costUsd: 0 });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    // glm-5.3 on NIM does not need reasoning_content back: the native message omits it.
    const native = events.find((e) => e.type === "provider-message") as { raw: Record<string, unknown> };
    expect(native.raw).toEqual({ role: "assistant", content: text });
  });

  it("keeps reasoning_content in the native message when the model requires the echo", async () => {
    const kimi = nvidia.models.find((m) => m.id === "moonshotai/kimi-k3") as ModelDefinition;
    const { a } = adapter(() => sseResponse([fixtureText("tool-result.response.sse")]));
    const events = await collect(a.stream(kimi, request({ tools: [] })));
    const native = events.find((e) => e.type === "provider-message") as { raw: Record<string, unknown> };
    expect(String(native.raw.reasoning_content)).toMatch(/^The user wants/);
  });
});

describe("stream decoding", () => {
  it("assembles tool calls split across chunks by index (parallel calls interleaved)", async () => {
    const body = sseBody([
      delta({ role: "assistant", content: null }),
      delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: "" } }] }),
      delta({ tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "glob", arguments: '{"pat' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
      delta({ tool_calls: [{ index: 1, function: { arguments: 'tern":"**/*.ts"}' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
      delta({}, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ]);
    const { a } = adapter(() => sseResponse(chunkBytes(body, 11)));
    const events = await collect(a.stream(glm, request()));
    expect(events.filter((e) => e.type === "tool-call")).toEqual([
      { type: "tool-call", id: "c1", name: "read_file", args: { path: "a.ts" } },
      { type: "tool-call", id: "c2", name: "glob", args: { pattern: "**/*.ts" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  it("passes unparseable arguments through as the raw string and fills a missing id", async () => {
    const body = sseBody([delta({ tool_calls: [{ index: 0, function: { name: "write_file", arguments: '{"path": "x' } }] }, "tool_calls")]);
    const { a } = adapter(() => sseResponse([body]));
    const events = await collect(a.stream(glm, request()));
    expect(events[0]).toEqual({ type: "tool-call", id: "call_0", name: "write_file", args: '{"path": "x' });
  });

  it("reads `reasoning` as well as `reasoning_content` and reports tool-calls even on finish stop", async () => {
    const body = sseBody([
      delta({ reasoning: "thinking" }),
      delta({ content: "ok" }),
      delta({ tool_calls: [{ index: 0, id: "t", function: { name: "glob", arguments: "{}" } }] }, "stop"),
    ]);
    const { a } = adapter(() => sseResponse([body]));
    const events = await collect(a.stream(glm, request()));
    expect(events.slice(0, 3)).toEqual([
      { type: "reasoning-delta", text: "thinking" },
      { type: "text-delta", text: "ok" },
      { type: "tool-call", id: "t", name: "glob", args: {} },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", input: 0, output: 0, cachedInput: 0, cacheWrite: 0, costUsd: 0 });
  });

  it("accepts a finished stream without [DONE] but rejects a truncated one", async () => {
    const finished = sseBody([delta({ content: "hi" }, "stop")], false);
    const { a } = adapter(() => sseResponse([finished]));
    expect((await collect(a.stream(glm, request()))).at(-1)).toEqual({ type: "finish", reason: "stop" });

    const truncated = sseBody([delta({ content: "hi" })], false);
    const { a: b } = adapter(() => sseResponse([truncated]));
    await expect(collect(b.stream(glm, request()))).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });

  it("maps a mid-stream error chunk", async () => {
    const body = sseBody([delta({ content: "x" }), { error: { message: "overloaded", code: 503 } }]);
    const { a } = adapter(() => sseResponse([body]));
    await expect(collect(a.stream(glm, request()))).rejects.toMatchObject({ code: "unavailable", retryable: true, status: 503 });
  });

  it("maps finish reasons", () => {
    expect(mapFinishReason("length", false)).toBe("length");
    expect(mapFinishReason("content_filter", false)).toBe("refusal");
    expect(mapFinishReason(undefined, false)).toBe("stop");
    expect(mapFinishReason("stop", true)).toBe("tool-calls");
  });
});

describe("request body quirks", () => {
  it("uses max_completion_tokens when the provider says so and clamps to the model limit", () => {
    const p: ProviderDefinition = { ...nvidia, quirks: { maxTokensParam: "max_completion_tokens", streamUsage: false } };
    const body = buildChatBody(p, glm, request({ maxOutputTokens: 1_000_000 }));
    expect(body.max_completion_tokens).toBe(glm.maxOutputTokens);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("stream_options");
  });

  it("omits tools and tool_choice without tools, and adds vendor extras", () => {
    const zai = CATALOG.zai;
    const model = zai.models[0] as ModelDefinition;
    expect(buildChatBody(zai, model, request({ tools: [], effort: "xhigh" }))).not.toHaveProperty("tool_choice");
    expect(buildChatBody(zai, model, request({ effort: "xhigh" }))).toMatchObject({ tool_choice: "auto", tool_stream: true, reasoning_effort: "max" });
  });

  it("sends images as image_url parts", () => {
    const body = buildChatBody(nvidia, glm, request({ messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image", mediaType: "image/png", data: "AAA" }, { type: "image-url", url: "https://x/y.png" }] }] }));
    expect((body.messages as unknown[])[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ],
    });
  });

  it("refuses more tools than the vendor accepts", () => {
    const tools = Array.from({ length: 21 }, (_, i) => ({ name: `t${i}`, description: "", inputSchema: {} }));
    expect(() => buildChatBody(CATALOG.qwen, CATALOG.qwen.models[0] as ModelDefinition, request({ tools }))).toThrow(LlmError);
  });
});

describe("HTTP errors", () => {
  it.each([
    [401, "", "auth", false],
    [403, "", "auth", false],
    [402, "", "unavailable", false],
    [404, "", "bad_request", false],
    [408, "", "timeout", true],
    [413, "", "context_length", false],
    [429, "", "rate_limited", true],
    [400, '{"error":{"message":"This model\'s maximum context length is 131072 tokens"}}', "context_length", false],
    [400, '{"error":{"message":"bad field"}}', "bad_request", false],
    [500, "", "unavailable", true],
    [503, "", "unavailable", true],
  ])("HTTP %i → %s", (status, body, code, retryable) => {
    expect(classifyStatus(status, body)).toEqual({ code, retryable });
  });

  it("parses Retry-After in seconds and as a date", () => {
    expect(parseRetryAfter("7", 0)).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
  });

  it("throws LlmError with status, retryAfter and the provider's message, never the key", async () => {
    const { a } = adapter(() => new Response('{"error":{"message":"Too many requests"}}', { status: 429, headers: { "retry-after": "3" } }));
    const err = (await collect(a.stream(glm, request())).catch((e: unknown) => e)) as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ code: "rate_limited", retryable: true, status: 429, retryAfterMs: 3000, provider: "nvidia", model: "z-ai/glm-5.3" });
    expect(err.message).toContain("Too many requests");
    expect(err.message).not.toContain(KEY);
  });

  it("maps a network failure to a retryable unavailable", async () => {
    const { a } = adapter(() => Promise.reject(new TypeError("fetch failed")));
    await expect(collect(a.stream(glm, request()))).rejects.toMatchObject({ code: "unavailable", retryable: true });
  });
});

describe("timeouts and abort", () => {
  /** A body that sends `first` (if any) and then never another byte. */
  function stalled(first?: string): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          if (first) c.enqueue(new TextEncoder().encode(first));
        },
      }),
      { status: 200 },
    );
  }

  it("times out waiting for the first byte (headers never arrive)", async () => {
    const { a } = adapter(() => new Promise<Response>(() => undefined), { firstByteTimeoutMs: 30 });
    await expect(collect(a.stream(glm, request()))).rejects.toMatchObject({ code: "timeout", message: expect.stringMatching(/no data within 30 ms/) });
  });

  it("times out waiting for the first body byte after headers", async () => {
    const { a } = adapter(() => stalled(), { firstByteTimeoutMs: 30 });
    await expect(collect(a.stream(glm, request()))).rejects.toMatchObject({ code: "timeout" });
  });

  it("times out when the stream stalls between chunks", async () => {
    const { a } = adapter(() => stalled(sseBody([delta({ content: "partial" })], false)), { idleTimeoutMs: 30 });
    const seen: GenerateEvent[] = [];
    const err = await (async () => {
      for await (const ev of a.stream(glm, request())) seen.push(ev);
    })().catch((e: unknown) => e);
    expect(seen).toEqual([{ type: "text-delta", text: "partial" }]);
    expect(err).toMatchObject({ code: "timeout", message: expect.stringMatching(/stalled for 30 ms/) });
  });

  it("aborts via the caller's signal", async () => {
    const controller = new AbortController();
    const { a, fetch } = adapter((call) => {
      setTimeout(() => controller.abort(), 10);
      return new Promise<Response>((_, reject) => call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    });
    await expect(collect(a.stream(glm, request({ abortSignal: controller.signal })))).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(fetch.calls[0]!.init.signal?.aborted).toBe(true);
  });

  it("does not call fetch when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { a, fetch } = adapter(() => sseResponse([]));
    await expect(collect(a.stream(glm, request({ abortSignal: controller.signal })))).rejects.toMatchObject({ code: "aborted" });
    expect(fetch.calls).toHaveLength(0);
  });
});
