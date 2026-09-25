/**
 * Tables 05 §1 lists "como antes" without columns. These are the minimal shapes the phase 5
 * integrations need; extend them with a migration when that phase lands.
 */
import { boolean, index, integer, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { idPk, timestamps, tstz } from "./_common.js";
import { projects } from "./projects.js";

export const integrationsGithub = pgTable("integrations_github", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  repoOwner: text("repo_owner").notNull(),
  repoName: text("repo_name").notNull(),
  branch: text("branch").notNull().default("main"),
  /** Token encrypted like `secrets` (base64 ciphertext + nonce). */
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenNonce: text("token_nonce").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  tokenExpiresAt: tstz("token_expires_at"),
  lastPullAt: tstz("last_pull_at"),
  lastPushAt: tstz("last_push_at"),
  ...timestamps,
});

export const integrationsFigma = pgTable("integrations_figma", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  tokenCiphertext: text("token_ciphertext").notNull(),
  tokenNonce: text("token_nonce").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  accountHandle: text("account_handle"),
  accountEmail: text("account_email"),
  ...timestamps,
});

/** Account-scoped, one per event (research/02). */
export const webhooks = pgTable(
  "webhooks",
  {
    id: idPk(),
    event: text("event").notNull(),
    url: text("url").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretNonce: text("secret_nonce").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("webhooks_event_idx").on(t.event)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: idPk(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    /** pending | delivered | failed */
    status: text("status").notNull().default("pending"),
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: tstz("next_attempt_at"),
    responseStatus: integer("response_status"),
    error: text("error"),
    ...timestamps,
  },
  (t) => [index("webhook_deliveries_pending_idx").on(t.status, t.nextAttemptAt)],
);

export const projectGroups = pgTable("project_groups", {
  id: idPk(),
  name: text("name").notNull(),
  ...timestamps,
});

/** Instance-wide key/value settings. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  ...timestamps,
});
