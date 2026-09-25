import { bigint, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { idPk, timestamps } from "./_common.js";
import { projects } from "./projects.js";

export const uploads = pgTable(
  "uploads",
  {
    id: idPk(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Random name; what the UI stores as `{name}` in file fields. */
    fileNameId: text("file_name_id").notNull(),
    originalName: text("original_name").notNull(),
    /** Detected from content, never trusted from the client. */
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    path: text("path").notNull(),
    sha256: text("sha256").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("uploads_file_name_id_uq").on(t.fileNameId),
    index("uploads_project_idx").on(t.projectId),
  ],
);
