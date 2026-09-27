/**
 * Project shapes of API v1: the project object, the list summary, and the
 * create / launch / update / export / import requests and results.
 *
 * Protects: every field the UI reads from `GET /projects` and `GET /projects/:id`
 * (docs/research/02 §1.1, §4), with the UI's exact names. `projectId` is the identity;
 * `label` is display only. `developmentUrlFieldToUse` is a FIELD NAME, not a URL, and
 * `productionProjectUrl` is a bare hostname.
 */
import { z } from "zod";
import { VcaasDomainSchema } from "./domain";
import { VcaasSecretSchema, SecretEnvironmentSchema } from "./secrets";
import {
  AgentProcessStatusSchema,
  AgentServerStatusSchema,
  DeploymentStateSchema,
  ImportInProgressSchema,
  VersionRecoverySchema,
} from "./status";

/** `project.deployment`: the latest deployment, `null` when never published. */
export const ProjectDeploymentSchema = z.object({
  status: DeploymentStateSchema,
  createdAt: z.string(),
  versionId: z.string().optional(),
});
export type ProjectDeployment = z.infer<typeof ProjectDeploymentSchema>;

/** Project URL fields a `developmentUrlFieldToUse` may name. */
export const DevelopmentUrlFieldSchema = z.enum([
  "temporalDevelopmentProjectUrl",
  "cachedDevelopmentUrl",
]);
export type DevelopmentUrlField = z.infer<typeof DevelopmentUrlFieldSchema>;

export const VcaasProjectSchema = z.object({
  projectId: z.string(),
  label: z.string().optional(),
  groupId: z.string().optional(),
  description: z.string(),
  /** Always `"self-hosted"` from the engine. */
  plan: z.string(),
  agentProcessStatus: AgentProcessStatusSchema.optional(),
  agentServerStatus: AgentServerStatusSchema.optional(),
  createdAt: z.string(),
  deployment: ProjectDeploymentSchema.nullish(),
  versionRecovery: VersionRecoverySchema.nullish(),
  importInProgress: ImportInProgressSchema.nullish(),
  secrets: z.array(VcaasSecretSchema),
  customDomain: VcaasDomainSchema.nullish(),
  /** Absolute URL, reachable from the browser iframe and from the UI server. */
  temporalDevelopmentProjectUrl: z.string().nullish(),
  /** Absolute URL of the static snapshot served while the sandbox sleeps. */
  cachedDevelopmentUrl: z.string().nullish(),
  /** Name of the field above to read; default `temporalDevelopmentProjectUrl`. */
  developmentUrlFieldToUse: z.string().nullish(),
  /** Hostname without scheme. */
  productionProjectUrl: z.string().optional(),
  previewImageUrl: z.string().nullish(),
  totalCreditsSpent: z.number().optional(),
  /** Engine only: dev URL on the internal network, read by the UI server's preview proxy. */
  internalDevelopmentUrl: z.string().nullish(),
});
export type VcaasProject = z.infer<typeof VcaasProjectSchema>;

/** One row of `GET /projects`. The backend must return all projects when no `limit`. */
export const VcaasProjectSummarySchema = z.object({
  projectId: z.string(),
  description: z.string(),
  label: z.string().optional(),
  groupId: z.string().optional(),
  plan: z.string(),
  createdAt: z.string(),
  lastModifiedAt: z.string().optional(),
  previewImageUrl: z.string().nullish(),
});
export type VcaasProjectSummary = z.infer<typeof VcaasProjectSummarySchema>;

/** Query string of `GET /projects` (all optional; the home page sends none). */
export const ProjectListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  skip: z.coerce.number().int().nonnegative().optional(),
  search: z.string().optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
  sortField: z.enum(["lastModified"]).optional(),
  groupId: z.string().optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
});
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;

/** `POST /projects`. The returned `projectId` may differ from the requested one. */
export const ProjectCreateRequestSchema = z.object({
  projectId: z.string(),
  description: z.string(),
  label: z.string().optional(),
  groupId: z.string().optional(),
});
export type ProjectCreateRequest = z.infer<typeof ProjectCreateRequestSchema>;

/** `POST /projects/launch`. The UI sends only `projectId, prompt, description, figma?`. */
export const ProjectLaunchRequestSchema = z.object({
  projectId: z.string(),
  prompt: z.string().min(1),
  description: z.string().max(200).optional(),
  label: z.string().optional(),
  groupId: z.string().optional(),
  files: z
    .array(z.object({ name: z.string(), description: z.string().optional(), url: z.string() }))
    .optional(),
  secrets: z
    .array(
      z.object({
        secretName: z.string(),
        secretValue: z.string(),
        environment: SecretEnvironmentSchema.optional(),
      }),
    )
    .optional(),
  figma: z.object({ token: z.string() }).optional(),
});
export type ProjectLaunchRequest = z.infer<typeof ProjectLaunchRequestSchema>;

export const LaunchWarningSchema = z.object({
  step: z.string().optional(),
  message: z.string().optional(),
  endpoint: z.string().optional(),
});
export type LaunchWarning = z.infer<typeof LaunchWarningSchema>;

/** `POST /projects/launch` result. A Figma failure is `warnings[].step === "figma"`. */
export const ProjectLaunchResultSchema = z.object({
  projectId: z.string(),
  /** Present only when the requested id was taken and another was chosen. */
  requestedProjectId: z.string().optional(),
  agent: z.object({
    started: z.boolean(),
    status: z.string().optional(),
    message: z.string().optional(),
  }),
  warnings: z.array(LaunchWarningSchema).optional(),
});
export type ProjectLaunchResult = z.infer<typeof ProjectLaunchResultSchema>;

/** `PATCH /projects/:id`: send only changed fields, `null` clears. */
export const ProjectUpdateRequestSchema = z.object({
  label: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
});
export type ProjectUpdateRequest = z.infer<typeof ProjectUpdateRequestSchema>;

export const ProjectExportRequestSchema = z.object({ includeRecords: z.boolean() });
export type ProjectExportRequest = z.infer<typeof ProjectExportRequestSchema>;

/** `importCode` is a bearer credential: never log it or put it in a URL. */
export const ProjectExportResultSchema = z.object({
  importCode: z.string(),
  includeRecords: z.boolean(),
  message: z.string().optional(),
});
export type ProjectExportResult = z.infer<typeof ProjectExportResultSchema>;

export const ProjectImportRequestSchema = z.object({ importCode: z.string().min(1) });
export type ProjectImportRequest = z.infer<typeof ProjectImportRequestSchema>;

/** Returns immediately; the caller polls `project.importInProgress`. */
export const ProjectImportResultSchema = z.object({
  projectId: z.string(),
  status: z.string(),
  message: z.string().optional(),
});
export type ProjectImportResult = z.infer<typeof ProjectImportResultSchema>;

/** `/project-groups` (unused by the UI, kept for API parity). */
export const ProjectGroupSchema = z.object({
  groupId: z.string(),
  name: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  projectCount: z.number().int().optional(),
});
export type ProjectGroup = z.infer<typeof ProjectGroupSchema>;
