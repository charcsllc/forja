/**
 * Gateway behaviour through an injected fetch (no network). Protects: `route` first,
 * retries with Retry-After, fallbacks, no retry after output, degradation with cooldown,
 * budget refusal and charging, pinned models, abort during backoff.
 */
import { describe, expect, it } from "vitest";
import { createLlmGateway } from "../src/gateway/index.js";
import { collect } from "../src/replay/index.js";
import type { GenerateEvent } from "../src/types.js";
import { delta, fakeFetch, fixtureText, request, REQUIREMENTS, sseBody, sseResponse, type FetchHandler } from "./helpers.js";

const OK = () => sseResponse([fixtureText("tool-call.response.sse")]);
const status = (code: number, headers: Record<string, string> = {}) => () => new Response(`{"error":{"message":"HTTP ${code}"}}`, { status: code, headers });

function setup(handler: FetchHandler, env: Record<string, string> = {}) {
  const fetch = fakeFetch(handler);
  const sleeps: number[] = [];
  let t = Date.UTC(2026, 8, 28, 12);
  const gw = createLlmGateway({
    env: { LLM_NVIDIA: "true|nvapi-test-key", ...env },
    requirements: REQUIREMENTS,
    fetch,
    now: () => t,
    sleep: async (ms) => void sleeps.push(ms),
  });
  return { gw, fetch, sleeps, advance: (ms: number) => void (t += ms) };
}

const routes = (events: GenerateEvent[]) => events.filter((e) => e.type === "route");

