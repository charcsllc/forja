import { boolean, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { timestamps, tstz } from "./_common.js";

/**
 * `id` is the slug: immutable, used as a hostname (`<id>.${PREVIEW_DOMAIN}`). Reserved
 * slugs live in packages/contracts (`slug.ts`).
 */
export const projects = pgTable(
  "projects",
  {
    id: text("id").primaryKey(),
    label: text("label").notNull(),
    description: text("description"),
    template: text("template").notNull().default("nextjs-postgres"),
    templateVersion: text("template_version"),
    language: text("language").notNull().default("en"),
    /** agentServerStatus: Creating | Starting | Active | Archiving | Archived | Unarchiving. */
    serverStatus: text("server_status").notNull().default("Creating"),
    /** agentProcessStatus projection cache: init | done | idle. */
    processStatus: text("process_status").notNull().default("idle"),
    devUrl: text("dev_url"),
    internalDevUrl: text("internal_dev_url"),
    cachedUrl: text("cached_url"),
    /** A field NAME (developmentUrlFieldToUse), never a URL. */
    urlFieldToUse: text("url_field_to_use").notNull().default("temporalDevelopmentProjectUrl"),
    productionHost: text("production_host"),
    previewImagePath: text("preview_image_path"),
    archivedAt: tstz("archived_at"),
    lastActivityAt: tstz("last_activity_at"),
    deletedAt: tstz("deleted_at"),
    purgeAfter: tstz("purge_after"),
    /** Last sandbox failure (provision, wake, restart), shown as `serverErrorMessage`; null when healthy. */
    serverError: text("server_error"),
    /** `rebuild/status`: idle | rebuilding | success | error. */
    rebuildStatus: text("rebuild_status").notNull().default("idle"),
    rebuildStartedAt: tstz("rebuild_started_at"),
    rebuildError: text("rebuild_error"),
    /** A no-op rebuild (nothing to apply) resolves to `success` on the first status read after it. */
    rebuildNoop: boolean("rebuild_noop").notNull().default(false),
    /** `main` HEAD and rendered-env hash at the last provision or successful rebuild. */
    rebuildSha: text("rebuild_sha"),
    rebuildEnvHash: text("rebuild_env_hash"),
    /** `versionRecovery` (research/02 §3): {status, versionId, startedAt, errorMessage?} | null. */
    versionRecovery: jsonb("version_recovery"),
    ...timestamps,
  },
  (t) => [
    index("projects_created_at_idx").on(t.createdAt),
    index("projects_purge_after_idx").on(t.purgeAfter),
  ],
);
