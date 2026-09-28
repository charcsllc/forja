/**
 * Runs, synchronous half (05 §2.1, 03 §8): what `agent/start`, `launch`, `agent/stop`,
 * `agent/status` and `full-conversation` do BEFORE they answer, plus crash recovery.
 *
 * ⭐ THE SYNCHRONOUS HALF IS THE CONTRACT (research/02 §3.3, packages/contract-tests):
 * `agent/start` persists the user message and creates the run (project
 * `agentProcessStatus = init`) before it answers, so the UI's first poll sees `init`.
 * The terminal status is written only AFTER the run's final message, so the UI's
 * conversation refetch on `done` always finds it.
 *
 * Other invariants:
 * - One non-terminal run per project (unique index) → `AGENT_RUNNING` 409.
 * - An LLM configuration that cannot serve the phase-2 roles refuses `agent/start` with a
 *   localized message naming what to configure; the engine itself stays up.
 * - The UI's `model`/`effort`/`fastMode` hints never fail a request: `effort` is applied,
 *   the others come back as `warnings` (02 §3).
 * - A run whose worker vanished (heartbeat stale, not running in this process) is closed
 *   with a clear message instead of leaving the UI waiting forever.
 */
import {
  DEFAULT_LANGUAGE,
  detectLanguage,
  isLanguage,
  isTerminalRunStatus,
  t,
  toAgentProcessStatus,
  type AgentStatus,
  type ConversationHistory,
  type ConversationMessage,
  type Language,
  type RunStatus,
} from "@forja/contracts";
import { EngineError, engineError } from "../../http/errors.js";
import type { MessageRow, NewMessage, ProjectRow, RunRow } from "../../store/types.js";
import type { EngineContext } from "../context.js";
import { requireLive } from "../lifecycle.js";

export const HEARTBEAT_MS = 20_000;
/** A running run whose heartbeat is older than this, and that no local worker holds, is orphaned. */
export const HEARTBEAT_STALE_MS = 3 * 60_000;
/** A queued run (`received`) is only orphaned after this long (runs ahead of it may be long). */
export const QUEUED_STALE_MS = 12 * 60 * 60_000;

/** Default estimates in minutes per intent (05 §2.1), replaced by the median of history. */
export const DEFAULT_EXPECTED_MINUTES: Readonly<Record<string, number>> = {
  full: 8,
  feature: 6,
  refactor: 6,
  infra: 5,
  bugfix: 4,
  tweak: 2,
  question: 1,
};

// ── In-process control of executing runs ─────────────────────────────────────

const LOCAL_RUNS = new Map<string, AbortController>();

export function registerRunControl(runId: string): AbortController {
  const c = new AbortController();
  LOCAL_RUNS.set(runId, c);
  return c;
}

export function unregisterRunControl(runId: string): void {
  LOCAL_RUNS.delete(runId);
}

