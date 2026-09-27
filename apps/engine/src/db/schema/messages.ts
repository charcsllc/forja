import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { idPk } from "./_common.js";
import { projects } from "./projects.js";
import { runs } from "./runs.js";
import { versions } from "./versions.js";

/**
 * ⚠️ `created_at` has microsecond precision and is STRICTLY increasing per project (the UI
 * dedupes messages on it). The engine assigns it (sequence + clock); the unique index is the
 * database-side backstop.
 */
export const messages = pgTable(
  "messages",
  {
    id: idPk(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    author: text("author").notNull(),
    type: text("type").notNull().default("regular"),
    text: text("text").notNull().default(""),
    versionId: text("version_id").references(() => versions.id, { onDelete: "set null" }),
    secretKeysNeeded: jsonb("secret_keys_needed").notNull().default([]),
    files: jsonb("files").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 6 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("messages_project_created_at_uq").on(t.projectId, t.createdAt),
    index("messages_run_idx").on(t.runId),
  ],
);
