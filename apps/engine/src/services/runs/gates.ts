/**
 * Verification gates 1–6 (03 §6), run by the orchestrator (code, not an agent) inside
 * `forja-verify-<id>` with the template's own scripts (06 §3, `template.json` commands).
 *
 * What this protects:
 * - Gates are deterministic commands; a failure carries parsed errors (file, line,
 *   message) and the owner it is routed to, so fixes are targeted.
 * - Gate 3 migrates and seeds a FRESH `verify_<runId>` (the database is recreated first).
 * - Gate 6 ("production start-up"): phase 2 starts the standalone production server that
 *   gate 5 built, against the verification database, and requires `GET /api/health` 200.
 *   The full `docker build` of the project's Dockerfile needs an image-build port in
 *   `@forja/sandbox` and arrives with phase 3 (docs/architecture/08 "Estado fase 2").
 * - A tweak runs the reduced set (typecheck, lint, build); a question runs none.
 */
import type { Intent, ParsedGateError } from "@forja/contracts";
import type { ExecResult } from "@forja/agents";
import type { RunEnvironment } from "./environment.js";

export const GATE_NAMES = ["typecheck", "lint", "database", "tests", "build", "start"] as const;
export type GateName = (typeof GATE_NAMES)[number];

export type GateRoute = "fixer" | "database" | "owner";

export interface GateSpec {
  name: GateName;
  /** 1-based number in 03 §6. */
  number: number;
  command: string;
  timeoutSec: number;
  routedTo: GateRoute;
}

const START_SCRIPT = [
  "set -u",
  'test -f .next/standalone/server.js || { echo "no standalone build: .next/standalone/server.js is missing (next.config must keep output: standalone)"; exit 1; }',
  "PORT=3100 HOSTNAME=127.0.0.1 NODE_ENV=production node .next/standalone/server.js > /tmp/forja-gate-start.log 2>&1 &",
  "pid=$!",
  "trap 'kill $pid 2>/dev/null || true' EXIT",
  "for i in $(seq 1 60); do",
  "  if node -e \"fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"; then echo 'GET /api/health 200'; exit 0; fi",
  "  if ! kill -0 $pid 2>/dev/null; then echo 'the production server exited'; tail -n 40 /tmp/forja-gate-start.log; exit 1; fi",
  "  sleep 1",
  "done",
  "echo 'GET /api/health did not answer 200 within 60 s'; tail -n 40 /tmp/forja-gate-start.log; exit 1",
].join("\n");

export const GATES: Readonly<Record<GateName, GateSpec>> = {
  typecheck: { name: "typecheck", number: 1, command: "npm run --silent typecheck -- --pretty false", timeoutSec: 300, routedTo: "fixer" },
  lint: { name: "lint", number: 2, command: "npm run --silent lint", timeoutSec: 300, routedTo: "fixer" },
  database: { name: "database", number: 3, command: "npm run --silent db:migrate && npm run --silent db:seed", timeoutSec: 300, routedTo: "database" },
  tests: { name: "tests", number: 4, command: "npm run --silent test", timeoutSec: 600, routedTo: "owner" },
  build: { name: "build", number: 5, command: "npm run --silent build", timeoutSec: 900, routedTo: "owner" },
  start: { name: "start", number: 6, command: START_SCRIPT, timeoutSec: 150, routedTo: "owner" },
};

/** The gates of a run (03 §2 table: tweak = reduced set; question = none). */
export function gatesFor(intent: Intent, confidence = 1): GateName[] {
  if (intent === "question") return [];
  if (intent === "tweak" && confidence >= 0.6) return ["typecheck", "lint", "build"];
  return [...GATE_NAMES];
}

export interface GateResult {
  name: GateName;
  passed: boolean;
  command: string;
  exitCode: number | null;
  /** Tail of stdout + stderr (≤ 8 KB). */
  output: string;
  parsed: ParsedGateError[];
  durationMs: number;
}

const WORKSPACE_PREFIX = /^(?:\/workspace\/|\.\/)/;
const clean = (file: string) => file.trim().replace(WORKSPACE_PREFIX, "");

