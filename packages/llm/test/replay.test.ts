/**
 * Replay store and provider tests. Protects: record → replay round trip is exact, key
 * is order-independent, misses explain themselves, partial streams are never saved.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GenerateEvent, GenerateRequest, Provider } from "../src/types.js";
import { collect, createReplayProvider, keyMaterial, replayKey, ReplayMissError, scriptedProvider, textTurn, toolCallTurn } from "../src/replay/index.js";

function req(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    role: "frontend",
    system: "You are the frontend engineer.",
    messages: [{ role: "user", content: "Add a pricing page" }],
    tools: [{ name: "write_file", description: "Write a file", inputSchema: { type: "object", properties: { path: { type: "string" } } } }],
    effort: "medium",
    maxOutputTokens: 1000,
    abortSignal: new AbortController().signal,
    budget: { remainingUsd: () => 1, charge: () => {} },
    model: "anthropic:claude-opus-5-5",
    ...overrides,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forja-replay-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("replay key", () => {
  it("ignores object key order and non-semantic fields", () => {
    const a = req();
    const b = req({
      maxOutputTokens: 5,
      role: "fixer",
      tools: [{ inputSchema: { properties: { path: { type: "string" } }, type: "object" }, description: "Write a file", name: "write_file" }],
    });
    expect(replayKey(keyMaterial(a))).toBe(replayKey(keyMaterial(b)));
  });

  it("changes with system, messages, tools, effort and model", () => {
    const base = replayKey(keyMaterial(req()));
    expect(replayKey(keyMaterial(req({ system: "x" })))).not.toBe(base);
    expect(replayKey(keyMaterial(req({ messages: [] })))).not.toBe(base);
    expect(replayKey(keyMaterial(req({ tools: [] })))).not.toBe(base);
    expect(replayKey(keyMaterial(req({ effort: "high" })))).not.toBe(base);
    expect(replayKey(keyMaterial(req({ model: "openai:gpt-6-sol" })))).not.toBe(base);
  });
});

describe("createReplayProvider", () => {
  it("records then replays the exact event stream", async () => {
    const answer: GenerateEvent[] = [{ type: "reasoning-delta", text: "thinking" }, ...toolCallTurn("t1", "write_file", { path: "src/app/pricing/page.tsx" })];
    const inner = scriptedProvider(answer);
    const recorder = createReplayProvider({ dir, mode: "record", inner });
    expect(await collect(recorder.generate(req()))).toEqual(answer);
    expect(inner.calls).toHaveLength(1);
    expect(await readdir(dir)).toHaveLength(1);

    const player = createReplayProvider({ dir, mode: "replay-or-fail" });
    expect(await collect(player.generate(req()))).toEqual(answer);
  });

  it("replay-or-fail throws a helpful miss listing the nearest keys", async () => {
    const recorder = createReplayProvider({ dir, mode: "record", inner: scriptedProvider(textTurn("hi")) });
    await collect(recorder.generate(req()));
    const player = createReplayProvider({ dir, mode: "replay-or-fail", inner: scriptedProvider(textTurn("never")) });
    const changed = req({ messages: [{ role: "user", content: "Add a pricing page" }, { role: "user", content: "and a FAQ" }] });
    const err = await collect(player.generate(changed)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ReplayMissError);
    const miss = err as ReplayMissError;
    expect(miss.nearest[0]?.key).toBe(replayKey(keyMaterial(req())));
    expect(miss.nearest[0]?.commonMessagePrefix).toBe(1);
    expect(miss.message).toMatch(/Nearest recordings/);
    expect(miss.message).toMatch(/messages \(recorded 1, requested 2, first 1 equal\)/);
  });

  it("replay-or-fail on an empty store says so and never calls inner", async () => {
    const inner = scriptedProvider(textTurn("never"));
    const player = createReplayProvider({ dir: join(dir, "missing"), mode: "replay-or-fail", inner });
    await expect(collect(player.generate(req()))).rejects.toThrow(/store is empty/);
    expect(inner.calls).toHaveLength(0);
  });

  it("replay mode falls through to inner on a miss and records it", async () => {
    const inner = scriptedProvider(textTurn("fresh"));
    const player = createReplayProvider({ dir, mode: "replay", inner });
    expect(await collect(player.generate(req()))).toEqual(textTurn("fresh"));
    expect(await collect(player.generate(req()))).toEqual(textTurn("fresh"));
    expect(inner.calls).toHaveLength(1);
  });

  it("does not save a stream that fails midway", async () => {
    const failing: Provider = {
      id: "failing",
      async *generate() {
        yield { type: "text-delta", text: "partial" } as GenerateEvent;
        throw new Error("upstream 529");
      },
    };
    const recorder = createReplayProvider({ dir, mode: "record", inner: failing });
    await expect(collect(recorder.generate(req()))).rejects.toThrow("upstream 529");
    expect(await readdir(dir).catch(() => [])).toHaveLength(0);
  });

  it("replay honours the abort signal", async () => {
    await collect(createReplayProvider({ dir, mode: "record", inner: scriptedProvider(textTurn("hi")) }).generate(req()));
    const ctrl = new AbortController();
    ctrl.abort();
    const player = createReplayProvider({ dir, mode: "replay-or-fail" });
    await expect(collect(player.generate(req({ abortSignal: ctrl.signal })))).rejects.toThrow(/aborted/);
  });
});

describe("scriptedProvider", () => {
  it("replays a fixed script and records calls", async () => {
    const p = scriptedProvider(textTurn("hello"));
    expect(await collect(p.generate(req()))).toEqual(textTurn("hello"));
    expect(p.calls[0]?.system).toBe("You are the frontend engineer.");
  });

  it("drives multi-turn loops from a function of the call index", async () => {
    const p = scriptedProvider((_r, i) => (i === 0 ? toolCallTurn("c1", "read_file", { path: "a" }) : textTurn("done")));
    const first = await collect(p.generate(req()));
    const second = await collect(p.generate(req()));
    expect(first.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
    expect(second.at(-1)).toEqual({ type: "finish", reason: "stop" });
    expect(p.calls).toHaveLength(2);
  });
});
