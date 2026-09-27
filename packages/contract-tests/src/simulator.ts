/**
 * UI-polling simulator: each function replays, step by step, how apps/web drives one
 * transition against the backend, and records every contract violation it sees.
 *
 * What this file protects: the synchronous transitions the UI's polling depends on
 * (research/02 §3.3). The UI polls IMMEDIATELY after each action, so the backend must
 * flip state BEFORE it answers the action, or the UI concludes on the previous state:
 *
 *   action                         first read must show              UI source
 *   agent/start, launch            agent/status = "init"             page.tsx pollAgentOnce
 *   deployments/deploy             deployments/status = "deploying"  page.tsx pollDeployOnce
 *   rebuild                        rebuild/status = "rebuilding"     page.tsx operation watcher
 *   agent/server/start-or-restart  agentServerStatus != "Active"     page.tsx operation watcher
 *   versions/:id/recover           versionRecovery present           page.tsx operation watcher
 *   github/pull                    pull-status = "pulling"           page.tsx operation watcher
 *   (any sandbox action asleep)    409 SERVER_NOT_READY, then Active use-server-wake.ts
 *
 * The cadences mirror the UI (10 s run/deploy, 3 s × 3 "waiting for init", 8 s × 60
 * watcher, 5 s wake with a 4 min estimate). Tests pass small `intervalMs` values; the
 * logic, not the clock, is what is verified. Keep this file in step with page.tsx.
 */
import type { ApiResult, V1Client } from "./client.js";
import {
  DEPLOY_STATUSES,
  MESSAGE_TYPES,
  PULL_STATUSES,
  REBUILD_STATUSES,
  RUN_STATUSES,
  SERVER_STATUSES,
  TERMINAL_MESSAGE_TYPES,
  dedupeKey,
  isCachedPreview,
  type AgentStatus,
  type ConversationMessage,
  type LaunchResult,
  type ProjectDetail,
} from "./types.js";

// ── Options, trace and result ───────────────────────────────────────────────

