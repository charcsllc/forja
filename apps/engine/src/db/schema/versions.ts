import { index, jsonb, pgTable, text, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { idPk, timestamps } from "./_common.js";
import { projects } from "./projects.js";
import { runs } from "./runs.js";

export const versions = pgTable(
  "versions",
  {
    id: idPk(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    tag: text("tag").notNull(),
    commitSha: text("commit_sha").notNull(),
    parentSha: text("parent_sha"),
    message: text("message").notNull(),
    prompt: text("prompt"),
    recoveredFromId: text("recovered_from_id").references((): AnyPgColumn => versions.id, {
      onDelete: "set null",
    }),
    checks: jsonb("checks").notNull().default({}),
    dbDumpPath: text("db_dump_path"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("versions_project_tag_uq").on(t.projectId, t.tag),
    index("versions_project_created_idx").on(t.projectId, t.createdAt),
  ],
);
