import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { timestamps, tstz } from "./_common.js";
import { projects } from "./projects.js";

/** One heavy operation per project, with a TTL (`expires_at`). */
export const operations = pgTable("operations", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  startedAt: tstz("started_at").notNull().defaultNow(),
  expiresAt: tstz("expires_at").notNull(),
  payload: jsonb("payload").notNull().default({}),
  ...timestamps,
});
