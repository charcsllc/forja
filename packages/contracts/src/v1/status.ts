/**
 * State-machine enums and in-flight operation markers of API v1.
 *
 * Protects: the exact status strings the UI polls on (docs/research/02 §3). There is no
 * `error` agent status: a failed run is reported in the conversation instead.
 */
import { z } from "zod";

/** `agent/status.status` and `project.agentProcessStatus`. */
export const AgentProcessStatusSchema = z.enum(["init", "done", "idle"]);
export type AgentProcessStatus = z.infer<typeof AgentProcessStatusSchema>;

/** `project.agentServerStatus`: the sandbox lifecycle. */
export const AgentServerStatusSchema = z.enum([
  "Active",
  "Creating",
  "Starting",
  "Archived",
  "Unarchiving",
  "Archiving",
]);
export type AgentServerStatus = z.infer<typeof AgentServerStatusSchema>;

/** A deployment that exists. `deployments/status` adds `null` for "never published". */
export const DeploymentStateSchema = z.enum(["deploying", "success", "error"]);
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;

export const RebuildStateSchema = z.enum(["idle", "rebuilding", "success", "error"]);
export type RebuildState = z.infer<typeof RebuildStateSchema>;

export const GithubPullStateSchema = z.enum(["pulling", "success", "error"]);
export type GithubPullState = z.infer<typeof GithubPullStateSchema>;

/** `project.versionRecovery`: set synchronously on recover, `null` when none runs. */
export const VersionRecoverySchema = z.object({
  status: z.enum(["recovering", "error"]),
  versionId: z.string(),
  startedAt: z.string(),
  errorMessage: z.string().optional(),
});
export type VersionRecovery = z.infer<typeof VersionRecoverySchema>;

/** `project.importInProgress`: set synchronously on import, `null` when done or failed. */
export const ImportInProgressSchema = z.object({
  startedAt: z.string(),
  errorMessage: z.string().optional(),
});
export type ImportInProgress = z.infer<typeof ImportInProgressSchema>;
