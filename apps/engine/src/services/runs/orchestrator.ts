/**
 * The run orchestrator (03 §2–§6): the `run.execute` job body.
 *
 *   received → directing (intent, plan | answer) → modelling/implementing (tasks, one after
 *   another on `run/<runId>`) → verifying (gates 1–6, fix rounds) → finishing (merge, tag,
 *   dev database, closing message) → done | failed | limit-reached | cancelled
 *
 * What this protects:
 * - Every run ends with exactly one terminal status and, BEFORE it, one final message of
 *   the 05 §2.4 table (finished / error / limit-reached), whatever happens: model errors,
 *   crashes of a step, budget, stop. Nothing is left `init` forever.
 * - Work reaches `main` only through a merge at the end of a run; a stopped or failed run
 *   commits its partial work on its branch and never merges (03 §8).
 * - Tasks run sequentially, each inside its write scope; a task without dependencies
 *   satisfied is skipped, never run on a half-built base.
 * - Retry policy is the single table of 03 §6 (AGENT_* settings): local gate retries per
 *   task, fix rounds per run, fixer passes, "same error twice in a row" stops the loop.
 * - Budget: 65 / 25 / 10 split; past 90 % no new work starts and the run closes as
 *   `limit-reached` with what was left out (02 §6).
 * - Cancellation: `agent/stop` aborts the in-flight model call within one stream event
 *   (in-process AbortController) or on the next heartbeat (another process).
 */
import {
  DIRECTOR_AFTER_INTENT,
  PLANNABLE_ROLES,
  assembleSystemPrompt,
  createRedactor,
  createSummarizerCompactor,
  renderClosingContext,
  renderDirectorIntake,
  renderFixContext,
  renderLocalGateRework,
  renderTaskContext,
  roleDefinition,
  runAgentLoop,
  toolsByName,
  type LoopResult,
  type ToolContext,
} from "@forja/agents";
import {
  DirectorMessageSchema,
  IntentClassificationSchema,
  RunPlanSchema,
  TaskReportSchema,
  gatesProgressMessage,
  isTerminalRunStatus,
  messages as catalog,
  phaseMessage,
  scopeCoversPath,
  t,
  taskStartedMessage,
  type AgentRole,
  type Intent,
  type Language,
  type RunPlan,
  type RunStatus,
  type Task,
  type TaskReport,
} from "@forja/contracts";
import { LlmConfigError, LlmError, type AgentMessage, type Effort } from "@forja/llm";
import type { ProjectRow, RunRow } from "../../store/types.js";
import type { EngineContext } from "../context.js";
import { dbPasswords, renderAppEnv, startWake } from "../lifecycle.js";
import { RunBudget } from "./budget.js";
import { dockerRunEnvironments, type RunEnvironment, type RunEnvironmentFactory } from "./environment.js";
import { failureSignature, gatesFor, GATES, runGate, type GateName, type GateResult } from "./gates.js";
import { RunRecorder, type SessionInfo } from "./recorder.js";
import { HEARTBEAT_MS, expectedMinutes, finalizeRun, projectLanguage, registerRunControl, unregisterRunControl, type FinalMessage } from "./service.js";

export const MAX_PLAN_TASKS = 10;
const SANDBOX_WAIT_MS = 30 * 60_000;
const CLOSING_TURNS = 3;

export class RunCancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelled";
  }
}

export class RunFailure extends Error {
  constructor(
    readonly userMessage: string,
    detail: string,
  ) {
    super(detail);
    this.name = "RunFailure";
  }
}

export interface ExecuteRunOptions {
  environments?: RunEnvironmentFactory;
  /** Poll of the sandbox wait (tests shorten it). */
  pollMs?: number;
  heartbeatMs?: number;
  sandboxWaitMs?: number;
}

/** Deterministic plan rules of this phase, on top of `validatePlan` (03 §3). */
export function phase2PlanRules(payload: unknown): string[] {
  const plan = payload as RunPlan;
  const errors: string[] = [];
  if (plan.tasks.length === 0) errors.push("A plan needs at least one task (a tweak is one task).");
  if (plan.tasks.length > MAX_PLAN_TASKS) errors.push(`Keep the plan to at most ${MAX_PLAN_TASKS} tasks in this version; merge related work into fewer tasks.`);
  for (const task of plan.tasks) {
    if (!PLANNABLE_ROLES.includes(task.role)) {
      errors.push(`task "${task.id}": role "${task.role}" is not available in this version; use ${PLANNABLE_ROLES.join(", ")} (verification is run by the orchestrator).`);
    }
    if (task.scope.write.filter((g) => !g.startsWith("!")).length === 0) errors.push(`task "${task.id}": scope.write is empty; list the globs it creates or edits.`);
  }
  return errors;
}

