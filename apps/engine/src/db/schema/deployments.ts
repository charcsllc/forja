import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { idPk, timestamps, tstz } from "./_common.js";
import { projects } from "./projects.js";
import { versions } from "./versions.js";

export const deployments = pgTable(
  "deployments",
  {
    id: idPk(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionId: text("version_id").references(() => versions.id, { onDelete: "set null" }),
    status: text("status").notNull().default("deploying"),
    imageTag: text("image_tag"),
    container: text("container"),
    log: text("log"),
    migrationsApplied: boolean("migrations_applied").notNull().default(false),
    startedAt: tstz("started_at"),
    finishedAt: tstz("finished_at"),
    ...timestamps,
  },
  (t) => [index("deployments_project_created_idx").on(t.projectId, t.createdAt)],
);

/** One custom domain per project in v1. */
export const domains = pgTable(
  "domains",
  {
    id: idPk(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    status: text("status").notNull().default("pending_validation"),
    sslStatus: text("ssl_status").notNull().default("initializing"),
    verifyToken: text("verify_token").notNull(),
    dnsRecords: jsonb("dns_records").notNull().default([]),
    lastCheckedAt: tstz("last_checked_at"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("domains_hostname_uq").on(t.hostname),
    uniqueIndex("domains_project_uq").on(t.projectId),
  ],
);