export interface SimOptions {
  /** Main poll cadence. Default: the UI's value for that transition. */
  intervalMs?: number;
  /** The run's "waiting to observe init" re-poll (UI: 3000 ms). */
  fastIntervalMs?: number;
  /** Poll attempts before the simulator gives up (UI caps: watcher 60, run/deploy none). */
  maxAttempts?: number;
  /** Wake only: the estimate the UI waits against (UI: 4 min). */
  capMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const VIOLATION_CODES = [
  "REQUEST_FAILED",
  "BAD_ENUM",
  "INIT_NOT_SYNCHRONOUS",
  "DUPLICATE_DEDUPE_KEY",
  "UNSTABLE_CREATED_AT",
  "NO_TERMINAL_MESSAGE",
  "USER_MESSAGE_NOT_PERSISTED",
  "PROJECT_STATUS_DISAGREES",
  "POLL_TIMEOUT",
  "DEPLOY_NOT_SYNCHRONOUS",
  "PRODUCTION_URL_HAS_SCHEME",
  "REBUILD_NOT_SYNCHRONOUS",
  "REBUILD_ENDED_IDLE",
  "RESTART_STILL_ACTIVE",
  "RESTORE_NOT_SYNCHRONOUS",
  "PULL_NOT_SYNCHRONOUS",
  "WAKE_WRONG_HTTP_STATUS",
  "WAKE_EXCEEDED_ESTIMATE",
  "STILL_NOT_READY_AFTER_WAKE",
  "LAUNCH_NO_PROJECT_ID",
  "REQUESTED_ID_MISSING",
  "PROJECT_ID_NOT_AUTHORITATIVE",
  "LAUNCH_RUN_NOT_SYNCHRONOUS",
] as const;
export type ViolationCode = (typeof VIOLATION_CODES)[number];

export interface Violation {
  code: ViolationCode;
  message: string;
}

export interface TraceStep {
  /** ms since the simulation started. */
  at: number;
  call: string;
  httpStatus?: number;
  observed: string;
}

export interface SimulationResult {
  simulator: string;
  projectId: string;
  outcome: string;
  ok: boolean;
  violations: Violation[];
  warnings: string[];
  steps: TraceStep[];
  durationMs: number;
  details: Record<string, unknown>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Trace {
  readonly steps: TraceStep[] = [];
  readonly violations: Violation[] = [];
  readonly warnings: string[] = [];
  readonly details: Record<string, unknown> = {};
  private readonly t0 = Date.now();
  constructor(
    readonly simulator: string,
    public projectId: string,
  ) {}

  step(call: string, res: ApiResult | undefined, observed: string): void {
    this.steps.push({ at: Date.now() - this.t0, call, httpStatus: res?.status, observed });
  }
  violate(code: ViolationCode, message: string): void {
    this.violations.push({ code, message });
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  /** Records a failed request as a violation; returns true when it failed. */
  failed(call: string, res: ApiResult): boolean {
    if (!res.errors) return false;
    this.step(call, res, `error ${res.errors.errorCode}`);
    this.violate("REQUEST_FAILED", `${call} → ${res.status} ${res.errors.errorCode}: ${res.errors.errorMessage}`);
    return true;
  }
  enumCheck(what: string, value: unknown, allowed: readonly unknown[]): void {
    if (!allowed.includes(value)) this.violate("BAD_ENUM", `${what} = ${JSON.stringify(value)}; expected one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
  }
  result(outcome: string): SimulationResult {
    return {
      simulator: this.simulator,
      projectId: this.projectId,
      outcome,
      ok: this.violations.length === 0,
      violations: this.violations,
      warnings: this.warnings,
      steps: this.steps,
      durationMs: Date.now() - this.t0,
      details: this.details,
    };
  }
}

function resolve(opts: SimOptions, defaults: { intervalMs: number; maxAttempts: number }) {
  return {
    intervalMs: opts.intervalMs ?? defaults.intervalMs,
    fastIntervalMs: opts.fastIntervalMs ?? (opts.intervalMs !== undefined ? Math.max(1, Math.round((opts.intervalMs * 3) / 10)) : 3_000),
    maxAttempts: opts.maxAttempts ?? defaults.maxAttempts,
    sleep: opts.sleep ?? realSleep,
  };
}

const enc = encodeURIComponent;

// ── Run polling (shared by agent/start and launch) ──────────────────────────

interface PollRunArgs {
  /** True right after agent/start: the UI's `pendingRunRef`. */
  pendingRun: boolean;
  prompt?: string;
}

/**
 * Mirrors page.tsx `pollAgentOnce`: immediate poll, 10 s cadence; a terminal status while
 * the run is still "pending" (init never observed) is re-polled at 3 s, at most 3 times,
 * then believed. On terminal: re-read project and full conversation.
 */
async function pollRun(client: V1Client, trace: Trace, projectId: string, args: PollRunArgs, opts: SimOptions): Promise<string> {
  const o = resolve(opts, { intervalMs: 10_000, maxAttempts: 360 });
  const path = `projects/${enc(projectId)}/agent/status`;
  let pending = args.pendingRun;
  let waitPolls = 0;
  let attempts = 0;
  let sawInit = false;
  let previous: ConversationMessage[] = [];
  const uiList = new Map<string, ConversationMessage>();

  for (;;) {
    attempts += 1;
    const res = await client.get<AgentStatus>(path);
    const first = attempts === 1;
    if (res.errors || !res.data) {
      trace.failed(`GET ${path}`, res);
    } else {
      const s = res.data;
      trace.step(`GET ${path}`, res, `status=${s.status} rt=${s.realtimeConversation?.length ?? 0}`);
      trace.enumCheck("agent/status.status", s.status, RUN_STATUSES);
      if (first && args.pendingRun && s.status !== "init") {
        trace.violate("INIT_NOT_SYNCHRONOUS", `first agent/status after start was "${s.status}", expected "init" (the run must be created before agent/start answers)`);
      }

      const rt = (s.realtimeConversation ?? []).filter((m) => m.author === "agent");
      const keys = new Set<string>();
      for (const m of rt) {
        trace.enumCheck("realtimeConversation[].messageType", m.messageType, MESSAGE_TYPES);
        const k = dedupeKey(m);
        if (keys.has(k)) trace.violate("DUPLICATE_DEDUPE_KEY", `two agent messages share the dedupe key ${JSON.stringify(k)} in one poll`);
        keys.add(k);
        if (!uiList.has(k)) uiList.set(k, m);
      }
      rt.forEach((m, i) => {
        const before = previous[i];
        if (before && before.message === m.message && before.createdAt !== m.createdAt) {
          trace.violate("UNSTABLE_CREATED_AT", `realtime message #${i} changed createdAt between polls (${before.createdAt} → ${m.createdAt}); the UI would show it twice`);
        }
      });
      previous = rt;

      if (s.status === "init") {
        pending = false;
        waitPolls = 0;
        sawInit = true;
        if (!s.startedAt || Number.isNaN(Date.parse(s.startedAt))) trace.warn("agent/status in init without a parseable startedAt: the progress bar stays empty");
      }

      const terminal = s.status === "done" || s.status === "idle";
      if (terminal && pending) {
        waitPolls += 1;
        if (waitPolls < 4) {
          await o.sleep(o.fastIntervalMs);
          continue;
        }
        pending = false;
        trace.warn("run concluded without ever observing init (the UI gives up waiting after 3 fast re-polls)");
      }
      if (terminal) {
        trace.details.sawInit = sawInit;
        trace.details.realtimeMessagesSeen = uiList.size;
        await checkAfterRun(client, trace, projectId, args.prompt);
        return s.status;
      }
    }
    if (attempts >= o.maxAttempts) {
      trace.violate("POLL_TIMEOUT", `agent/status never reached done/idle in ${attempts} polls`);
      return "timeout";
    }
    await o.sleep(o.intervalMs);
  }
}

