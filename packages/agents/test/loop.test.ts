/**
 * The agent loop with the scripted provider. Protects: tool calls execute and feed back,
 * invalid arguments and unknown tools come back as errors, one nudge then `no-submit`,
 * rejected submissions can be fixed, abort/max-turns/budget/llm errors end cleanly,
 * `route` and `usage` are reported, native messages are echoed, compaction and XML work.
 */
import { scriptedProvider, textTurn, toolCallTurn, type GenerateEvent, type Provider } from "@forja/llm";
import { describe, expect, it } from "vitest";
import { runAgentLoop, type AgentLoopOptions, type LoopEvent } from "../src/runtime/loop.js";
import { toolsByName } from "../src/tools/registry.js";
import { budget, makeContext } from "./helpers.js";

const REPORT = { status: "done", summary: "Built it", filesChanged: ["src/app/about/page.tsx"], acceptance: [{ criterion: "renders", met: true, evidence: "tsc" }] };
const frontendTools = toolsByName(["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "submit_report"]);

function opts(provider: Provider, extra: Partial<AgentLoopOptions> = {}): AgentLoopOptions & { events: LoopEvent[] } {
  const events: LoopEvent[] = [];
  return {
    role: "frontend",
    provider,
    system: "system",
    messages: [{ role: "user", content: "Build the about page" }],
    tools: frontendTools,
    terminalTools: ["submit_report"],
    toolContext: makeContext(),
    budget: budget(),
    maxTurns: 10,
    maxOutputTokens: 1000,
    onEvent: (e) => events.push(e),
    ...extra,
    events,
  };
}

const route: GenerateEvent = { type: "route", provider: "nvidia", model: "z-ai/glm-5.3", attempt: 1 };

describe("runAgentLoop", () => {
  it("executes tools, feeds results back and ends on an accepted submit", async () => {
    const p = scriptedProvider((_req, i) =>
      i === 0
        ? [route, ...toolCallTurn("c1", "write_file", { path: "src/app/about/page.tsx", content: "export default function About() { return <h1>About</h1>; }\n" })]
        : [route, { type: "provider-message", raw: { native: true } }, ...toolCallTurn("c2", "submit_report", REPORT)],
    );
    const o = opts(p);
    const r = await runAgentLoop(o);
    expect(r.outcome).toBe("submitted");
    expect(r.submission?.tool).toBe("submit_report");
    expect(r.turns).toBe(2);
    // The second request carries the tool result of the first call.
    const second = p.calls[1]?.messages ?? [];
    expect(second.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1", name: "write_file" });
    expect((second.at(-1) as { content: string }).content).toContain("Created src/app/about/page.tsx");
    // Native echo and route/usage events.
    expect(r.messages.find((m) => m.role === "assistant" && m.native)).toMatchObject({ native: { provider: "nvidia", model: "z-ai/glm-5.3", raw: { native: true } } });
    expect(o.events.filter((e) => e.type === "route")).toHaveLength(2);
    expect(o.events.filter((e) => e.type === "usage")).toHaveLength(2);
    expect(p.calls[0]?.tools.map((t) => t.name)).toContain("submit_report");
    expect(p.calls[0]?.tools.find((t) => t.name === "write_file")?.inputSchema).toMatchObject({ type: "object", required: ["path", "content"] });
  });

  it("feeds back invalid arguments and unknown tools without executing them", async () => {
    const p = scriptedProvider((_req, i) =>
      i === 0
        ? [
            { type: "tool-call", id: "a", name: "write_file", args: { path: "src/app/x.tsx" } },
            { type: "tool-call", id: "b", name: "delete_everything", args: {} },
            { type: "finish", reason: "tool-calls" },
          ]
        : toolCallTurn("c", "submit_report", JSON.stringify(REPORT)),
    );
    const o = opts(p);
    const r = await runAgentLoop(o);
    expect(r.outcome).toBe("submitted");
    const results = p.calls[1]?.messages.filter((m) => m.role === "tool") as { content: string; isError?: boolean }[];
    expect(results[0]?.content).toMatch(/INVALID_ARGUMENTS for write_file[\s\S]*content/);
    expect(results[0]?.isError).toBe(true);
    expect(results[1]?.content).toMatch(/UNKNOWN_TOOL: there is no tool named "delete_everything"/);
    expect(await o.toolContext.workspace.stat("src/app/x.tsx")).toBeNull();
  });

  it("nudges once when the model answers with text, then submits", async () => {
    const p = scriptedProvider((_req, i) => (i === 0 ? textTurn("I have finished the page.") : toolCallTurn("c", "submit_report", REPORT)));
    const o = opts(p);
    const r = await runAgentLoop(o);
    expect(r.outcome).toBe("submitted");
    expect(o.events).toContainEqual({ type: "nudge", turn: 1, reason: "no-tool-call" });
    const nudge = p.calls[1]?.messages.at(-1);
    expect(nudge).toMatchObject({ role: "user" });
    expect((nudge as { content: string }).content).toContain("submit_report");
  });

  it("ends as no-submit with the last text after the second text-only answer", async () => {
    const p = scriptedProvider(() => textTurn("Done, trust me."));
    const r = await runAgentLoop(opts(p));
    expect(r.outcome).toBe("no-submit");
    expect(r.lastText).toBe("Done, trust me.");
    expect(p.calls).toHaveLength(2);
  });

  it("a rejected submission can be corrected", async () => {
    const p = scriptedProvider((_req, i) => toolCallTurn(`c${i}`, "submit_report", i === 0 ? { ...REPORT, status: "finished" } : REPORT));
    const r = await runAgentLoop(opts(p));
    expect(r.outcome).toBe("submitted");
    expect(r.turns).toBe(2);
  });

  it("injected submit validators reject and the loop continues", async () => {
    let seen = 0;
    const ctx = makeContext({ submitValidators: { submit_report: () => (seen++ === 0 ? ["acceptance must not be empty"] : []) } });
    const p = scriptedProvider((_req, i) => toolCallTurn(`c${i}`, "submit_report", REPORT));
    const r = await runAgentLoop(opts(p, { toolContext: ctx }));
    expect(r.outcome).toBe("submitted");
    const firstResult = p.calls[1]?.messages.at(-1) as { content: string };
    expect(firstResult.content).toContain("acceptance must not be empty");
  });

  it("stops at max turns", async () => {
    const p = scriptedProvider((_req, i) => toolCallTurn(`c${i}`, "list_dir", { path: "." }));
    const r = await runAgentLoop(opts(p, { maxTurns: 3 }));
    expect(r.outcome).toBe("max-turns");
    expect(p.calls).toHaveLength(3);
  });

  it("stops when the budget is exhausted before a turn", async () => {
    const b = budget(0.01);
    const p = scriptedProvider(() => [
      { type: "tool-call", id: "x", name: "list_dir", args: { path: "." } },
      { type: "usage", input: 10, output: 10, cachedInput: 0, cacheWrite: 0, costUsd: 0.02 },
      { type: "finish", reason: "tool-calls" },
    ]);
    const r = await runAgentLoop(opts(p, { budget: b, onEvent: (e) => e.type === "usage" && b.charge(e.costUsd) }));
    expect(r.outcome).toBe("budget");
    expect(r.usage.costUsd).toBeCloseTo(0.02);
  });

  it("aborts mid-stream", async () => {
    const ac = new AbortController();
    const slow: Provider = {
      id: "slow",
      async *generate(req) {
        yield route;
        ac.abort();
        if (req.abortSignal.aborted) {
          const e = new Error("aborted");
          e.name = "AbortError";
          throw e;
        }
        yield* textTurn("never");
      },
    };
    const r = await runAgentLoop(opts(slow, { toolContext: makeContext({ abortSignal: ac.signal }) }));
    expect(r.outcome).toBe("aborted");
  });

  it("reports provider errors as llm-error", async () => {
    const broken: Provider = {
      id: "broken",
      // eslint-disable-next-line require-yield
      async *generate() {
        throw new Error("401 from provider");
      },
    };
    const o = opts(broken);
    const r = await runAgentLoop(o);
    expect(r.outcome).toBe("llm-error");
    expect(o.events).toContainEqual(expect.objectContaining({ type: "llm.error", message: "401 from provider" }));
  });

  it("times out a stuck turn", async () => {
    const stuck: Provider = {
      id: "stuck",
      async *generate(req) {
        yield route;
        await new Promise((_resolve, reject) => req.abortSignal.addEventListener("abort", () => reject(new Error("aborted by signal"))));
      },
    };
    const o = opts(stuck, { turnTimeoutMs: 30 });
    const r = await runAgentLoop(o);
    expect(r.outcome).toBe("llm-error");
    expect(o.events).toContainEqual(expect.objectContaining({ type: "llm.error", message: expect.stringContaining("did not answer") }));
  });

  it("continues after an output-limit cut without spending the nudge", async () => {
    const p = scriptedProvider((_req, i) =>
      i === 0 ? [{ type: "text-delta", text: "export default" }, { type: "finish", reason: "length" }] : toolCallTurn("c", "submit_report", REPORT),
    );
    const o = opts(p, { maxNudges: 0 });
    const r = await runAgentLoop(o);
    expect(r.outcome).toBe("submitted");
    expect(o.events).toContainEqual({ type: "nudge", turn: 1, reason: "output-limit" });
  });

  it("redacts secrets in tool output before the model sees them", async () => {
    const ctx = makeContext();
    await ctx.workspace.writeFile("src/app/config.ts", new TextEncoder().encode('const key = "super-secret-value";\n'));
    const p = scriptedProvider((_req, i) => (i === 0 ? toolCallTurn("r", "read_file", { path: "src/app/config.ts" }) : toolCallTurn("s", "submit_report", REPORT)));
    await runAgentLoop(opts(p, { toolContext: ctx }));
    const result = p.calls[1]?.messages.at(-1) as { content: string };
    expect(result.content).toContain("[redacted]");
    expect(result.content).not.toContain("super-secret-value");
  });

  it("compacts past the soft limit with the summarizer, keeping the task and the last turn", async () => {
    const big = "x".repeat(8000);
    const p = scriptedProvider((_req, i) => (i < 3 ? toolCallTurn(`c${i}`, "list_dir", { path: "." }) : toolCallTurn("s", "submit_report", REPORT)));
    const summaries: number[] = [];
    const o = opts(p, {
      messages: [{ role: "user", content: `TASK ${big}` }],
      contextTokens: 3000,
      softLimit: 0.6,
      compact: async (older) => {
        summaries.push(older.length);
        return "## Context summary\nlisted the root";
      },
    });
    const r = await runAgentLoop(o);
    expect(r.outcome).toBe("submitted");
    expect(summaries.length).toBeGreaterThan(0);
    const compacted = o.events.find((e) => e.type === "context.compacted");
    expect(compacted).toBeDefined();
    const later = p.calls.at(-1)?.messages ?? [];
    expect((later[0] as { content: string }).content).toMatch(/^TASK x+[\s\S]*\[context summary\]/);
    expect(later[1]?.role).toBe("assistant");
  });

  it("speaks the XML protocol when asked", async () => {
    const p = scriptedProvider((_req, i) =>
      i === 0 ? textTurn('Listing.\n<tool name="list_dir">{"path": "."}</tool>') : textTurn(`<tool name="submit_report">${JSON.stringify(REPORT)}</tool>`),
    );
    const r = await runAgentLoop(opts(p, { protocol: "xml" }));
    expect(r.outcome).toBe("submitted");
    expect(p.calls[0]?.tools).toEqual([]);
    expect(p.calls[0]?.system).toContain("## Tool protocol");
    expect(p.calls[1]?.messages.at(-1)).toMatchObject({ role: "user" });
    expect((p.calls[1]?.messages.at(-1) as { content: string }).content).toContain('<tool_result name="list_dir">');
  });
});
