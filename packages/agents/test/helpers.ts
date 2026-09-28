/**
 * Test helpers: a temp-dir workspace, a tool context with recording `emit`, and fakes for
 * the exec/db/git/image ports. Protects: agent tests never touch Docker, git or a network.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ImageSourcingPort } from "@forja/contracts/media";
import type { BudgetHandle } from "@forja/llm";
import { LocalWorkspace } from "../src/tools/local-workspace.js";
import { createRedactor } from "../src/tools/redact.js";
import type { ExecPort, ExecResult, ToolContext, ToolEvent } from "../src/tools/types.js";

export function tempWorkspace(): { root: string; ws: LocalWorkspace } {
  const root = mkdtempSync(path.join(tmpdir(), "forja-agents-"));
  return { root, ws: new LocalWorkspace(root) };
}

export class FakeExec implements ExecPort {
  readonly commands: string[] = [];
  next: Partial<ExecResult> = {};
  async run(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return { exitCode: 0, stdout: "ok\n", stderr: "", truncated: false, timedOut: false, durationMs: 5, ...this.next };
  }
}

export function makeContext(overrides: Partial<ToolContext> = {}): ToolContext & { events: ToolEvent[] } {
  const events: ToolEvent[] = [];
  const { ws } = tempWorkspace();
  return {
    projectId: "demo",
    runId: "run-1",
    taskId: "t1",
    role: "frontend",
    scopeWrite: ["src/app/**"],
    workspace: ws,
    redact: createRedactor(["super-secret-value"]),
    emit: (e) => events.push(e),
    abortSignal: new AbortController().signal,
    ...overrides,
    events,
  };
}

export function budget(usd = 10): BudgetHandle & { spent: number } {
  const b = {
    spent: 0,
    remainingUsd: () => usd - b.spent,
    charge: (c: number) => {
      b.spent += c;
    },
  };
  return b;
}

export const fakeImages = (): ImageSourcingPort & { calls: string[]; reads: (Uint8Array | null)[] } => {
  const calls: string[] = [];
  const reads: (Uint8Array | null)[] = [];
  return {
    calls,
    reads,
    async setting() {
      return { mode: "web-search", source: "env", envDefault: "web-search", generationAvailable: false };
    },
    async find(req, ctx) {
      calls.push(req.slot);
      reads.push((await ctx.readFile?.("public/images/credits.json")) ?? null);
      await ctx.writeFile(`public/images/${req.slot}.jpg`, new Uint8Array([1, 2, 3]));
      return {
        path: `public/images/${req.slot}.jpg`,
        publicUrl: `/images/${req.slot}.jpg`,
        width: 1200,
        height: 800,
        mediaType: "image/jpeg",
        alt: req.alt,
        mode: "web-search",
        attribution: { provider: "openverse", license: "CC BY 4.0", attributionRequired: true, author: "Ada" },
      };
    },
  };
};
