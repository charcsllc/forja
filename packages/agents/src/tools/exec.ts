/**
 * `bash`: shell commands in the verification container (11-tool-registry.md "Ejecución").
 *
 * What this protects: the container is the security boundary, not a blacklist (07, 10
 * risk 21). For roles whose table row restricts `bash` (fixer: tsc, eslint, prettier,
 * next build) every command segment must start with an allowed prefix; the refusal names
 * the allowed commands so the model can recover. Output is capped at 8 KB (head + tail),
 * the timeout at 600 s, and the tail goes to `command.output`.
 */
import { z } from "zod";
import { defineTool, fail, ok } from "./types.js";
import { lastLines, truncateBytes } from "./text.js";

export const BASH_MAX_OUTPUT_BYTES = 8 * 1024;
export const BASH_DEFAULT_TIMEOUT_SEC = 120;
export const BASH_MAX_TIMEOUT_SEC = 600;

/** Splits a command line on `&&`, `||`, `;`, `|` and newlines (quotes are not parsed: conservative). */
export function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, ""))
    .filter((s) => s.length > 0);
}

export function allowedByList(command: string, allowlist: readonly string[]): boolean {
  if (/[`]|\$\(/.test(command)) return false;
  const segments = commandSegments(command);
  return segments.length > 0 && segments.every((seg) => allowlist.some((prefix) => seg === prefix || seg.startsWith(`${prefix} `)));
}

export const bashTool = defineTool({
  name: "bash",
  kind: "exec",
  description: `Run a shell command in the project's verification container (cwd = project root, Node 22, npm). Use it to run checks: npm run typecheck, npm run lint, npm test, npm run build, npm run db:generate, npm run db:migrate. No TTY: never start servers or watchers. Output is capped at ${BASH_MAX_OUTPUT_BYTES / 1024} KB; timeout_sec defaults to ${BASH_DEFAULT_TIMEOUT_SEC} (max ${BASH_MAX_TIMEOUT_SEC}).`,
  input: z.object({
    command: z.string().min(1).max(4000),
    timeout_sec: z.number().int().min(1).max(BASH_MAX_TIMEOUT_SEC).optional(),
  }),
  summarize: (a) => a.command.slice(0, 200),
  async execute(args, ctx) {
    if (!ctx.exec) return fail("UNAVAILABLE: command execution is not available in this task.");
    if (ctx.bashAllowlist && !allowedByList(args.command, ctx.bashAllowlist)) {
      return fail(`COMMAND_NOT_ALLOWED: this task may only run: ${ctx.bashAllowlist.join(" | ")} (with arguments). Command substitution is not allowed.`);
    }
    const r = await ctx.exec.run(args.command, { timeoutSec: args.timeout_sec ?? BASH_DEFAULT_TIMEOUT_SEC, abortSignal: ctx.abortSignal });
    const body = [r.stdout.trimEnd() ? `--- stdout ---\n${r.stdout.trimEnd()}` : "", r.stderr.trimEnd() ? `--- stderr ---\n${r.stderr.trimEnd()}` : ""]
      .filter(Boolean)
      .join("\n");
    const shaped = truncateBytes(body || "(no output)", BASH_MAX_OUTPUT_BYTES, "rerun with a narrower command to see the omitted part");
    ctx.emit({ type: "command.output", cmd: args.command.slice(0, 500), exitCode: r.exitCode, tail: lastLines(`${r.stdout}\n${r.stderr}`.trim(), 20) });
    const head = r.timedOut
      ? `TIMED OUT after ${args.timeout_sec ?? BASH_DEFAULT_TIMEOUT_SEC}s (killed).`
      : `exit code ${r.exitCode ?? "unknown"} (${(r.durationMs / 1000).toFixed(1)}s)${r.truncated ? ", output truncated by the container" : ""}`;
    const content = `${head}\n${shaped.text}`;
    return r.exitCode === 0 && !r.timedOut ? ok(content, head) : fail(content, head);
  },
});
