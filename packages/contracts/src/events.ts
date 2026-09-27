/**
 * Run events (`run_events.type` + `payload`) and their envelope.
 *
 * Protects: the catalogue of docs/architecture/05-data-model-and-api.md §4, shared by the
 * orchestrator that appends events, the v2 SSE stream and the UI that renders it.
 * Payloads stay small: large content (full tool arguments, patches, long output) goes to
 * a blob whose path travels in `blob` (payload) or `blobPath` (envelope, when the whole
 * payload exceeded 8 KB). Text deltas are ephemeral and never part of this union.
 */
import { z } from "zod";
import { AgentRoleSchema, IntentSchema, RunStatusSchema } from "./plan";
import {
  DesignReviewSchema,
  ReviewSchema,
  SecretKeyNeededSchema,
  SeveritySchema,
  SummarySchema,
  TaskReportSchema,
  TriageSchema,
  ReviewVerdictSchema,
} from "./reports";
import { AgentServerStatusSchema, DeploymentStateSchema } from "./v1/status";
import { DomainSslStatusSchema, DomainStatusSchema } from "./v1/domain";
import { MessageAuthorSchema, MessageTypeSchema } from "./v1/conversation";

// ─── Shared payload parts ────────────────────────────────────────────────────

const blob = z.string().min(1).optional();

export const CostSchema = z.object({
  usd: z.number().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});
export type Cost = z.infer<typeof CostSchema>;

/** A task's final `submit_*` output, tagged by the tool that produced it. */
export const TaskOutputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("report"), data: TaskReportSchema }),
  z.object({ kind: z.literal("review"), data: ReviewSchema }),
  z.object({ kind: z.literal("triage"), data: TriageSchema }),
  z.object({ kind: z.literal("design_review"), data: DesignReviewSchema }),
  z.object({ kind: z.literal("summary"), data: SummarySchema }),
]);
export type TaskOutput = z.infer<typeof TaskOutputSchema>;

export const ParsedGateErrorSchema = z.object({
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  code: z.string().optional(),
  message: z.string(),
});
export type ParsedGateError = z.infer<typeof ParsedGateErrorSchema>;

const budget = { spentUsd: z.number().nonnegative(), budgetUsd: z.number().nonnegative() };

// ─── Envelope ────────────────────────────────────────────────────────────────

const EventBaseSchema = z.object({
  /** `run_events.seq` (bigserial). */
  seq: z.number().int().nonnegative(),
  runId: z.string().min(1),
  taskId: z.string().nullish(),
  /** ISO timestamp. */
  ts: z.string(),
  /** Set when the payload itself was moved to blob storage (> 8 KB). */
  blobPath: z.string().optional(),
});

function event<T extends string, P extends z.ZodRawShape>(type: T, payload: P) {
  return EventBaseSchema.extend({ type: z.literal(type), payload: z.object(payload) });
}

// ─── The union ───────────────────────────────────────────────────────────────

