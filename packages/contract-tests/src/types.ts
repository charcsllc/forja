/**
 * The slice of the v1 wire shapes the UI's polling depends on (research/02 §3–§5).
 *
 * What this file protects: the simulators assert against the same field names and enums
 * the UI reads, and nothing more; an engine is free to add fields.
 *
 * TODO(phase-0): switch to @forja/contracts (v1/status, v1/project, v1/conversation).
 */

export const RUN_STATUSES = ["init", "done", "idle"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const SERVER_STATUSES = ["Active", "Creating", "Starting", "Archived", "Unarchiving", "Archiving"] as const;
export type ServerStatus = (typeof SERVER_STATUSES)[number];

export const DEPLOY_STATUSES = ["deploying", "success", "error"] as const;
export type DeployStatus = (typeof DEPLOY_STATUSES)[number];

export const REBUILD_STATUSES = ["idle", "rebuilding", "success", "error"] as const;
export type RebuildStatus = (typeof REBUILD_STATUSES)[number];

export const PULL_STATUSES = ["pulling", "success", "error"] as const;
export type PullStatus = (typeof PULL_STATUSES)[number];

export const MESSAGE_TYPES = ["regular", "starting", "building", "finished", "error", "limit-reached"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** A run's conversation must end in one of these (research/02 §5). */
export const TERMINAL_MESSAGE_TYPES: readonly MessageType[] = ["finished", "error", "limit-reached"];

export interface ConversationMessage {
  author: "user" | "agent";
  message: string;
  messageType: MessageType;
  createdAt: string;
  versionId?: string;
}

export interface AgentStatus {
  projectId: string;
  status: RunStatus;
  startedAt?: string | null;
  realtimeConversation?: ConversationMessage[];
  expectedMinutes?: number;
}

export interface ProjectDetail {
  projectId: string;
  label?: string;
  agentProcessStatus?: RunStatus;
  agentServerStatus?: ServerStatus;
  deployment?: { status: DeployStatus | null; createdAt?: string } | null;
  versionRecovery?: { status: "recovering" | "error"; versionId: string; startedAt?: string; errorMessage?: string } | null;
  temporalDevelopmentProjectUrl?: string;
  cachedDevelopmentUrl?: string;
  developmentUrlFieldToUse?: string;
  productionProjectUrl?: string;
}

export interface LaunchResult {
  projectId: string;
  requestedProjectId?: string;
  agent?: { started: boolean; status?: string; message?: string };
  warnings?: { step?: string; message?: string; endpoint?: string }[];
}

/** The UI's dedupe key for realtime agent messages (page.tsx `pollAgentOnce`). */
export function dedupeKey(m: Pick<ConversationMessage, "createdAt" | "message">): string {
  return `${m.createdAt}|${(m.message ?? "").slice(0, 60)}`;
}

/** `getPreviewUrl` in apps/web lib/project-status.ts. */
export function getPreviewUrl(p: ProjectDetail): string | null {
  const field = p.developmentUrlFieldToUse || "temporalDevelopmentProjectUrl";
  const chosen = (p as unknown as Record<string, unknown>)[field];
  if (typeof chosen === "string" && chosen) return chosen;
  return p.temporalDevelopmentProjectUrl || p.cachedDevelopmentUrl || null;
}

/** `isCachedPreview` in apps/web lib/project-status.ts: compares the RESOLVED url. */
export function isCachedPreview(p: ProjectDetail): boolean {
  const rendered = getPreviewUrl(p);
  return !!rendered && !!p.cachedDevelopmentUrl && rendered === p.cachedDevelopmentUrl;
}
