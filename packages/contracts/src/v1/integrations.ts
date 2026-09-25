/**
 * GitHub and Figma integration shapes of API v1.
 *
 * Protects: the status objects the UI's modals read. Until phase 5 the engine answers
 * the stubs `{connected:false, tokenValid:false, tokenExpired:false}` (GitHub),
 * `{status:null}` (pull) and `{connected:false}` (Figma). No shape carries a token back.
 */
import { z } from "zod";
import { GithubPullStateSchema } from "./status";

export const GithubStatusSchema = z.object({
  connected: z.boolean(),
  tokenValid: z.boolean(),
  tokenExpired: z.boolean(),
  repositoryFullName: z.string().optional(),
  developBranch: z.string().optional(),
  productionBranch: z.string().optional(),
});
export type GithubStatus = z.infer<typeof GithubStatusSchema>;

export const GithubSyncDirectionSchema = z.enum(["totalum_to_github", "github_to_totalum"]);
export type GithubSyncDirection = z.infer<typeof GithubSyncDirectionSchema>;

export const GithubConnectRequestSchema = z.object({
  token: z.string().min(1),
  repositoryFullName: z.string().min(1),
  syncDirection: GithubSyncDirectionSchema,
});
export type GithubConnectRequest = z.infer<typeof GithubConnectRequestSchema>;

export const GithubConnectResultSchema = z.object({
  connected: z.boolean(),
  repositoryFullName: z.string(),
  syncAction: z.enum(["push_new", "push", "pull", "merge_and_push", "already_synced"]),
  repoHasContent: z.boolean(),
  requiresRebuild: z.boolean(),
});
export type GithubConnectResult = z.infer<typeof GithubConnectResultSchema>;

/** `GET P/github/pull-status`: `pulling` must be visible before `pull` answers. */
export const GithubPullStatusSchema = z.object({
  status: GithubPullStateSchema.nullable(),
  createdAt: z.string().optional(),
});
export type GithubPullStatus = z.infer<typeof GithubPullStatusSchema>;

export const GithubPullResultSchema = z.object({
  status: z.enum(["pulling", "no_changes"]),
  message: z.string(),
  filesUpdated: z.number().int().nonnegative(),
});
export type GithubPullResult = z.infer<typeof GithubPullResultSchema>;

/** `GET P/github/env`: dotenv text; values masked unless `ALLOW_ENV_EXPORT=true`. */
export const GithubEnvSchema = z.object({
  envDev: z.string(),
  envProd: z.string(),
});
export type GithubEnv = z.infer<typeof GithubEnvSchema>;

export const FigmaAccountSchema = z.object({
  id: z.string(),
  handle: z.string(),
  email: z.string().optional(),
  imgUrl: z.string().optional(),
});
export type FigmaAccount = z.infer<typeof FigmaAccountSchema>;

/** `GET P/figma/status[?verify=true]`. */
export const FigmaStatusSchema = z.object({
  connected: z.boolean(),
  account: FigmaAccountSchema.optional(),
  connectedAt: z.string().optional(),
  tokenValid: z.boolean().optional(),
  tokenError: z.string().optional(),
});
export type FigmaStatus = z.infer<typeof FigmaStatusSchema>;

/** `POST P/figma/connect` and `POST /figma/validate` bodies. */
export const FigmaTokenRequestSchema = z.object({ token: z.string().min(1) });
export type FigmaTokenRequest = z.infer<typeof FigmaTokenRequestSchema>;

export const FigmaConnectResultSchema = z.object({
  connected: z.boolean(),
  account: FigmaAccountSchema,
});
export type FigmaConnectResult = z.infer<typeof FigmaConnectResultSchema>;

/** `valid` is not `connected`: nothing was stored. */
export const FigmaValidateResultSchema = z.object({
  valid: z.boolean(),
  account: FigmaAccountSchema.optional(),
});
export type FigmaValidateResult = z.infer<typeof FigmaValidateResultSchema>;