export const RunEventSchema = z.discriminatedUnion("type", [
  // Run lifecycle.
  event("run.received", {
    promptPreview: z.string(),
    inputFileCount: z.number().int().nonnegative(),
  }),
  event("run.phase", { from: RunStatusSchema, to: RunStatusSchema }),
  event("run.finished", {
    status: z.enum(["done", "failed", "limit-reached", "cancelled"]),
    summary: z.string(),
    cost: CostSchema,
  }),

  // Plan.
  event("plan.created", { intent: IntentSchema, taskCount: z.number().int().nonnegative(), blob }),
  event("plan.rejected", { reason: z.string(), errors: z.array(z.string()).optional() }),
  event("plan.approved", {}),

  // Tasks.
  event("task.started", {
    taskId: z.string(),
    role: AgentRoleSchema,
    title: z.string(),
    attempt: z.number().int().positive(),
  }),
  event("task.turn", { taskId: z.string(), n: z.number().int().positive() }),
  event("task.finished", { taskId: z.string(), report: TaskOutputSchema, cost: CostSchema }),
  event("task.failed", { taskId: z.string(), error: z.string() }),
  event("task.retried", {
    taskId: z.string(),
    attempt: z.number().int().positive(),
    reason: z.string(),
  }),
  event("task.checkpoint", { taskId: z.string(), turn: z.number().int().nonnegative() }),

  // Model output and tools (per turn).
  event("text", { taskId: z.string(), role: AgentRoleSchema, text: z.string() }),
  event("tool.call", { taskId: z.string(), name: z.string(), argsSummary: z.string(), blob }),
  event("tool.result", {
    taskId: z.string(),
    name: z.string(),
    ok: z.boolean(),
    summary: z.string(),
    durationMs: z.number().nonnegative(),
    blob,
  }),
  event("file.diff", {
    taskId: z.string(),
    path: z.string(),
    stat: z.object({
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }),
    blob: z.string().min(1),
  }),
  event("command.output", {
    taskId: z.string(),
    cmd: z.string(),
    exitCode: z.number().int().nullable(),
    tail: z.string(),
    blob,
  }),
  event("scope.violation", { taskId: z.string(), path: z.string() }),

  // Integration.
  event("integration.report", {
    summary: z.string(),
    secretKeysNeeded: z.array(SecretKeyNeededSchema).optional(),
  }),
  event("rework.requested", {
    from: AgentRoleSchema,
    to: AgentRoleSchema,
    reason: z.string(),
    taskId: z.string().optional(),
  }),

  // Gates.
  event("gate.started", { name: z.string() }),
  event("gate.passed", { name: z.string(), durationMs: z.number().nonnegative().optional() }),
  event("gate.failed", {
    name: z.string(),
    parsed: z.array(ParsedGateErrorSchema),
    routedTo: AgentRoleSchema,
    output: z.string().optional(),
    blob,
  }),

  // Review.
  event("review.finding", {
    severity: SeveritySchema,
    file: z.string(),
    line: z.number().int().positive().optional(),
    title: z.string(),
  }),
  event("review.summary", { verdict: ReviewVerdictSchema, summary: z.string() }),
  event("screenshot", { path: z.string(), page: z.string(), width: z.number().int().positive() }),
  event("design.review", {
    page: z.string(),
    verdict: z.enum(["pass", "fail"]),
    notes: z.string(),
  }),

  // Budget.
  event("cost.tick", budget),
  event("budget.warning", { ...budget, ratio: z.number().nonnegative() }),
  event("budget.exhausted", budget),

  // Context management.
  event("context.compacted", {
    taskId: z.string(),
    fromTurn: z.number().int().nonnegative(),
    toTurn: z.number().int().nonnegative(),
    tokensBefore: z.number().int().nonnegative().optional(),
    tokensAfter: z.number().int().nonnegative().optional(),
  }),
  event("context.rebuilt", { taskId: z.string(), reason: z.string() }),

  // Infrastructure status.
  event("sandbox.status", { status: AgentServerStatusSchema }),
  event("deploy.status", { status: DeploymentStateSchema, deploymentId: z.string().optional() }),
  event("domain.status", {
    hostname: z.string(),
    status: DomainStatusSchema,
    sslStatus: DomainSslStatusSchema.optional(),
  }),

  // User-visible message mirrored into the stream.
  event("message", { author: MessageAuthorSchema, type: MessageTypeSchema, text: z.string() }),

  // Host pressure (fractions of capacity in use, 0..1).
  event("system.pressure", { disk: z.number().min(0).max(1), memory: z.number().min(0).max(1) }),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
export type RunEventType = RunEvent["type"];
export type RunEventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;
export type RunEventPayload<T extends RunEventType> = RunEventOf<T>["payload"];

/** Every event type, in catalogue order. */
export const RUN_EVENT_TYPES: readonly RunEventType[] = RunEventSchema.options.map(
  (o) => o.shape.type.value,
);