/** Errors of a gate's output: tsc, ESLint (stylish), Next build, Vitest, or the last lines. */
export function parseGateErrors(name: GateName, output: string): ParsedGateError[] {
  const out: ParsedGateError[] = [];
  const lines = output.split("\n");
  if (name === "lint") {
    let file: string | null = null;
    for (const line of lines) {
      const f = /^(\/workspace\/\S.*|\.?\/?[\w@.-][\w@./-]*\.[cm]?[jt]sx?)$/.exec(line.trim() === line ? line : "");
      if (f?.[1]) {
        file = clean(f[1]);
        continue;
      }
      const m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?$/.exec(line);
      if (m && file && m[3] === "error") out.push({ file, line: Number(m[1]), column: Number(m[2]), ...(m[5] ? { code: m[5] } : {}), message: (m[4] ?? "").trim() });
    }
  } else {
    for (const line of lines) {
      const tsc = /^(\S[^()]*)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
      if (tsc) {
        out.push({ file: clean(tsc[1] ?? ""), line: Number(tsc[2]), column: Number(tsc[3]), code: tsc[4], message: tsc[5] ?? "" });
        continue;
      }
      const loc = /((?:\/workspace\/|\.\/)?(?:src|app|tests|e2e|drizzle|scripts)\/[\w@./[\]()-]+\.[cm]?[jt]sx?):(\d+)(?::(\d+))?/.exec(line);
      if (loc) {
        const rest = line.slice((loc.index ?? 0) + loc[0].length).replace(/^[\s:-]+/, "").trim();
        out.push({ file: clean(loc[1] ?? ""), line: Number(loc[2]), ...(loc[3] ? { column: Number(loc[3]) } : {}), message: rest || line.trim() });
        continue;
      }
      const vitest = /^\s*(?:FAIL|×)\s+((?:tests|src|e2e)\/\S+\.[cm]?[jt]sx?)(?:\s+>\s+(.*))?$/.exec(line);
      if (vitest) out.push({ file: clean(vitest[1] ?? ""), message: (vitest[2] ?? "test failed").trim() });
    }
  }
  if (out.length === 0) {
    const tail = lines.map((l) => l.trim()).filter(Boolean).slice(-5);
    for (const message of tail) out.push({ message: message.slice(0, 500) });
  }
  // Dedupe and bound.
  const seen = new Set<string>();
  return out.filter((e) => {
    const k = `${e.file}:${e.line}:${e.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 50);
}

function tailBytes(text: string, max = 8 * 1024): string {
  return text.length <= max ? text : `…\n${text.slice(text.length - max)}`;
}

export async function runGate(env: RunEnvironment, name: GateName, abortSignal?: AbortSignal, now: () => number = Date.now): Promise<GateResult> {
  const spec = GATES[name];
  const t0 = now();
  if (name === "database") {
    try {
      await env.resetDatabase();
    } catch (err) {
      const output = `Could not recreate the verification database: ${err instanceof Error ? err.message : String(err)}`;
      return { name, passed: false, command: spec.command, exitCode: null, output, parsed: [{ message: output }], durationMs: now() - t0 };
    }
  }
  const r: ExecResult = await env.exec.run(spec.command, { timeoutSec: spec.timeoutSec, ...(abortSignal ? { abortSignal } : {}) });
  const output = tailBytes([r.stdout.trimEnd(), r.stderr.trimEnd()].filter(Boolean).join("\n") + (r.timedOut ? `\n[timed out after ${spec.timeoutSec}s]` : ""));
  const passed = r.exitCode === 0 && !r.timedOut;
  return { name, passed, command: spec.command, exitCode: r.exitCode, output, parsed: passed ? [] : parseGateErrors(name, output), durationMs: now() - t0 };
}

/** Stable identity of a failure, to detect "the same error twice in a row" (03 §6). */
export function failureSignature(r: GateResult): string {
  return `${r.name}|${r.parsed
    .slice(0, 5)
    .map((e) => `${e.file ?? ""}:${e.line ?? ""}:${e.message.slice(0, 120)}`)
    .join("|")}`;
}
