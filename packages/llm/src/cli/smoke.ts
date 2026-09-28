/**
 * `npm run llm:smoke -- --provider <id> [--model <id>] [--tools] --yes-spend-one-request`
 *
 * What this file protects:
 * - Exactly one request: it calls the provider's adapter directly (no gateway, so no
 *   retries, no fallbacks), with at most 256 output tokens.
 * - The key is never printed: output is the route, timings, finish reason, usage, tool
 *   calls and a slice of the text.
 * - Run it by hand only; tests cover the argument parsing, never this file.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseProviderEnv } from "../env.js";
import { buildRegistry } from "../gateway/registry.js";
import type { GenerateEvent, GenerateRequest } from "../types.js";
import { parseSmokeArgs, SMOKE_USAGE } from "./smoke-args.js";

const MAX_OUTPUT_TOKENS = 256;

async function main(argv: string[]): Promise<number> {
  const parsed = parseSmokeArgs(argv);
  if (!parsed.ok) {
    if (parsed.error) console.error(`llm:smoke: ${parsed.error}\n`);
    console.error(SMOKE_USAGE);
    return parsed.help ? 0 : 2;
  }
  const args = parsed.args;
  if (args.envFile) process.loadEnvFile(resolve(process.env.INIT_CWD ?? process.cwd(), args.envFile));

  const report = parseProviderEnv(process.env);
  const registry = buildRegistry(report);
  const provider = registry.providers.get(args.provider);
  if (!provider) {
    const entry = report.providers.find((p) => p.kind === "llm" && p.id === args.provider);
    const skipped = registry.skipped.find((s) => s.id === args.provider);
    const why = !entry ? "unknown provider id" : skipped ? skipped.reason : `status ${entry.status}${entry.reasons.length ? ` (${entry.reasons.join("; ")})` : ""}`;
    console.error(`llm:smoke: provider ${args.provider} cannot be called: ${why}`);
    return 2;
  }
  const model = args.model
    ? provider.models.find((m) => m.id === args.model)
    : (args.tools ? provider.models.find((m) => m.capabilities.nativeTools) : undefined) ?? provider.models[0];
  if (!model) {
    console.error(`llm:smoke: no such model on ${args.provider}. Known: ${provider.models.map((m) => m.id).join(", ") || "none"}`);
    return 2;
  }

  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const req: GenerateRequest = {
    role: "director",
    system: "You are a coding agent. Use tools when needed. Be brief.",
    messages: [{ role: "user", content: args.tools ? "Read the file src/app/page.tsx using the tool." : "Reply with the single word: pong." }],
    tools: args.tools
      ? [{ name: "read_file", description: "Read a file from the project", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }]
      : [],
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    abortSignal: controller.signal,
    budget: { remainingUsd: () => Number.POSITIVE_INFINITY, charge: () => undefined },
  };

  console.log(`route      ${args.provider}:${model.id} (one request, max ${MAX_OUTPUT_TOKENS} output tokens${args.tools ? ", read_file tool offered" : ""})`);
  const started = Date.now();
  let firstOutputMs: number | undefined;
  let text = "";
  let reasoning = "";
  const events: GenerateEvent[] = [];
  try {
    for await (const ev of provider.adapter.stream(model, req)) {
      if (firstOutputMs === undefined && (ev.type === "text-delta" || ev.type === "reasoning-delta" || ev.type === "tool-call")) firstOutputMs = Date.now() - started;
      if (ev.type === "text-delta") text += ev.text;
      if (ev.type === "reasoning-delta") reasoning += ev.text;
      events.push(ev);
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error(`error      ${e.code ?? "unknown"}: ${e.message ?? String(err)} (after ${Date.now() - started} ms)`);
    return 1;
  }
  const total = Date.now() - started;
  console.log(`latency    first output ${firstOutputMs ?? "-"} ms · total ${total} ms`);
  for (const ev of events) {
    if (ev.type === "finish") console.log(`finish     ${ev.reason}`);
    if (ev.type === "usage") console.log(`usage      input ${ev.input} · cached ${ev.cachedInput} · output ${ev.output} · cost $${ev.costUsd.toFixed(6)}`);
    if (ev.type === "tool-call") console.log(`tool call  ${ev.name} ${JSON.stringify(ev.args)} (id ${ev.id})`);
  }
  if (reasoning) console.log(`reasoning  ${reasoning.length} chars`);
  if (text) console.log(`text       ${text.length > 500 ? `${text.slice(0, 500)}…` : text}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
