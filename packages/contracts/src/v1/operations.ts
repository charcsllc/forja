/**
 * Long-running operation shapes of API v1: deployments and rebuilds.
 *
 * Protects: the synchronous transitions the UI's pollers rely on (docs/research/02 §3):
 * `deployments/status` must read `deploying` and `rebuild/status` must read `rebuilding`
 * before the start call answers; `deployments/status.status` is `null` when the project
 * was never published.
 */
import { z } from "zod";
import { DeploymentStateSchema, RebuildStateSchema } from "./status";

/** `GET P/deployments/status`. */
export const DeploymentStatusResultSchema = z.object({
  status: DeploymentStateSchema.nullable(),
  createdAt: z.string().optional(),
});
export type DeploymentStatusResult = z.infer<typeof DeploymentStatusResultSchema>;

/** `POST P/rebuild` answer. */
export const RebuildStartResultSchema = z.object({
  status: RebuildStateSchema,
  startedAt: z.string(),
});
export type RebuildStartResult = z.infer<typeof RebuildStartResultSchema>;

/** `GET P/rebuild/status`. Three consecutive `idle` reads end a watcher silently. */
export const RebuildStatusResultSchema = z.object({
  status: RebuildStateSchema,
  errorMessage: z.string().optional(),
});
export type RebuildStatusResult = z.infer<typeof RebuildStatusResultSchema>;
