/**
 * What a run writes while it works: `run_events` (05 §4), conversation messages (05 §2.4),
 * the `llm_calls` ledger and the run's `spent_usd` (02 §6).
 *
 * What this protects:
 * - Event payloads over 8 KB go to a blob file under `runs/<runId>/blobs/` and the row
 *   keeps `blob_path` (05 §1); no text deltas are ever persisted.
 * - Loop events arrive synchronously; their writes are chained in order and awaited with
 *   `flush()`, so the ledger and the stream never interleave out of order.
 * - A failing write is logged, never thrown into the agent loop.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LoopEvent, ToolEvent } from "@forja/agents";
import type { AgentRole } from "@forja/contracts";
import type { EngineContext } from "../context.js";
import type { NewMessage } from "../../store/types.js";
import { projectRoot } from "../repo.js";
import type { BudgetSession, RunBudget } from "./budget.js";

export const EVENT_PAYLOAD_MAX_BYTES = 8 * 1024;

export interface SessionInfo {
  /** `tasks.id` (null for the director and closing sessions). */
  taskRowId: string | null;
  /** Plan task id for payloads (`director`, `closing`, `fix-2`…). */
  label: string;
  role: AgentRole;
  session: BudgetSession;
}

export class RunRecorder {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: EngineContext,
    readonly projectId: string,
    readonly runId: string,
    private readonly budget: RunBudget,
  ) {}

  private enqueue(fn: () => Promise<unknown>): void {
    this.chain = this.chain.then(fn).then(
      () => undefined,
      (err: unknown) => this.ctx.logger.warn({ err, runId: this.runId }, "run recorder write failed"),
    );
  }

  /** Waits for every queued write. */
  flush(): Promise<void> {
    return this.chain;
  }

  private async persist(type: string, payload: Record<string, unknown>, taskId: string | null): Promise<number> {
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") <= EVENT_PAYLOAD_MAX_BYTES) {
      return this.ctx.store.appendEvent({ runId: this.runId, taskId, type, payload });
    }
    const dir = path.join(projectRoot(this.ctx.config.DATA_DIR, this.projectId), "runs", this.runId, "blobs");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${type.replace(/[^a-z.]/g, "")}-${Math.random().toString(36).slice(2, 8)}.json`);
    await writeFile(file, json, { mode: 0o600 });
    return this.ctx.store.appendEvent({ runId: this.runId, taskId, type, payload: {}, blobPath: file });
  }

  /** Appends an event now (awaited). */
  async event(type: string, payload: Record<string, unknown>, taskRowId: string | null = null): Promise<void> {
    await this.flush();
    await this.persist(type, payload, taskRowId).catch((err: unknown) => this.ctx.logger.warn({ err, runId: this.runId, type }, "could not append run event"));
  }

  /** A conversation message (+ its `message` event). Awaited: the UI polls right after. */
  async message(m: Omit<NewMessage, "projectId" | "runId">): Promise<void> {
    await this.flush();
    await this.ctx.store.appendMessage({ ...m, projectId: this.projectId, runId: this.runId });
    await this.persist("message", { author: m.author, type: m.type, text: m.text.slice(0, 2000) }, null).catch(() => undefined);
  }

  toolEvent(info: SessionInfo, e: ToolEvent): void {
    if (e.type === "scope.violation") this.enqueue(() => this.persist("scope.violation", { taskId: info.label, path: e.path }, info.taskRowId));
    else if (e.type === "command.output") {
      this.enqueue(() => this.persist("command.output", { taskId: info.label, cmd: e.cmd, exitCode: e.exitCode, tail: e.tail.slice(-4000) }, info.taskRowId));
    }
    // file.written: the per-task commit carries the diff (file.diff events arrive with blobs in phase 3).
  }

  /** The loop observer: events, ledger rows and budget for one agent session. */
  loopEvent(info: SessionInfo, e: LoopEvent, route: { provider: string | null; model: string | null }): void {
    const taskId = info.taskRowId;
    switch (e.type) {
      case "route":
        route.provider = e.provider;
        route.model = e.model;
        break;
      case "turn.started":
        this.enqueue(() => this.persist("task.turn", { taskId: info.label, n: e.turn }, taskId));
        break;
      case "text":
        this.enqueue(() => this.persist("text", { taskId: info.label, role: info.role, text: e.text.slice(0, 7000) }, taskId));
        break;
      case "tool.call":
        this.enqueue(() => this.persist("tool.call", { taskId: info.label, name: e.name, argsSummary: e.argsSummary }, taskId));
        break;
      case "tool.result":
        this.enqueue(() => this.persist("tool.result", { taskId: info.label, name: e.name, ok: e.ok, summary: e.summary, durationMs: e.durationMs }, taskId));
        if (e.name === "submit_plan" && !e.ok) this.enqueue(() => this.persist("plan.rejected", { reason: e.summary }, taskId));
        break;
      case "context.compacted":
        this.enqueue(() => this.persist("context.compacted", { taskId: info.label, fromTurn: e.fromTurn, toTurn: e.toTurn, tokensBefore: e.tokensBefore, tokensAfter: e.tokensAfter }, taskId));
        break;
      case "usage": {
        info.session.add(e.costUsd);
        const crossed = this.budget.charge(e.costUsd);
        const spent = this.budget.spent;
        const budgetUsd = this.budget.totalUsd ?? 0;
        this.enqueue(async () => {
          await this.ctx.store.insertLlmCall({
            projectId: this.projectId,
            runId: this.runId,
            taskId,
            role: info.role,
            provider: e.provider ?? route.provider ?? "unknown",
            model: e.model ?? route.model ?? "unknown",
            inputTokens: e.input,
            outputTokens: e.output,
            cachedTokens: e.cachedInput,
            cacheWriteTokens: e.cacheWrite,
            costUsd: e.costUsd.toFixed(6),
            latencyMs: Math.round(e.latencyMs),
            ttftMs: e.ttftMs === null ? null : Math.round(e.ttftMs),
            outcome: "ok",
          });
          await this.ctx.store.updateRun(this.runId, { spentUsd: spent.toFixed(4) });
          if (taskId) await this.ctx.store.updateTask(taskId, { spentUsd: info.session.spent().toFixed(4) });
          await this.persist("cost.tick", { spentUsd: spent, budgetUsd }, taskId);
          if (crossed.warning) await this.persist("budget.warning", { spentUsd: spent, budgetUsd, ratio: this.budget.ratio() }, taskId);
          if (crossed.exhausted) await this.persist("budget.exhausted", { spentUsd: spent, budgetUsd }, taskId);
        });
        break;
      }
      case "llm.error":
        this.enqueue(() =>
          this.ctx.store.insertLlmCall({
            projectId: this.projectId,
            runId: this.runId,
            taskId,
            role: info.role,
            provider: e.provider ?? route.provider ?? "unknown",
            model: e.model ?? route.model ?? "unknown",
            outcome: "error",
            error: e.message.slice(0, 2000),
          }),
        );
        break;
      default:
        break;
    }
  }
}