async function checkAfterRun(client: V1Client, trace: Trace, projectId: string, prompt: string | undefined): Promise<void> {
  const pPath = `projects/${enc(projectId)}`;
  const proj = await client.get<ProjectDetail>(pPath);
  if (!trace.failed(`GET ${pPath}`, proj) && proj.data) {
    trace.step(`GET ${pPath}`, proj, `agentProcessStatus=${proj.data.agentProcessStatus}`);
    if (proj.data.agentProcessStatus === "init") {
      trace.violate("PROJECT_STATUS_DISAGREES", "agent/status is terminal but project.agentProcessStatus is still init");
    }
  }
  const cPath = `projects/${enc(projectId)}/agent/full-conversation`;
  const conv = await client.get<{ conversation: ConversationMessage[] }>(cPath);
  if (trace.failed(`GET ${cPath}`, conv) || !conv.data) return;
  const list = Array.isArray(conv.data.conversation) ? conv.data.conversation : [];
  trace.step(`GET ${cPath}`, conv, `${list.length} messages`);
  const keys = new Set<string>();
  for (const m of list) {
    trace.enumCheck("conversation[].messageType", m.messageType, MESSAGE_TYPES);
    if (m.author !== "agent") continue;
    const k = dedupeKey(m);
    if (keys.has(k)) trace.violate("DUPLICATE_DEDUPE_KEY", `full conversation has two agent messages with key ${JSON.stringify(k)}`);
    keys.add(k);
  }
  let lastUser = -1;
  list.forEach((m, i) => {
    if (m.author === "user") lastUser = i;
  });
  if (prompt !== undefined && !list.some((m) => m.author === "user" && m.message === prompt)) {
    trace.violate("USER_MESSAGE_NOT_PERSISTED", "the prompt sent to agent/start is not in the full conversation");
  }
  const lastAgent = list.slice(lastUser + 1).filter((m) => m.author === "agent").at(-1);
  if (!lastAgent || !TERMINAL_MESSAGE_TYPES.includes(lastAgent.messageType)) {
    trace.violate("NO_TERMINAL_MESSAGE", `the run's last agent message is ${lastAgent ? `"${lastAgent.messageType}"` : "missing"}; expected finished | error | limit-reached`);
  }
  trace.details.finalMessageType = lastAgent?.messageType;
}

// ── Simulators ──────────────────────────────────────────────────────────────

/** Composer send: POST agent/start, then the workspace's run polling. */
export async function simulateAgentStart(client: V1Client, projectId: string, prompt: string, opts: SimOptions = {}): Promise<SimulationResult> {
  const trace = new Trace("agentStart", projectId);
  const path = `projects/${enc(projectId)}/agent/start`;
  const res = await client.post(path, { prompt, inputFiles: [] });
  if (trace.failed(`POST ${path}`, res)) return trace.result("start-failed");
  trace.step(`POST ${path}`, res, "ok");
  const outcome = await pollRun(client, trace, projectId, { pendingRun: true, prompt }, opts);
  return trace.result(outcome);
}

