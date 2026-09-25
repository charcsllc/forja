import { index, integer, numeric, pgTable, text } from "drizzle-orm/pg-core";
import { idPk, timestamps } from "./_common.js";
import { projects } from "./projects.js";
import { runs, tasks } from "./runs.js";

/** One row per model call (02 §6). */
export const llmCalls = pgTable(
  "llm_calls",
  {
    id: idPk(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    role: text("role"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    ttftMs: integer("ttft_ms"),
    /** ok | error | cancelled | ... */
    outcome: text("outcome").notNull(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("llm_calls_run_idx").on(t.runId),
    index("llm_calls_project_created_idx").on(t.projectId, t.createdAt),
  ],
);

/** One row per image search/generation call (02 §7), charged to the run budget. */
export const mediaCalls = pgTable(
  "media_calls",
  {
    id: idPk(),
    projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    role: text("role"),
    provider: text("provider").notNull(),
    /** search | generate | edit */
    kind: text("kind").notNull(),
    model: text("model"),
    units: integer("units").notNull().default(1),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }).notNull().default("0"),
    latencyMs: integer("latency_ms"),
    outcome: text("outcome").notNull(),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("media_calls_run_idx").on(t.runId),
    index("media_calls_project_created_idx").on(t.projectId, t.createdAt),
  ],
);