/** Plan order respecting `dependsOn` (stable: ties keep the director's order). */
export function topoOrder(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = new Set<string>();
  const out: Task[] = [];
  while (out.length < tasks.length) {
    const next = tasks.find((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d) || !byId.has(d)));
    if (!next) break; // cycles are rejected by validatePlan
    done.add(next.id);
    out.push(next);
  }
  return out;
}

const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", "/index.ts", "/index.tsx"];

function gateLabel(lang: Language, name: GateName): string {
  return catalog(lang)[`gate.${name}`];
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const first = msg.split("\n")[0] ?? msg;
  return first.length > 300 ? `${first.slice(0, 300)}…` : first;
}

function isFatalLlm(err: unknown): boolean {
  return err instanceof LlmConfigError || (err instanceof LlmError && err.code === "auth");
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

interface RouteTarget {
  role: AgentRole;
  scope: string[];
  ownerTask?: Task;
}

interface TaskOutcome {
  task: Task;
  status: "done" | "failed" | "skipped";
  report?: TaskReport;
  reason?: string;
}

class RunOrchestrator {
  private readonly lang: Language;
  private readonly rec: RunRecorder;
  private readonly budget: RunBudget;
  private readonly settings: EngineContext["llm"]["settings"];
  private env: RunEnvironment | null = null;
  private status: RunStatus;
  private redact: (s: string) => string = (s) => s;
  private intent: Intent = "full";
  private confidence = 1;
  private plan: RunPlan | null = null;
  private readonly outcomes = new Map<string, TaskOutcome>();
  private gateResults: GateResult[] = [];
  private gatesRun: GateName[] = [];
  private limitReached = false;
  private merged = false;
  private readonly effort: Effort | undefined;

  constructor(
    private readonly ctx: EngineContext,
    private readonly run: RunRow,
    private project: ProjectRow,
    private readonly signal: AbortSignal,
    private readonly opts: ExecuteRunOptions,
  ) {
    this.lang = projectLanguage(project);
    this.budget = new RunBudget(run.budgetUsd === null ? null : Number(run.budgetUsd), Number(run.spentUsd));
    this.rec = new RunRecorder(ctx, project.id, run.id, this.budget);
    this.settings = ctx.llm.settings;
    this.status = run.status as RunStatus;
    const e = (run.options as { effort?: unknown } | null)?.effort;
    this.effort = e === "low" || e === "medium" || e === "high" || e === "xhigh" ? e : undefined;
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  private checkpoint(): void {
    if (this.signal.aborted) throw new RunCancelled();
  }

  private async phase(to: RunStatus, announce = true): Promise<void> {
    this.checkpoint();
    if (to === this.status) return;
    const current = await this.ctx.store.getRun(this.run.id);
    if (current?.cancelRequestedAt) throw new RunCancelled();
    await this.ctx.store.updateRun(this.run.id, { status: to });
    await this.rec.event("run.phase", { from: this.status, to });
    this.status = to;
    if (announce) await this.rec.message({ author: "agent", type: "building", text: phaseMessage(this.lang, to) });
  }

  async heartbeat(control: AbortController): Promise<void> {
    try {
      await this.ctx.store.updateRun(this.run.id, { heartbeatAt: new Date() });
      const r = await this.ctx.store.getRun(this.run.id);
      if (r?.cancelRequestedAt && !control.signal.aborted) control.abort();
    } catch (err) {
      this.ctx.logger.warn({ err, runId: this.run.id }, "run heartbeat failed");
    }
  }

  private async readText(path: string, max = 20_000): Promise<string | null> {
    if (!this.env) return null;
    try {
      return new TextDecoder().decode(await this.env.workspace.readFile(path)).slice(0, max);
    } catch {
      return null;
    }
  }

  private async fileTree(): Promise<string> {
    if (!this.env) return "";
    const entries = await this.env.workspace.list("", { depth: 4, limit: 400 }).catch(() => []);
    return entries.map((e) => (e.type === "dir" ? `${e.path}/` : e.path)).join("\n");
  }

  private async buildRedactor(): Promise<void> {
    const id = this.project.id;
    const values: string[] = [];
    try {
      values.push(...Object.values(await this.ctx.secrets.renderUser(id, "development")));
      values.push(...Object.values(await this.ctx.secrets.renderUser(id, "production")));
      values.push(...Object.values(await dbPasswords(this.ctx, id)));
      const appEnv = await renderAppEnv(this.ctx, id);
      if (appEnv.BETTER_AUTH_SECRET) values.push(appEnv.BETTER_AUTH_SECRET);
    } catch (err) {
      this.ctx.logger.warn({ err, projectId: id }, "could not load the project's secrets for redaction; patterns only");
    }
    this.redact = createRedactor(values);
  }

  /** One agent session through the uniform loop, observed by the recorder. */
  private async session(o: {
    role: AgentRole;
    label: string;
    taskRowId: string | null;
    messages: AgentMessage[];
    tools: string[];
    terminal: string[];
    scopeWrite?: readonly string[];
    capUsd: number | null;
    ceiling?: number;
    maxTurns?: number;
    submitValidators?: ToolContext["submitValidators"];
  }): Promise<LoopResult & { spentUsd: number }> {
    const env = this.env;
    if (!env) throw new Error("run environment not open");
    const rt = this.ctx.llm.role(o.role);
    const def = roleDefinition(o.role);
    const session = this.budget.session(o.capUsd, o.ceiling);
    const info: SessionInfo = { taskRowId: o.taskRowId, label: o.label, role: o.role, session };
    const route = { provider: null as string | null, model: null as string | null };
    const toolContext: ToolContext = {
      projectId: this.project.id,
      runId: this.run.id,
      taskId: o.label,
      role: o.role,
      scopeWrite: o.scopeWrite ?? [],
      workspace: env.workspace,
      exec: env.exec,
      db: env.db,
      git: env.git,
      imageSourcing: this.ctx.imageSourcing,
      ...(def?.bashAllowlist ? { bashAllowlist: def.bashAllowlist } : {}),
      ...(o.submitValidators ? { submitValidators: o.submitValidators } : {}),
      redact: this.redact,
      emit: (e) => this.rec.toolEvent(info, e),
      abortSignal: this.signal,
    };
    const summarizer = this.ctx.llm.role("summarizer");
    const summaryInfo: SessionInfo = { ...info, role: "summarizer" };
    const summaryRoute = { provider: null as string | null, model: null as string | null };
    const compact =
      rt.contextTokens && o.role !== "summarizer"
        ? createSummarizerCompactor({
            provider: this.ctx.llm.provider,
            system: assembleSystemPrompt({ role: "summarizer", model: summarizer.model }).system,
            toolContext,
            budget: session.handle,
            maxOutputTokens: summarizer.maxOutputTokens,
            onEvent: (e) => this.rec.loopEvent(summaryInfo, e, summaryRoute),
          })
        : undefined;
    const effort = this.effort ?? rt.effort;
    const result = await runAgentLoop({
      role: o.role,
      provider: this.ctx.llm.provider,
      system: assembleSystemPrompt({ role: o.role, model: rt.model }).system,
      messages: o.messages,
      tools: toolsByName(o.tools),
      terminalTools: o.terminal,
      toolContext,
      budget: session.handle,
      maxTurns: o.maxTurns ?? this.settings.maxTurnsPerTask,
      maxOutputTokens: rt.maxOutputTokens,
      ...(effort ? { effort } : {}),
      protocol: rt.protocol,
      ...(rt.contextTokens ? { contextTokens: rt.contextTokens } : {}),
      softLimit: this.settings.contextSoftLimit,
      ...(compact ? { compact } : {}),
      onEvent: (e) => this.rec.loopEvent(info, e, route),
    });
    await this.rec.flush();
    if (result.outcome === "aborted" || this.signal.aborted) throw new RunCancelled();
    if (result.outcome === "llm-error" && isFatalLlm(result.error)) {
      throw new RunFailure(t(this.lang, "run.rolesUnsatisfiable", { details: shortError(result.error) }), shortError(result.error));
    }
    if (result.outcome === "budget") this.limitReached = true;
    return { ...result, spentUsd: session.spent() };
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  private async waitForSandbox(): Promise<ProjectRow> {
    const deadline = Date.now() + (this.opts.sandboxWaitMs ?? SANDBOX_WAIT_MS);
    let woke = false;
    for (;;) {
      this.checkpoint();
      const p = await this.ctx.store.getProject(this.project.id);
      if (!p) throw new RunFailure(t(this.lang, "run.internalError", { cause: "the project was deleted" }), "project deleted");
      if (p.serverStatus === "Active") return (this.project = p);
      if (p.serverStatus === "Archived" && !woke) {
        woke = await startWake(this.ctx, p);
      } else if (p.serverError && !(await this.ctx.store.getOperation(p.id))) {
        throw new RunFailure(t(this.lang, "run.internalError", { cause: shortError(p.serverError) }), `sandbox: ${p.serverError}`);
      }
      if (Date.now() > deadline) throw new RunFailure(t(this.lang, "run.internalError", { cause: "the project's server did not start" }), "sandbox wait timed out");
      await sleep(this.opts.pollMs ?? this.ctx.readyIntervalMs ?? 2_000, this.signal);
    }
  }

  private async direct(): Promise<{ kind: "answer"; text: string } | { kind: "plan" }> {
    const director = roleDefinition("director");
    const dirTools = [...(director?.tools ?? [])];
    const history = (await this.ctx.store.listMessages(this.project.id)).filter((m) => m.runId !== this.run.id);
    const intake = renderDirectorIntake({
      prompt: this.run.prompt,
      inputFiles: (this.run.inputFiles as { name: string; url: string; imageDescription?: string }[]) ?? [],
      language: this.lang,
      isFirstPrompt: history.length === 0,
      projectAgentsMd: await this.readText("AGENTS.md"),
      fileTree: await this.fileTree(),
      recentConversation: history.slice(-10).map((m) => ({ author: m.author, text: m.text })),
      limits: { maxTurns: this.settings.maxTurnsPerTask, budgetUsd: this.budget.totalUsd },
      budgetUsd: this.budget.totalUsd,
    });
    const first = await this.session({
      role: "director",
      label: "director",
      taskRowId: null,
      messages: [{ role: "user", content: intake }],
      tools: [...dirTools, "submit_intent"],
      terminal: ["submit_intent"],
      capUsd: null,
    });
    if (first.outcome !== "submitted" || !first.submission) {
      throw new RunFailure(t(this.lang, "run.internalError", { cause: "the request could not be analysed" }), `director intake: ${first.outcome}`);
    }
    const intent = IntentClassificationSchema.parse(first.submission.payload);
    this.intent = intent.intent;
    this.confidence = intent.confidence;
    await this.ctx.store.updateRun(this.run.id, { intent: intent.intent, expectedMinutes: await expectedMinutes(this.ctx, intent.intent) });
    const messages: AgentMessage[] = [...first.messages, { role: "user", content: DIRECTOR_AFTER_INTENT(intent.intent) }];

    if (intent.intent === "question") {
      await this.phase("answering");
      const r = await this.session({ role: "director", label: "director", taskRowId: null, messages, tools: [...dirTools, "submit_message"], terminal: ["submit_message"], capUsd: null });
      const answer = r.submission ? DirectorMessageSchema.safeParse(r.submission.payload) : null;
      return { kind: "answer", text: answer?.success ? answer.data.text : t(this.lang, "run.questionFallback") };
    }

    const r = await this.session({
      role: "director",
      label: "director",
      taskRowId: null,
      messages,
      tools: [...dirTools, "submit_plan", "submit_decision"],
      terminal: ["submit_plan"],
      capUsd: null,
      submitValidators: { submit_plan: phase2PlanRules },
    });
    if (r.outcome !== "submitted" || !r.submission) {
      throw new RunFailure(t(this.lang, "run.internalError", { cause: "no valid plan could be made" }), `director plan: ${r.outcome}`);
    }
    const plan = RunPlanSchema.parse(r.submission.payload);
    this.plan = plan;
    await this.ctx.store.updateRun(this.run.id, { plan });
    await this.rec.event("plan.created", { intent: plan.intent, taskCount: plan.tasks.length });
    await this.rec.event("plan.approved", {});
    return { kind: "plan" };
  }

  private async implement(): Promise<void> {
    const plan = this.plan as RunPlan;
    const env = this.env as RunEnvironment;
    try {
      await env.ready();
    } catch (err) {
      throw new RunFailure(t(this.lang, "run.internalError", { cause: "the verification server did not start" }), shortError(err));
    }
    const weightOf = (task: Task) => plan.budgetWeights[task.id] ?? task.weight;
    const totalWeight = plan.tasks.reduce((a, task) => a + weightOf(task), 0);
    for (const task of topoOrder(plan.tasks)) {
      this.checkpoint();
      const blocked = task.dependsOn.find((d) => this.outcomes.get(d)?.status !== "done" && plan.tasks.some((x) => x.id === d));
      if (blocked) {
        await this.skip(task, `depends on "${blocked}", which did not finish`);
        continue;
      }
      if (this.limitReached || this.budget.exhausted()) {
        this.limitReached = true;
        await this.skip(task, "budget exhausted");
        continue;
      }
      await this.phase(task.role === "database" ? "modelling" : "implementing");
      await this.rec.message({ author: "agent", type: "building", text: taskStartedMessage(this.lang, task.role) });
      await this.runPlanTask(task, this.budget.taskAllocation(weightOf(task), totalWeight));
    }
  }

  private async skip(task: Task, reason: string): Promise<void> {
    this.outcomes.set(task.id, { task, status: "skipped", reason });
    await this.ctx.store.insertTask({ runId: this.run.id, planTaskId: task.id, role: task.role, status: "skipped", scope: task.scope });
  }

  private async runPlanTask(task: Task, capUsd: number | null): Promise<void> {
    const env = this.env as RunEnvironment;
    const plan = this.plan as RunPlan;
    const def = roleDefinition(task.role);
    const row = await this.ctx.store.insertTask({ runId: this.run.id, planTaskId: task.id, role: task.role, status: "running", scope: task.scope, attempt: 1 });
    await this.rec.event("task.started", { taskId: task.id, role: task.role, title: task.title, attempt: 1 }, row.id);
    const dependencyReports = task.dependsOn
      .map((id) => this.outcomes.get(id))
      .filter((o): o is TaskOutcome & { report: TaskReport } => !!o?.report)
      .map((o) => ({ taskId: o.task.id, title: o.task.title, report: o.report }));
    const context = renderTaskContext({
      task,
      plan,
      dependencyReports,
      projectAgentsMd: await this.readText("AGENTS.md"),
      fileTree: await this.fileTree(),
      limits: { maxTurns: this.settings.maxTurnsPerTask, budgetUsd: capUsd },
    });
    const tools = [...(def?.tools ?? []), "submit_report"];
    const base = { role: task.role, label: task.id, taskRowId: row.id, tools, terminal: ["submit_report"], scopeWrite: task.scope.write, capUsd };
    let r = await this.session({ ...base, messages: [{ role: "user", content: context }] });
    let turns = r.turns;
    let spentUsd = r.spentUsd;
    let report = r.submission ? TaskReportSchema.parse(r.submission.payload) : undefined;

    // Local gate (03 §4 step 4): tsc and eslint on this task's own files; the owner gets
    // AGENT_TASK_LOCAL_RETRIES rounds, then verification (and the fixer) take over.
    for (let attempt = 0; report && attempt < this.settings.taskLocalRetries && !this.budget.exhausted(); attempt++) {
      const failure = await this.localGate(task, report);
      if (!failure) break;
      await this.rec.event("task.retried", { taskId: task.id, attempt: attempt + 2, reason: `${failure.name} failed` }, row.id);
      r = await this.session({ ...base, messages: [...r.messages, { role: "user", content: renderLocalGateRework(failure.name, failure.command, failure.output) }] });
      turns += r.turns;
      spentUsd += r.spentUsd;
      if (r.submission) report = TaskReportSchema.parse(r.submission.payload);
      else break;
    }

    await env
      .commit(report ? `${task.role === "database" ? "feat(db)" : task.role === "backend" ? "feat(api)" : "feat(ui)"}: ${task.title}\n\n${report.summary}\n\nForja-Task: ${task.id}` : `wip(${task.id}): ${task.title} (incomplete)\n\nForja-Task: ${task.id}`)
      .catch((err: unknown) => {
        this.ctx.logger.warn({ err, runId: this.run.id, task: task.id }, "task commit failed");
        return null;
      });
    const cost = { usd: spentUsd };
    if (report) {
      this.outcomes.set(task.id, { task, status: "done", report });
      await this.ctx.store.updateTask(row.id, { status: "done", turns, report, attempt: 1 });
      await this.rec.event("task.finished", { taskId: task.id, report: { kind: "report", data: report }, cost }, row.id);
    } else {
      const reason = `${r.outcome}${r.lastText ? `: ${r.lastText.slice(0, 500)}` : ""}`;
      this.outcomes.set(task.id, { task, status: "failed", reason });
      await this.ctx.store.updateTask(row.id, { status: "failed", turns, report: { error: reason } });
      await this.rec.event("task.failed", { taskId: task.id, error: reason }, row.id);
    }
  }

  /** tsc + eslint filtered to the task's scope; null when its own files are clean. */
  private async localGate(task: Task, report: TaskReport): Promise<GateResult | null> {
    if (report.filesChanged.length === 0 || !["frontend", "backend", "database"].includes(task.role)) return null;
    const env = this.env as RunEnvironment;
    for (const name of ["typecheck", "lint"] as const) {
      const r = await runGate(env, name, this.signal);
      this.checkpoint();
      if (r.passed) continue;
      const mine = r.parsed.filter((e) => e.file && scopeCoversPath(task.scope.write, e.file));
      if (mine.length > 0) return { ...r, parsed: mine };
    }
    return null;
  }

  private async runGates(names: GateName[], announce: boolean): Promise<GateResult[]> {
    const env = this.env as RunEnvironment;
    const results: GateResult[] = [];
    for (const [i, name] of names.entries()) {
      this.checkpoint();
      if (announce) await this.rec.message({ author: "agent", type: "building", text: gatesProgressMessage(this.lang, i + 1, names.length) });
      await this.rec.event("gate.started", { name });
      const r = await runGate(env, name, this.signal);
      this.checkpoint();
      results.push(r);
      if (r.passed) {
        await this.rec.event("gate.passed", { name, durationMs: r.durationMs });
        continue;
      }
      const target = await this.route(r);
      await this.rec.event("gate.failed", { name, parsed: r.parsed.slice(0, 30), routedTo: target?.role ?? "fixer", output: r.output.slice(-4000) });
      break;
    }
    return results;
  }

  private async existing(files: string[]): Promise<string[]> {
    const env = this.env as RunEnvironment;
    const out: string[] = [];
    for (const f of new Set(files)) if ((await env.workspace.stat(f))?.type === "file") out.push(f);
    return out;
  }

  /** Files the error files import directly (`./x`, `../x`, `@/x`), resolved to existing files. */
  private async directImports(files: string[]): Promise<string[]> {
    const env = this.env as RunEnvironment;
    const out = new Set<string>();
    for (const file of files) {
      const text = await this.readText(file, 200_000);
      if (!text) continue;
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2] ?? m[3] ?? "";
        let base: string | null = null;
        if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
        else if (spec.startsWith("./") || spec.startsWith("../")) {
          const parts = [...(dir ? dir.split("/") : [])];
          for (const seg of spec.split("/")) {
            if (seg === "..") parts.pop();
            else if (seg !== ".") parts.push(seg);
          }
          base = parts.join("/");
        }
        if (!base) continue;
        for (const suffix of RESOLVE_SUFFIXES) {
          if ((await env.workspace.stat(`${base}${suffix}`))?.type === "file") {
            out.add(`${base}${suffix}`);
            break;
          }
        }
      }
    }
    return [...out];
  }

  /** Who fixes a failed gate (03 §6 table), and with which scope. */
  private async route(failed: GateResult): Promise<RouteTarget | null> {
    const spec = GATES[failed.name];
    const files = await this.existing(failed.parsed.map((e) => e.file).filter((f): f is string => !!f));
    const worked = [...this.outcomes.values()].filter((o) => o.status !== "skipped").map((o) => o.task);
    if (spec.routedTo === "fixer" && files.length > 0) {
      return { role: "fixer", scope: [...new Set([...files, ...(await this.directImports(files))])] };
    }
    if (spec.routedTo === "database") {
      const owner = [...worked].reverse().find((task) => task.role === "database");
      if (owner) return { role: "database", scope: [...owner.scope.write], ownerTask: owner };
    }
    const owner = worked.find((task) => files.some((f) => scopeCoversPath(task.scope.write, f))) ?? worked.at(-1);
    if (owner) return { role: owner.role, scope: [...owner.scope.write], ownerTask: owner };
    if (files.length > 0) return { role: "fixer", scope: files };
    return null;
  }

  private async verify(): Promise<void> {
    const names = gatesFor(this.intent, this.confidence);
    this.gatesRun = names;
    if (names.length === 0) return;
    await this.phase("verifying");
    let round = 0;
    let lastSignature: string | null = null;
    let same = 0;
    for (;;) {
      const results = await this.runGates(names, round === 0);
      this.gateResults = results;
      const failed = results.find((r) => !r.passed);
      if (!failed) return;
      if (this.budget.exhausted()) {
        this.limitReached = true;
        return;
      }
      if (round >= this.settings.maxFixRounds) return;
      const target = await this.route(failed);
      if (!target) return;
      const signature = failureSignature(failed);
      same = signature === lastSignature ? same + 1 : 1;
      lastSignature = signature;
      if (target.role === "fixer" ? same > this.settings.fixerPasses : same >= 2) return;
      round += 1;
      await this.phase("fixing");
      await this.runFix(failed, target, round);
      await this.phase("verifying");
    }
  }

  private async runFix(failed: GateResult, target: RouteTarget, round: number): Promise<void> {
    const env = this.env as RunEnvironment;
    const def = roleDefinition(target.role);
    const label = target.ownerTask ? `${target.ownerTask.id}~fix${round}` : `fix-${round}`;
    const row = await this.ctx.store.insertTask({ runId: this.run.id, planTaskId: label, role: target.role, status: "running", scope: { write: target.scope }, attempt: round });
    await this.rec.message({ author: "agent", type: "building", text: taskStartedMessage(this.lang, target.role) });
    await this.rec.event("task.started", { taskId: label, role: target.role, title: `Fix ${failed.name}`, attempt: round }, row.id);
    const pool = this.budget.verifyPool();
    const capUsd = pool === null ? null : pool / Math.max(1, this.settings.maxFixRounds);
    const r = await this.session({
      role: target.role,
      label,
      taskRowId: row.id,
      messages: [
        {
          role: "user",
          content: renderFixContext({
            gate: failed.name,
            command: failed.command.split("\n")[0] ?? failed.command,
            errors: failed.parsed,
            output: failed.output,
            scope: target.scope,
            limits: { maxTurns: this.settings.maxTurnsPerTask, budgetUsd: capUsd },
            ...(target.ownerTask ? { ownerTask: target.ownerTask } : {}),
          }),
        },
      ],
      tools: [...(def?.tools ?? []), "submit_report"],
      terminal: ["submit_report"],
      scopeWrite: target.scope,
      capUsd,
    });
    const report = r.submission ? TaskReportSchema.safeParse(r.submission.payload) : null;
    await env.commit(`fix(${failed.name}): ${report?.success ? report.data.summary.split("\n")[0] : `automatic fix round ${round}`}\n\nForja-Task: ${label}`).catch(() => null);
    if (report?.success) {
      await this.ctx.store.updateTask(row.id, { status: "done", turns: r.turns, report: report.data });
      await this.rec.event("task.finished", { taskId: label, report: { kind: "report", data: report.data }, cost: { usd: r.spentUsd } }, row.id);
    } else {
      await this.ctx.store.updateTask(row.id, { status: "failed", turns: r.turns, report: { error: r.outcome } });
      await this.rec.event("task.failed", { taskId: label, error: r.outcome }, row.id);
    }
  }

  private failedGates(): string[] {
    return this.gateResults.filter((g) => !g.passed).map((g) => gateLabel(this.lang, g.name));
  }

  private async secretKeysNeeded(): Promise<FinalMessage["secretKeysNeeded"]> {
    const provided = new Set((await this.ctx.secrets.listForApi(this.project.id)).map((s) => s.secretName));
    const out: NonNullable<FinalMessage["secretKeysNeeded"]> = {};
    for (const o of this.outcomes.values()) {
      for (const need of o.report?.envNeeds ?? []) {
        if (need.required) out[need.name] = { isProvided: provided.has(need.name), description: need.description };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  private async closingMessage(changed: boolean, secretKeys: FinalMessage["secretKeysNeeded"]): Promise<string> {
    const plan = this.plan as RunPlan;
    const failed = this.failedGates();
    const fallback = !changed
      ? t(this.lang, "run.nothingChanged", { summary: plan.summary })
      : failed.length > 0
        ? t(this.lang, "run.finishedWithFailures", { failed: failed.join(", ") })
        : t(this.lang, "run.finished", { summary: plan.summary });
    try {
      const minutes = (Date.now() - (this.run.startedAt ?? this.run.createdAt).getTime()) / 60_000;
      const ranGates = new Set(this.gateResults.map((g) => g.name));
      const context = renderClosingContext({
        prompt: this.run.prompt,
        language: this.lang,
        intent: this.intent,
        planSummary: plan.summary,
        reports: [...this.outcomes.values()].map((o) => ({
          title: o.task.title,
          status: o.status === "done" ? (o.report?.status ?? "done") : o.status,
          summary: o.report?.summary ?? o.reason ?? "",
          concerns: o.report?.concerns ?? [],
        })),
        gates: [
          ...this.gateResults.map((g) => ({ name: gateLabel(this.lang, g.name), passed: g.passed, ...(g.passed ? {} : { detail: g.parsed.slice(0, 3).map((e) => e.message).join("; ") }) })),
          ...this.gatesRun.filter((n) => !ranGates.has(n)).map((n) => ({ name: gateLabel(this.lang, n), passed: false, detail: "not run (an earlier check failed)" })),
        ],
        skipped: [...this.outcomes.values()].filter((o) => o.status !== "done").map((o) => `${o.task.title}: ${o.reason ?? o.status}`),
        secretKeysNeeded: Object.entries(secretKeys ?? {}).map(([name, v]) => ({ name, ...v })),
        previewUrl: this.project.devUrl ?? "",
        costUsd: this.budget.spent,
        minutes,
        limits: { maxTurns: CLOSING_TURNS, budgetUsd: null },
      });
      const r = await this.session({
        role: "director",
        label: "closing",
        taskRowId: null,
        messages: [{ role: "user", content: context }],
        tools: ["submit_message"],
        terminal: ["submit_message"],
        capUsd: null,
        ceiling: 1,
        maxTurns: CLOSING_TURNS,
      });
      const parsed = r.submission ? DirectorMessageSchema.safeParse(r.submission.payload) : null;
      return parsed?.success ? parsed.data.text : fallback;
    } catch (err) {
      if (err instanceof RunCancelled) throw err;
      this.ctx.logger.warn({ err, runId: this.run.id }, "closing message failed; using the template");
      return fallback;
    }
  }

  private async finish(): Promise<void> {
    const env = this.env as RunEnvironment;
    const plan = this.plan as RunPlan;
    await this.phase("finishing");
    await env.commit("chore(run): final changes").catch(() => null);
    const changed = await env.changedFiles();
    let versionId: string | null = null;
    if (changed.length > 0) {
      const m = await env.merge(`feat: ${plan.summary.split("\n")[0]}`);
      this.merged = true;
      if (m.merged) {
        await this.ctx.store.insertVersion({
          id: m.commitSha,
          projectId: this.project.id,
          runId: this.run.id,
          tag: m.tag ?? m.commitSha.slice(0, 12),
          commitSha: m.commitSha,
          parentSha: m.parentSha,
          message: plan.summary,
          prompt: this.run.prompt,
          checks: { intent: this.intent, gates: this.gateResults.map((g) => ({ name: g.name, passed: g.passed, durationMs: g.durationMs })), planned: this.gatesRun },
        });
        versionId = m.commitSha;
      }
      await env.applyToApp(changed).catch((err: unknown) => this.ctx.logger.warn({ err, runId: this.run.id }, "could not apply the run to the dev app (migrations or rebuild)"));
    }
    const secretKeysNeeded = await this.secretKeysNeeded();
    if (this.limitReached) {
      const skipped = [...this.outcomes.values()].filter((o) => o.status !== "done").map((o) => o.task.title);
      await finalizeRun(this.ctx, this.run.id, {
        status: "limit-reached",
        message: {
          type: "limit-reached",
          text: t(this.lang, "run.budgetExhausted", { spent: this.budget.spent.toFixed(2), budget: (this.budget.totalUsd ?? 0).toFixed(2), skipped: skipped.join(", ") || "—" }),
          versionId,
          ...(secretKeysNeeded ? { secretKeysNeeded } : {}),
        },
      });
      return;
    }
    const text = await this.closingMessage(changed.length > 0, secretKeysNeeded);
    await finalizeRun(this.ctx, this.run.id, { status: "done", message: { type: "finished", text, versionId, ...(secretKeysNeeded ? { secretKeysNeeded } : {}) } });
  }

  // ── Entry ──────────────────────────────────────────────────────────────────

  async execute(): Promise<void> {
    try {
      await this.phase("directing", false);
      await this.rec.message({ author: "agent", type: "starting", text: t(this.lang, "run.starting") });
      const reason = this.ctx.llm.unavailableReason();
      if (reason) throw new RunFailure(t(this.lang, "run.rolesUnsatisfiable", { details: reason }), reason);
      const project = await this.waitForSandbox();
      this.env = await (this.opts.environments ?? this.ctx.runEnvironments ?? dockerRunEnvironments(this.ctx)).open(project, this.run);
      await this.buildRedactor();
      const intake = await this.direct();
      if (intake.kind === "answer") {
        await finalizeRun(this.ctx, this.run.id, { status: "done", message: { type: "finished", text: intake.text } });
        return;
      }
      await this.implement();
      await this.verify();
      await this.finish();
    } catch (err) {
      await this.rec.flush();
      if (err instanceof RunCancelled || this.signal.aborted) await this.close("cancelled", t(this.lang, "run.stoppedByUser"), "stopped by the user");
      else if (err instanceof RunFailure) await this.close("failed", err.userMessage, err.message);
      else {
        this.ctx.logger.error({ err, runId: this.run.id }, "run failed");
        await this.close("failed", t(this.lang, "run.internalError", { cause: shortError(err) }), err instanceof Error ? (err.stack ?? err.message) : String(err));
      }
    } finally {
      await this.rec.flush();
      await this.env?.close({ keepBranch: !this.merged }).catch((err: unknown) => this.ctx.logger.warn({ err, runId: this.run.id }, "could not clean up the run environment"));
    }
  }

  /** Stop or failure: partial work is committed on the branch (never merged), then the message and status. */
  private async close(status: "cancelled" | "failed", text: string, detail: string): Promise<void> {
    if (this.env && !this.merged) await this.env.commit(`wip: ${status === "cancelled" ? "stopped by the user" : "run failed"}`).catch(() => null);
    await finalizeRun(this.ctx, this.run.id, { status, message: { type: "error", text }, error: detail });
  }
}

/** The `run.execute` job body. Never throws: every path ends in a terminal status. */
export async function executeRun(ctx: EngineContext, runId: string, opts: ExecuteRunOptions = {}): Promise<void> {
  const run = await ctx.store.getRun(runId);
  if (!run || isTerminalRunStatus(run.status as RunStatus)) return;
  const project = await ctx.store.getProject(run.projectId);
  if (!project) {
    await finalizeRun(ctx, runId, { status: "failed", error: "project not found" });
    return;
  }
  if (run.cancelRequestedAt) {
    await finalizeRun(ctx, runId, { status: "cancelled", message: { type: "error", text: t(projectLanguage(project), "run.stoppedByUser") } });
    return;
  }
  const control = registerRunControl(runId);
  const orchestrator = new RunOrchestrator(ctx, run, project, control.signal, opts);
  void orchestrator.heartbeat(control);
  const heartbeat = setInterval(() => void orchestrator.heartbeat(control), opts.heartbeatMs ?? HEARTBEAT_MS);
  heartbeat.unref();
  try {
    await orchestrator.execute();
  } catch (err) {
    ctx.logger.error({ err, runId }, "orchestrator crashed");
    await finalizeRun(ctx, runId, { status: "failed", message: { type: "error", text: t(projectLanguage(project), "run.internalError", { cause: shortError(err) }) }, error: String(err) }).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    unregisterRunControl(runId);
  }
}
