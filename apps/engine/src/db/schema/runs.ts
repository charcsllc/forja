import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idPk, timestamps, tstz } from "./_common.js";
import { projects } from "./projects.js";

/** Terminal run statuses (03 §3); everything else counts as "active". */
export const TERMINAL_RUN_STATUSES = ["done", "failed", "limit-reached", "cancelled"] as const;

export const runs = pgTable(
  "runs",
  {
    id: idPk(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("received"),
    intent: text("intent"),
    prompt: text("prompt").notNull(),
    inputFiles: jsonb("input_files").notNull().default([]),
    options: jsonb("options").notNull().default({}),
    plan: jsonb("plan"),
    budgetUsd: numeric("budget_usd", { precision: 12, scale: 4 }),
    spentUsd: numeric("spent_usd", { precision: 12, scale: 4 }).notNull().default("0"),
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
    heartbeatAt: tstz("heartbeat_at"),
    expectedMinutes: integer("expected_minutes"),
    error: text("error"),
    cancelRequestedAt: tstz("cancel_requested_at"),
    ...timestamps,
  },
  (t) => [
    // ⭐ At most one non-terminal run per project.
    uniqueIndex("runs_one_active_per_project")
      .on(t.projectId)
      .where(sql`${t.status} not in ('done', 'failed', 'limit-reached', 'cancelled')`),
    index("runs_project_created_idx").on(t.projectId, t.createdAt),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: idPk(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    planTaskId: text("plan_task_id").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    scope: jsonb("scope").notNull().default({}),
    attempt: integer("attempt").notNull().default(0),
    turns: integer("turns").notNull().default(0),
    spentUsd: numeric("spent_usd", { precision: 12, scale: 4 }).notNull().default("0"),
    leaseUntil: tstz("lease_until"),
    /** Native messages + effects journal. */
    checkpoint: jsonb("checkpoint"),
    report: jsonb("report"),
    ...timestamps,
  },
  (t) => [index("tasks_run_idx").on(t.runId)],
);

/** Append-only; no deltas; payloads > 8 KB go to `blob_path`. */
export const runEvents = pgTable(
  "run_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    ts: tstz("ts").notNull().defaultNow(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    blobPath: text("blob_path"),
    ...timestamps,
  },
  (t) => [
    index("run_events_run_seq_idx").on(t.runId, t.seq),
    index("run_events_ts_idx").on(t.ts),
  ],
);