export function isRunLocal(runId: string): boolean {
  return LOCAL_RUNS.has(runId);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function projectLanguage(p: Pick<ProjectRow, "language">): Language {
  return isLanguage(p.language) ? p.language : DEFAULT_LANGUAGE;
}

export async function expectedMinutes(ctx: EngineContext, intent: string): Promise<number> {
  const history = await ctx.store.recentRunMinutes(intent, 20).catch(() => []);
  if (history.length === 0) return DEFAULT_EXPECTED_MINUTES[intent] ?? 5;
  const sorted = [...history].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? 5;
  return Math.max(1, Math.round(mid));
}

export function toConversationMessage(m: MessageRow): ConversationMessage {
  const keys = m.secretKeysNeeded as unknown;
  const files = m.files as unknown;
  return {
    author: m.author as ConversationMessage["author"],
    message: m.text,
    messageType: m.type as ConversationMessage["messageType"],
    createdAt: m.createdAt.toISOString(),
    ...(m.versionId ? { versionId: m.versionId } : {}),
    ...(keys && typeof keys === "object" && !Array.isArray(keys) && Object.keys(keys).length > 0
      ? { secretKeysNeeded: keys as ConversationMessage["secretKeysNeeded"] }
      : {}),
    ...(Array.isArray(files) && files.length > 0 ? { files: files as ConversationMessage["files"] } : {}),
  };
}

function isStale(run: RunRow, now: number): boolean {
  if (isTerminalRunStatus(run.status as RunStatus) || isRunLocal(run.id)) return false;
  const beat = (run.heartbeatAt ?? run.createdAt).getTime();
  return now - beat > (run.status === "received" ? QUEUED_STALE_MS : HEARTBEAT_STALE_MS);
}

export interface FinalMessage {
  type: NewMessage["type"];
  text: string;
  versionId?: string | null;
  secretKeysNeeded?: NewMessage["secretKeysNeeded"];
}

/**
 * Closes a run: final message first, then the terminal status, `run.finished` and the
 * project projection. Idempotent: a run already terminal is left alone.
 */
export async function finalizeRun(
  ctx: EngineContext,
  runId: string,
  outcome: { status: "done" | "failed" | "limit-reached" | "cancelled"; message?: FinalMessage; error?: string },
): Promise<void> {
  const run = await ctx.store.getRun(runId);
  if (!run || isTerminalRunStatus(run.status as RunStatus)) return;
  if (outcome.message) {
    await ctx.store.appendMessage({
      projectId: run.projectId,
      runId,
      author: "agent",
      type: outcome.message.type,
      text: outcome.message.text,
      versionId: outcome.message.versionId ?? null,
      ...(outcome.message.secretKeysNeeded ? { secretKeysNeeded: outcome.message.secretKeysNeeded } : {}),
    });
    await ctx.store
      .appendEvent({ runId, type: "message", payload: { author: "agent", type: outcome.message.type, text: outcome.message.text.slice(0, 2000) } })
      .catch(() => 0);
  }
  await ctx.store.updateRun(runId, { status: outcome.status, finishedAt: new Date(), ...(outcome.error ? { error: outcome.error.slice(0, 4000) } : {}) });
  await ctx.store
    .appendEvent({ runId, type: "run.finished", payload: { status: outcome.status, summary: outcome.message?.text.slice(0, 500) ?? "", cost: { usd: Number(run.spentUsd) } } })
    .catch(() => 0);
  const latest = await ctx.store.latestRun(run.projectId);
  if (!latest || latest.id === runId) await ctx.store.updateProject(run.projectId, { processStatus: "done", lastActivityAt: new Date() });
}

/** Closes an orphaned run (stale heartbeat or engine restart) and frees its resources. */
async function closeOrphan(ctx: EngineContext, run: RunRow, reason: "interrupted" | "cancelled"): Promise<void> {
  const project = await ctx.store.getProject(run.projectId, { includeDeleted: true });
  const lang = project ? projectLanguage(project) : DEFAULT_LANGUAGE;
  await finalizeRun(ctx, run.id, {
    status: reason === "cancelled" ? "cancelled" : "failed",
    message: { type: "error", text: t(lang, reason === "cancelled" ? "run.stoppedByUser" : "run.interrupted") },
    error: reason === "cancelled" ? "stopped by the user" : "orphaned: the worker disappeared (engine restart)",
  });
  // Best effort: the verify container and the checkout (the branch stays for inspection).
  await ctx.sandbox.destroyVerify(run.projectId, run.id).catch(() => undefined);
  await ctx.repo(run.projectId).removeRunCheckout(run.id, { deleteBranch: false }).catch(() => undefined);
}

// ── agent/start and launch ───────────────────────────────────────────────────

export interface StartRunInput {
  prompt: string;
  inputFiles: { name: string; url: string; imageDescription: string }[];
  model?: unknown;
  effort?: unknown;
  fastMode?: unknown;
}

export interface RunWarning {
  step: string;
  code: string;
  message: string;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The synchronous half of a run. Throws `EngineError`s the v1 envelope carries. */
export async function startRun(ctx: EngineContext, p: ProjectRow, input: StartRunInput): Promise<{ run: RunRow; warnings: RunWarning[] }> {
  const previous = await ctx.store.latestRun(p.id);
  const lang = previous ? projectLanguage(p) : detectLanguage(input.prompt);

  const reason = ctx.llm.unavailableReason();
  if (reason) throw engineError("NO_PROVIDER_ENABLED", t(lang, "run.rolesUnsatisfiable", { details: reason }));

  if (previous && !isTerminalRunStatus(previous.status as RunStatus)) {
    if (isStale(previous, Date.now())) await closeOrphan(ctx, previous, "interrupted");
    else throw engineError("AGENT_RUNNING", "The agent is already working on this project; wait until it finishes or stop it.");
  }

  // A sleeping or broken sandbox answers like every sandbox endpoint (05 §2.2); a sandbox
  // still being created is fine: the run waits for it.
  if (p.serverStatus === "Archived" || (p.serverError && p.serverStatus !== "Active")) await requireLive(ctx, p);
  const op = await ctx.store.getOperation(p.id);
  if (op && op.expiresAt.getTime() > Date.now() && !["provision", "wake"].includes(op.kind)) {
    throw engineError("OPERATION_IN_PROGRESS", `Another operation (${op.kind}) is running on this project; try again when it finishes.`, { operation: op.kind });
  }

  const since = monthStart();
  const projectBudget = ctx.config.BUDGET_PER_PROJECT_MONTH_USD;
  if (projectBudget !== null && (await ctx.store.monthSpentUsd(since, p.id)) >= projectBudget) {
    throw new EngineError(402, "INSUFFICIENT_CREDITS", `This project used its monthly budget (${projectBudget} USD).`);
  }
  const globalBudget = ctx.config.BUDGET_GLOBAL_MONTH_USD;
  if (globalBudget !== null && (await ctx.store.monthSpentUsd(since)) >= globalBudget) {
    throw new EngineError(402, "INSUFFICIENT_CREDITS", `This builder used its monthly budget (${globalBudget} USD).`);
  }

  const warnings: RunWarning[] = [];
  const options: Record<string, unknown> = {};
  if (typeof input.effort === "string" && EFFORTS.has(input.effort)) options.effort = input.effort;
  else if (input.effort !== undefined) warnings.push({ step: "options", code: "HINT_IGNORED", message: `effort "${String(input.effort)}" is not one of low, medium, high, xhigh; the default is used.` });
  if (input.model !== undefined) {
    options.modelHint = input.model;
    warnings.push({ step: "options", code: "HINT_IGNORED", message: `model "${String(input.model)}" is ignored: each role uses the model configured for it on this engine (AGENT_<ROLE>_MODEL).` });
  }
  if (input.fastMode !== undefined) {
    options.fastModeHint = input.fastMode;
    warnings.push({ step: "options", code: "HINT_IGNORED", message: "fastMode is ignored: speed follows the models configured on this engine." });
  }

  if (!previous && lang !== p.language) await ctx.store.updateProject(p.id, { language: lang });

  const now = new Date();
  const run = await ctx.store.insertRun({
    projectId: p.id,
    status: "received",
    prompt: input.prompt,
    inputFiles: input.inputFiles,
    options,
    budgetUsd: ctx.config.BUDGET_PER_RUN_USD === null ? null : ctx.config.BUDGET_PER_RUN_USD.toFixed(4),
    startedAt: now,
    heartbeatAt: now,
    expectedMinutes: await expectedMinutes(ctx, previous ? "feature" : "full"),
  });
  if (!run) throw engineError("AGENT_RUNNING", "The agent is already working on this project; wait until it finishes or stop it.");
  // Before the job is queued, so its createdAt precedes every agent message of the run.
  await ctx.store.appendMessage({ projectId: p.id, runId: run.id, author: "user", type: "regular", text: input.prompt, files: input.inputFiles });
  await ctx.store.updateProject(p.id, { processStatus: "init", lastActivityAt: now });
  await ctx.store.appendEvent({ runId: run.id, type: "run.received", payload: { promptPreview: input.prompt.slice(0, 200), inputFileCount: input.inputFiles.length } });
  await ctx.queue.send("run.execute", { projectId: p.id, token: run.id, runId: run.id });
  return { run, warnings };
}

// ── agent/stop ───────────────────────────────────────────────────────────────

export async function stopRun(ctx: EngineContext, p: ProjectRow): Promise<{ runId: string; status: string }> {
  const run = await ctx.store.latestRun(p.id);
  if (!run || isTerminalRunStatus(run.status as RunStatus)) throw engineError("NO_PROCESS_RUNNING", "No agent run is in progress.");
  const local = LOCAL_RUNS.get(run.id);
  if (run.status === "received" && !local) {
    // Queued, not started: nothing to abort. The job finds it terminal and returns.
    await closeOrphan(ctx, run, "cancelled");
    return { runId: run.id, status: "cancelled" };
  }
  await ctx.store.updateRun(run.id, { cancelRequestedAt: new Date(), status: "cancelling" });
  await ctx.store.appendEvent({ runId: run.id, type: "run.phase", payload: { from: run.status, to: "cancelling" } }).catch(() => 0);
  if (local) local.abort();
  else if (isStale(run, Date.now())) await closeOrphan(ctx, run, "cancelled");
  return { runId: run.id, status: "cancelling" };
}

// ── agent/status and full-conversation ───────────────────────────────────────

export async function agentStatus(ctx: EngineContext, p: ProjectRow): Promise<AgentStatus> {
  let run = await ctx.store.latestRun(p.id);
  if (run && isStale(run, Date.now())) {
    await closeOrphan(ctx, run, run.cancelRequestedAt ? "cancelled" : "interrupted");
    run = await ctx.store.getRun(run.id);
  }
  if (!run) {
    return { projectId: p.id, status: "idle", startedAt: null, realtimeConversation: [], expectedMinutes: null, expectedFinishAt: null };
  }
  const status = toAgentProcessStatus(run.status as RunStatus);
  const messages = await ctx.store.listMessages(p.id, { runId: run.id });
  const started = run.startedAt ?? run.createdAt;
  const expected = run.expectedMinutes;
  return {
    projectId: p.id,
    status,
    startedAt: started.toISOString(),
    realtimeConversation: messages.map(toConversationMessage),
    creditsSpent: Number(run.spentUsd),
    expectedMinutes: status === "init" ? expected : null,
    expectedFinishAt: status === "init" && expected ? new Date(started.getTime() + expected * 60_000).toISOString() : null,
  };
}

export async function fullConversation(ctx: EngineContext, p: ProjectRow, q: { limit?: number; offsetFromEnd?: number } = {}): Promise<ConversationHistory> {
  const all = (await ctx.store.listMessages(p.id)).map(toConversationMessage);
  if (q.limit === undefined) return { conversation: all, totalCount: all.length, hasMore: false };
  const end = Math.max(0, all.length - (q.offsetFromEnd ?? 0));
  const start = Math.max(0, end - q.limit);
  return { conversation: all.slice(start, end), totalCount: all.length, hasMore: start > 0 };
}

// ── Boot recovery ────────────────────────────────────────────────────────────

/**
 * At boot: queued runs (`received`) are sent to the queue again (idempotent: one job per
 * run id); every other non-terminal run lost its worker with the previous process (one
 * engine instance) and is closed with "interrupted", its branch kept. Resuming a run from
 * its checkpoints is phase 3 (03 §8).
 */
export async function recoverRuns(ctx: EngineContext): Promise<{ requeued: string[]; closed: string[] }> {
  const requeued: string[] = [];
  const closed: string[] = [];
  const now = Date.now();
  for (const run of await ctx.store.listActiveRuns()) {
    if (run.status === "received" && !run.cancelRequestedAt && now - run.createdAt.getTime() < QUEUED_STALE_MS) {
      await ctx.queue.send("run.execute", { projectId: run.projectId, token: run.id, runId: run.id });
      requeued.push(run.id);
    } else {
      await closeOrphan(ctx, run, run.cancelRequestedAt ? "cancelled" : "interrupted");
      closed.push(run.id);
    }
  }
  return { requeued, closed };
}