/** Publish: POST deployments/deploy, then `pollDeployOnce` (10 s, no cap in the UI). */
export async function simulateDeploy(client: V1Client, projectId: string, opts: SimOptions = {}): Promise<SimulationResult> {
  const trace = new Trace("deploy", projectId);
  const o = resolve(opts, { intervalMs: 10_000, maxAttempts: 180 });
  const dPath = `projects/${enc(projectId)}/deployments/deploy`;
  const sPath = `projects/${enc(projectId)}/deployments/status`;
  const res = await client.post(dPath, {});
  if (trace.failed(`POST ${dPath}`, res)) return trace.result("deploy-failed");
  trace.step(`POST ${dPath}`, res, "ok");

  for (let attempt = 1; ; attempt++) {
    const st = await client.get<{ status: string | null; createdAt?: string } | null>(sPath);
    if (!trace.failed(`GET ${sPath}`, st)) {
      const status = st.data?.status ?? null;
      trace.step(`GET ${sPath}`, st, `status=${status}`);
      if (status !== null) trace.enumCheck("deployments/status.status", status, DEPLOY_STATUSES);
      if (attempt === 1 && status !== "deploying") {
        trace.violate("DEPLOY_NOT_SYNCHRONOUS", `first deployments/status after deploy was ${JSON.stringify(status)}, expected "deploying" (the UI would report the previous publish)`);
      }
      if (status === "success" || status === "error") {
        const pPath = `projects/${enc(projectId)}`;
        const proj = await client.get<ProjectDetail>(pPath);
        if (!trace.failed(`GET ${pPath}`, proj) && proj.data) {
          const host = proj.data.productionProjectUrl;
          trace.step(`GET ${pPath}`, proj, `deployment=${proj.data.deployment?.status ?? null} productionProjectUrl=${host ?? ""}`);
          if (host && /^[a-z]+:\/\//i.test(host)) trace.violate("PRODUCTION_URL_HAS_SCHEME", `productionProjectUrl must be a bare hostname, got ${JSON.stringify(host)}`);
          if (proj.data.deployment && proj.data.deployment.status !== status) {
            trace.violate("PROJECT_STATUS_DISAGREES", `deployments/status=${status} but project.deployment.status=${proj.data.deployment.status}`);
          }
        }
        return trace.result(status);
      }
    }
    if (attempt >= o.maxAttempts) {
      trace.violate("POLL_TIMEOUT", `deploy never reached success/error in ${attempt} polls`);
      return trace.result("timeout");
    }
    await o.sleep(o.intervalMs);
  }
}

/** Code panel "Rebuild": POST rebuild, then the operation watcher (8 s × 60; 3 × idle = give up). */
export async function simulateRebuild(client: V1Client, projectId: string, opts: SimOptions = {}): Promise<SimulationResult> {
  const trace = new Trace("rebuild", projectId);
  const o = resolve(opts, { intervalMs: 8_000, maxAttempts: 60 });
  const rPath = `projects/${enc(projectId)}/rebuild`;
  const sPath = `projects/${enc(projectId)}/rebuild/status`;
  const res = await client.post(rPath, {});
  if (trace.failed(`POST ${rPath}`, res)) return trace.result("rebuild-failed");
  trace.step(`POST ${rPath}`, res, "ok");

  let idleSeen = 0;
  let sawRebuilding = false;
  for (let attempt = 1; ; attempt++) {
    const st = await client.get<{ status: string; errorMessage?: string }>(sPath);
    if (!trace.failed(`GET ${sPath}`, st) && st.data) {
      const status = st.data.status;
      trace.step(`GET ${sPath}`, st, `status=${status}`);
      trace.enumCheck("rebuild/status.status", status, REBUILD_STATUSES);
      if (attempt === 1 && status !== "rebuilding") {
        trace.violate("REBUILD_NOT_SYNCHRONOUS", `first rebuild/status after rebuild was "${status}", expected "rebuilding"`);
      }
      if (status === "rebuilding") sawRebuilding = true;
      if (status === "success" || status === "error") return trace.result(status);
      if (status === "idle" && ++idleSeen >= 3) {
        if (sawRebuilding) trace.violate("REBUILD_ENDED_IDLE", "rebuild went rebuilding → idle; it must end in success or error");
        return trace.result("idle-given-up");
      }
    }
    if (attempt >= o.maxAttempts) {
      trace.violate("POLL_TIMEOUT", `rebuild never ended in ${attempt} polls`);
      return trace.result("timeout");
    }
    await o.sleep(o.intervalMs);
  }
}

/** Manual restart: POST agent/server/start-or-restart; the watcher ends on `Active`. */
export async function simulateRestart(client: V1Client, projectId: string, opts: SimOptions = {}): Promise<SimulationResult> {
  const trace = new Trace("restart", projectId);
  const o = resolve(opts, { intervalMs: 8_000, maxAttempts: 60 });
  const rPath = `projects/${enc(projectId)}/agent/server/start-or-restart`;
  const pPath = `projects/${enc(projectId)}`;
  const res = await client.post(rPath, {});
  if (trace.failed(`POST ${rPath}`, res)) return trace.result("restart-failed");
  trace.step(`POST ${rPath}`, res, "ok");

  for (let attempt = 1; ; attempt++) {
    const pr = await client.get<ProjectDetail>(pPath);
    if (!trace.failed(`GET ${pPath}`, pr) && pr.data) {
      const status = pr.data.agentServerStatus;
      trace.step(`GET ${pPath}`, pr, `agentServerStatus=${status}`);
      trace.enumCheck("agentServerStatus", status, SERVER_STATUSES);
      if (attempt === 1 && status === "Active") {
        trace.violate("RESTART_STILL_ACTIVE", "first project read after restart was still Active; the server must leave Active before the restart call answers");
        return trace.result("active");
      }
      if (status === "Active") return trace.result("active");
    }
    if (attempt >= o.maxAttempts) {
      trace.violate("POLL_TIMEOUT", `server never came back Active in ${attempt} polls`);
      return trace.result("timeout");
    }
    await o.sleep(o.intervalMs);
  }
}

/** Versions → Restore: POST versions/:id/recover; the watcher ends when `versionRecovery` clears or errors. */
export async function simulateRestore(client: V1Client, projectId: string, versionId: string, opts: SimOptions = {}): Promise<SimulationResult> {
  const trace = new Trace("restore", projectId);
  const o = resolve(opts, { intervalMs: 8_000, maxAttempts: 60 });
  const rPath = `projects/${enc(projectId)}/versions/${enc(versionId)}/recover`;
  const pPath = `projects/${enc(projectId)}`;
  const res = await client.post(rPath, {});
  if (trace.failed(`POST ${rPath}`, res)) return trace.result("restore-failed");
  trace.step(`POST ${rPath}`, res, "ok");

  for (let attempt = 1; ; attempt++) {
    const pr = await client.get<ProjectDetail>(pPath);
    if (!trace.failed(`GET ${pPath}`, pr) && pr.data) {
      const rec = pr.data.versionRecovery ?? null;
      trace.step(`GET ${pPath}`, pr, `versionRecovery=${rec ? rec.status : "null"}`);
      if (rec) trace.enumCheck("versionRecovery.status", rec.status, ["recovering", "error"]);
      if (attempt === 1) {
        if (!rec) {
          trace.violate("RESTORE_NOT_SYNCHRONOUS", "first project read after recover had no versionRecovery; the UI would report the restore as finished immediately");
          return trace.result("restored");
        }
        if (rec.versionId !== versionId) trace.warn(`versionRecovery.versionId is ${rec.versionId}, requested ${versionId}`);
      }
      if (!rec) return trace.result("restored");
      if (rec.status === "error") return trace.result("error");
    }
    if (attempt >= o.maxAttempts) {
      trace.violate("POLL_TIMEOUT", `restore never finished in ${attempt} polls`);
      return trace.result("timeout");
    }
    await o.sleep(o.intervalMs);
  }
}

/** GitHub → Pull: POST github/pull; the watcher ends on pull-status !== "pulling" (null included). */
export async function simulateGithubPull(client: V1Client, projectId: string, opts: SimOptions = {}): Promise<SimulationResult> {
  const trace = new Trace("githubPull", projectId);
  const o = resolve(opts, { intervalMs: 8_000, maxAttempts: 60 });
  const pullPath = `projects/${enc(projectId)}/github/pull`;
  const sPath = `projects/${enc(projectId)}/github/pull-status`;
  const res = await client.post<{ status: string; message?: string }>(pullPath, {});
  if (trace.failed(`POST ${pullPath}`, res)) return trace.result("pull-failed");
  trace.step(`POST ${pullPath}`, res, `status=${res.data?.status}`);
  if (res.data?.status === "no_changes") return trace.result("no-changes");

  for (let attempt = 1; ; attempt++) {
    const st = await client.get<{ status: string | null } | null>(sPath);
    if (!trace.failed(`GET ${sPath}`, st)) {
      const status = st.data?.status ?? null;
      trace.step(`GET ${sPath}`, st, `status=${status}`);
      if (status !== null) trace.enumCheck("github/pull-status.status", status, PULL_STATUSES);
      if (attempt === 1 && status !== "pulling") {
        trace.violate("PULL_NOT_SYNCHRONOUS", `first pull-status after pull was ${JSON.stringify(status)}, expected "pulling"`);
      }
      if (status !== "pulling") return trace.result(status ?? "ended");
    }
    if (attempt >= o.maxAttempts) {
      trace.violate("POLL_TIMEOUT", `pull never ended in ${attempt} polls`);
      return trace.result("timeout");
    }
    await o.sleep(o.intervalMs);
  }
}

export interface WakeOptions extends SimOptions {
  /** A sandbox-needing call that answers 409 SERVER_NOT_READY while asleep. Default: GET backend/dev/logs (read-only, free). */
  trigger?: { method: "GET" | "POST"; path: string; body?: unknown };
}

/**
 * Sleeping server: a refused action (409 SERVER_NOT_READY) starts the wake; poll
 * projects.get every 5 s until Active AND not the cached snapshot, against a 4 min estimate.
 */
export async function simulateWake(client: V1Client, projectId: string, opts: WakeOptions = {}): Promise<SimulationResult> {
  const trace = new Trace("wake", projectId);
  const o = resolve(opts, { intervalMs: 5_000, maxAttempts: Number.POSITIVE_INFINITY });
  const capMs = opts.capMs ?? 4 * 60_000;
  const capAttempts = Math.min(o.maxAttempts, Math.max(1, Math.ceil(capMs / o.intervalMs)));
  const trigger = opts.trigger ?? { method: "GET" as const, path: `projects/${enc(projectId)}/backend/dev/logs` };
  const fire = () => (trigger.method === "GET" ? client.get(trigger.path) : client.post(trigger.path, trigger.body ?? {}));
  const isNotReady = (r: ApiResult) => r.errors?.errorCode === "SERVER_NOT_READY";

  const first = await fire();
  trace.step(`${trigger.method} ${trigger.path}`, first, first.errors ? `error ${first.errors.errorCode}` : "ok");
  if (!isNotReady(first)) {
    if (first.errors) trace.failed(`${trigger.method} ${trigger.path}`, first);
    else trace.warn("the trigger succeeded: the server was not asleep, nothing to wake");
    return trace.result("not-asleep");
  }
  if (first.status !== 409) trace.violate("WAKE_WRONG_HTTP_STATUS", `SERVER_NOT_READY came with HTTP ${first.status}, expected 409`);

  const pPath = `projects/${enc(projectId)}`;
  for (let attempt = 1; ; attempt++) {
    await o.sleep(o.intervalMs);
    const pr = await client.get<ProjectDetail>(pPath);
    if (!trace.failed(`GET ${pPath}`, pr) && pr.data) {
      const active = pr.data.agentServerStatus === "Active";
      const cached = isCachedPreview(pr.data);
      trace.step(`GET ${pPath}`, pr, `agentServerStatus=${pr.data.agentServerStatus} cached=${cached}`);
      trace.enumCheck("agentServerStatus", pr.data.agentServerStatus, SERVER_STATUSES);
      if (active && !cached) break;
    }
    if (attempt >= capAttempts) {
      trace.violate("WAKE_EXCEEDED_ESTIMATE", `server not Active and live after ${attempt} polls (${capMs} ms estimate)`);
      return trace.result("overrun");
    }
  }

  const again = await fire();
  trace.step(`${trigger.method} ${trigger.path}`, again, again.errors ? `error ${again.errors.errorCode}` : "ok");
  if (isNotReady(again)) trace.violate("STILL_NOT_READY_AFTER_WAKE", "server reported Active and live but the action still answers SERVER_NOT_READY");
  return trace.result("awake");
}

export interface LaunchInput {
  projectId: string;
  prompt: string;
}

export interface LaunchOptions extends SimOptions {
  /** Keep polling the run to its end as the workspace does. Default true. */
  waitForRun?: boolean;
}

/**
 * Hero → Enter: POST projects/launch, navigate to `data.projectId` (never the requested id),
 * then what the workspace does on load: poll when `agentProcessStatus === "init"`, or send
 * the stashed prompt with agent/start when `agent.started` is false.
 */
export async function simulateLaunch(client: V1Client, input: LaunchInput, opts: LaunchOptions = {}): Promise<SimulationResult> {
  const trace = new Trace("launch", input.projectId);
  const res = await client.post<LaunchResult>("projects/launch", {
    projectId: input.projectId,
    prompt: input.prompt,
    description: input.prompt.trim().slice(0, 200),
  });
  if (trace.failed("POST projects/launch", res)) return trace.result("launch-failed");
  const data = res.data;
  const created = data?.projectId;
  trace.step("POST projects/launch", res, `projectId=${created} started=${data?.agent?.started}`);
  if (!data || typeof created !== "string" || created === "") {
    trace.violate("LAUNCH_NO_PROJECT_ID", "launch answered without data.projectId");
    return trace.result("launch-failed");
  }
  trace.projectId = created;
  trace.details.navigatedTo = `/project/${created}`;
  if (created !== input.projectId && data.requestedProjectId !== input.projectId) {
    trace.violate("REQUESTED_ID_MISSING", `launch chose "${created}" for requested "${input.projectId}" without echoing requestedProjectId`);
  }
  for (const w of data.warnings ?? []) trace.warn(`launch warning${w.step ? ` (${w.step})` : ""}: ${w.message ?? ""}`);

  const pPath = `projects/${enc(created)}`;
  const proj = await client.get<ProjectDetail>(pPath);
  if (proj.errors || !proj.data) {
    trace.step(`GET ${pPath}`, proj, proj.errors ? `error ${proj.errors.errorCode}` : "no data");
    trace.violate("PROJECT_ID_NOT_AUTHORITATIVE", `GET ${pPath} failed right after launch returned it; data.projectId must name the created project`);
    return trace.result("launch-failed");
  }
  trace.step(`GET ${pPath}`, proj, `agentProcessStatus=${proj.data.agentProcessStatus}`);
  if (proj.data.projectId !== created) trace.violate("PROJECT_ID_NOT_AUTHORITATIVE", `GET ${pPath} returned projectId "${proj.data.projectId}"`);

  if (data.agent?.started) {
    if (proj.data.agentProcessStatus !== "init") {
      trace.violate("LAUNCH_RUN_NOT_SYNCHRONOUS", `agent.started is true but project.agentProcessStatus is "${proj.data.agentProcessStatus}"; the workspace only polls when it is "init"`);
      return trace.result("run-not-observed");
    }
    if (opts.waitForRun === false) return trace.result("started");
    const outcome = await pollRun(client, trace, created, { pendingRun: false, prompt: input.prompt }, opts);
    return trace.result(outcome);
  }

  // agent.started === false: the hero stashed the prompt; the workspace sends it.
  trace.details.sentPendingPrompt = true;
  const sPath = `projects/${enc(created)}/agent/start`;
  const start = await client.post(sPath, { prompt: input.prompt, inputFiles: [] });
  if (trace.failed(`POST ${sPath}`, start)) return trace.result("start-failed");
  trace.step(`POST ${sPath}`, start, "ok");
  if (opts.waitForRun === false) return trace.result("started");
  const outcome = await pollRun(client, trace, created, { pendingRun: true, prompt: input.prompt }, opts);
  return trace.result(outcome);
}

// ── Reporting ───────────────────────────────────────────────────────────────

export function formatResultsTable(results: SimulationResult[]): string {
  const header = ["simulator", "project", "outcome", "ok", "ms", "violations"];
  const rows = results.map((r) => [
    r.simulator,
    r.projectId,
    r.outcome,
    r.ok ? "PASS" : "FAIL",
    String(r.durationMs),
    r.violations.map((v) => v.code).join(", "),
  ]);
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((row) => (row[i] ?? "").length)));
  const line = (row: string[]) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