describe("createLlmGateway.generate", () => {
  it("emits route first, then the adapter's events, and charges the budget", async () => {
    const charges: number[] = [];
    const { gw, fetch } = setup(OK);
    const events = await collect(gw.generate(request({ role: "director", budget: { remainingUsd: () => 5, charge: (c) => void charges.push(c) } })));
    expect(events[0]).toEqual({ type: "route", provider: "nvidia", model: "z-ai/glm-5.3", attempt: 1 });
    expect(events.map((e) => e.type)).toEqual(["route", "tool-call", "provider-message", "usage", "finish"]);
    expect(charges).toEqual([0]);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.body.model).toBe("z-ai/glm-5.3");
  });

  it("applies the role's effort when the request has none", async () => {
    const { gw, fetch } = setup(() => sseResponse([sseBody([delta({ content: "ok" }, "stop")])]), { LLM_NVIDIA: "false|", LLM_ZAI: "true|k", AGENT_DIRECTOR_EFFORT: "xhigh" });
    await collect(gw.generate(request({ role: "director" })));
    expect(fetch.calls[0]!.body).toMatchObject({ model: "glm-5.3", reasoning_effort: "max" });
  });

  it("prices usage from the catalog", async () => {
    const charges: number[] = [];
    const body = sseBody([delta({ content: "ok" }, "stop"), { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }]);
    const { gw } = setup(() => sseResponse([body]), { LLM_NVIDIA: "false|", LLM_ZAI: "true|k" });
    const events = await collect(gw.generate(request({ role: "director", budget: { remainingUsd: () => 5, charge: (c) => void charges.push(c) } })));
    const usage = events.find((e) => e.type === "usage") as { costUsd: number };
    expect(usage.costUsd).toBeCloseTo((1000 * 1.4 + 1000 * 4.4) / 1e6, 10);
    expect(charges[0]).toBeCloseTo(0.0058, 10);
  });

  it("retries a 429 on the same model honouring Retry-After", async () => {
    const { gw, fetch, sleeps } = setup((_, i) => (i === 0 ? status(429, { "retry-after": "7" })() : OK()));
    const events = await collect(gw.generate(request({ role: "director" })));
    expect(routes(events)).toEqual([
      { type: "route", provider: "nvidia", model: "z-ai/glm-5.3", attempt: 1 },
      { type: "route", provider: "nvidia", model: "z-ai/glm-5.3", attempt: 2 },
    ]);
    expect(sleeps).toEqual([7000]);
    expect(fetch.calls).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  it("backs off exponentially on 5xx, then falls back to the next model", async () => {
    const { gw, fetch, sleeps } = setup((call) => (call.body.model === "z-ai/glm-5.3" ? status(503)() : OK()));
    const events = await collect(gw.generate(request({ role: "director" })));
    expect(routes(events).map((r) => (r as { model: string; attempt: number }).model + "#" + (r as { attempt: number }).attempt)).toEqual([
      "z-ai/glm-5.3#1",
      "z-ai/glm-5.3#2",
      "z-ai/glm-5.3#3",
      "z-ai/glm-5.3-flash#4",
    ]);
    expect(sleeps).toEqual([2000, 4000]);
    expect(fetch.calls.map((c) => c.body.model)).toEqual(["z-ai/glm-5.3", "z-ai/glm-5.3", "z-ai/glm-5.3", "z-ai/glm-5.3-flash"]);
  });

  it("does not retry auth failures on the same model and throws the last error", async () => {
    const { gw, fetch, sleeps } = setup(status(401));
    await expect(collect(gw.generate(request({ role: "director" })))).rejects.toMatchObject({ code: "auth", retryable: false });
    expect(fetch.calls.map((c) => c.body.model)).toEqual(["z-ai/glm-5.3", "z-ai/glm-5.3-flash"]);
    expect(sleeps).toEqual([]);
  });

  it("moves to the fallback after a first-byte timeout without retrying the slow model", async () => {
    const { gw, fetch } = setup((call) => (call.body.model === "z-ai/glm-5.3" ? new Promise<Response>(() => undefined) : OK()), { LLM_NVIDIA_TIMEOUT_MS: "20" });
    const events = await collect(gw.generate(request({ role: "director" })));
    expect(fetch.calls.map((c) => c.body.model)).toEqual(["z-ai/glm-5.3", "z-ai/glm-5.3-flash"]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  it("never retries once output reached the caller", async () => {
    const truncated = sseBody([delta({ content: "partial" })], false);
    const { gw, fetch } = setup(() => sseResponse([truncated]));
    const seen: GenerateEvent[] = [];
    const err = await (async () => {
      for await (const ev of gw.generate(request({ role: "director" }))) seen.push(ev);
    })().catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unavailable" });
    expect(seen.map((e) => e.type)).toEqual(["route", "text-delta"]);
    expect(fetch.calls).toHaveLength(1);
  });

  it("degrades a failing model for a cooldown, then restores it", async () => {
    let failing = true;
    const { gw, advance } = setup((call) => (failing && call.body.model === "z-ai/glm-5.3" ? status(500)() : OK()));
    await collect(gw.generate(request({ role: "director" }))); // 3 failures → degraded, served by flash
    const second = await collect(gw.generate(request({ role: "director" })));
    expect(second[0]).toMatchObject({ type: "route", model: "z-ai/glm-5.3-flash", attempt: 1 });
    failing = false;
    advance(60_001);
    const third = await collect(gw.generate(request({ role: "director" })));
    expect(third[0]).toMatchObject({ type: "route", model: "z-ai/glm-5.3", attempt: 1 });
  });

  it("refuses to call when the budget is exhausted", async () => {
    const { gw, fetch } = setup(OK);
    await expect(collect(gw.generate(request({ role: "director", budget: { remainingUsd: () => 0, charge: () => undefined } })))).rejects.toMatchObject({
      code: "budget",
      retryable: false,
    });
    expect(fetch.calls).toHaveLength(0);
  });

  it("honours a pinned model, then the role's chain", async () => {
    const { gw, fetch } = setup((call) => (call.body.model === "openai/gpt-oss-20b" ? status(400)() : OK()));
    const events = await collect(gw.generate(request({ role: "director", model: "nvidia:openai/gpt-oss-20b" })));
    expect(fetch.calls.map((c) => c.body.model)).toEqual(["openai/gpt-oss-20b", "z-ai/glm-5.3"]);
    expect(routes(events)).toHaveLength(2);
  });

  it("throws unavailable for a role nothing can serve", async () => {
    const { gw, fetch } = setup(OK);
    await expect(collect(gw.generate(request({ role: "designer" })))).rejects.toMatchObject({ code: "unavailable", message: expect.stringMatching(/role `designer` needs/) });
    expect(fetch.calls).toHaveLength(0);
  });

  it("aborts while backing off", async () => {
    const controller = new AbortController();
    const fetch = fakeFetch(status(503));
    const gw = createLlmGateway({
      env: { LLM_NVIDIA: "true|nvapi-test-key" },
      requirements: REQUIREMENTS,
      fetch,
      sleep: () => {
        controller.abort();
        return new Promise(() => undefined);
      },
    });
    await expect(collect(gw.generate(request({ role: "director", abortSignal: controller.signal })))).rejects.toMatchObject({ code: "aborted" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("queues on MAX_CONCURRENCY instead of failing", async () => {
    let open = 0;
    let maxOpen = 0;
    const { gw } = setup(async () => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return OK();
    }, { LLM_NVIDIA_MAX_CONCURRENCY: "1" });
    const results = await Promise.all([1, 2, 3].map(() => collect(gw.generate(request({ role: "director" })))));
    expect(results.every((r) => r.at(-1)?.type === "finish")).toBe(true);
    expect(maxOpen).toBe(1);
  });
});
