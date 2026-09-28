/**
 * The engine's persistence port.
 *
 * Protects: services never talk SQL directly, so the same service code runs against
 * Postgres (`PgStore`, production) and an in-memory store (`MemoryStore`, unit tests) with
 * identical semantics for the parts that matter:
 * - `insertProject` refuses a taken id (deleted projects keep theirs until purged);
 * - `acquireOperation` is atomic: one heavy operation per project, a stale slot (past
 *   `expiresAt`) may be taken over, and `releaseOperation` only frees the slot it names;
 * - secrets are stored encrypted; the store never sees a plaintext value.
 */
import type { llmCalls, mediaCalls, messages, operations, projects, runEvents, runs, secrets, tasks, uploads, versions } from "../db/schema/index.js";

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type ProjectPatch = Partial<Omit<ProjectRow, "id" | "createdAt">>;

export type OperationRow = typeof operations.$inferSelect;

// ── Runs (phase 2) ──
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type RunPatch = Partial<Omit<RunRow, "id" | "projectId" | "createdAt">>;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TaskPatch = Partial<Omit<TaskRow, "id" | "runId" | "createdAt">>;
export type RunEventRow = typeof runEvents.$inferSelect;
export interface NewRunEvent {
  runId: string;
  taskId?: string | null;
  type: string;
  payload: Record<string, unknown>;
  blobPath?: string | null;
}
export type MessageRow = typeof messages.$inferSelect;
export interface NewMessage {
  projectId: string;
  runId?: string | null;
  author: "user" | "agent";
  type: "regular" | "starting" | "building" | "finished" | "error" | "limit-reached";
  text: string;
  versionId?: string | null;
  /** `{NAME: {isProvided, description}}` (research/02 §5). */
  secretKeysNeeded?: Record<string, { isProvided: boolean; description: string }>;
  files?: unknown[];
}
export type VersionRow = typeof versions.$inferSelect;
export type NewVersionRow = typeof versions.$inferInsert;
export type NewLlmCall = typeof llmCalls.$inferInsert;
export type NewMediaCall = typeof mediaCalls.$inferInsert;
export type SecretRow = typeof secrets.$inferSelect;
export type UploadRow = typeof uploads.$inferSelect;

/** Heavy operations (one slot per project). `wake` and `provision` are engine-internal. */
export const OPERATION_KINDS = ["provision", "wake", "restartServer", "rebuild", "restoreVersion", "archive", "remove"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export interface OperationPayload {
  /** Random per acquisition; jobs carry it and do nothing when the slot moved on. */
  token: string;
  [key: string]: unknown;
}

export type AcquireResult =
  | { ok: true; operation: OperationRow & { payload: OperationPayload } }
  | { ok: false; current: OperationRow };

export interface NewSecret {
  projectId: string;
  name: string;
  environment: "development" | "production" | "both";
  kind: "user" | "system";
  ciphertext: string;
  nonce: string;
  keyVersion: number;
}

export interface RunSummary {
  id: string;
  startedAt: Date | null;
  createdAt: Date;
  status: string;
  spentUsd: number;
  budgetUsd: number | null;
}

export interface Store {
  // ── projects ──
  insertProject(row: NewProjectRow): Promise<ProjectRow | null>;
  getProject(id: string, opts?: { includeDeleted?: boolean }): Promise<ProjectRow | null>;
  projectIdTaken(id: string): Promise<boolean>;
  listProjects(opts?: { includeDeleted?: boolean }): Promise<ProjectRow[]>;
  updateProject(id: string, patch: ProjectPatch): Promise<ProjectRow | null>;
  /** Compare-and-set on `serverStatus`: only updates when the current status is one of `from`. */
  updateProjectIfStatus(id: string, from: readonly string[], patch: ProjectPatch): Promise<ProjectRow | null>;

  // ── operations ──
  acquireOperation(projectId: string, kind: OperationKind, ttlMs: number, payload: OperationPayload): Promise<AcquireResult>;
  getOperation(projectId: string): Promise<OperationRow | null>;
  listOperations(): Promise<OperationRow[]>;
  /** Frees the slot only if it still holds `token`. Returns whether it did. */
  releaseOperation(projectId: string, token: string): Promise<boolean>;
  /** Pushes `expiresAt` forward while a long job is alive. */
  extendOperation(projectId: string, token: string, ttlMs: number): Promise<boolean>;

  // ── secrets ──
  listSecrets(projectId: string, kind?: "user" | "system"): Promise<SecretRow[]>;
  upsertSecret(secret: NewSecret): Promise<SecretRow>;
  deleteSecret(projectId: string, id: string, kind: "user" | "system"): Promise<boolean>;

  // ── uploads ──
  insertUpload(row: typeof uploads.$inferInsert): Promise<UploadRow>;
  getUpload(projectId: string, fileNameId: string): Promise<UploadRow | null>;

  // ── settings (instance-wide key/value, table `settings`) ──
  /** The stored JSON value, or null when the key is absent. */
  getSetting(key: string): Promise<unknown | null>;
  putSetting(key: string, value: unknown): Promise<void>;
  /** Returns whether a value was removed. */
  deleteSetting(key: string): Promise<boolean>;

  // ── runs (budget page) ──
  listRuns(projectId: string, since: Date): Promise<RunSummary[]>;
  monthSpentUsd(since: Date, projectId?: string): Promise<number>;

  // ── runs, tasks, events, messages, versions, ledger (phase 2, 05 §1) ──
  /** Null when the project already has a non-terminal run (partial unique index). */
  insertRun(row: NewRunRow): Promise<RunRow | null>;
  getRun(id: string): Promise<RunRow | null>;
  /** The newest run of a project (any status). */
  latestRun(projectId: string): Promise<RunRow | null>;
  updateRun(id: string, patch: RunPatch): Promise<RunRow | null>;
  /** Non-terminal runs of every project (boot recovery). */
  listActiveRuns(): Promise<RunRow[]>;
  /** Durations in minutes of the latest finished runs with this intent (estimates). */
  recentRunMinutes(intent: string, limit: number): Promise<number[]>;
  insertTask(row: NewTaskRow): Promise<TaskRow>;
  updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null>;
  listTasks(runId: string): Promise<TaskRow[]>;
  /** Append-only; returns the event's `seq`. */
  appendEvent(event: NewRunEvent): Promise<number>;
  listEvents(runId: string, afterSeq: number, limit: number): Promise<RunEventRow[]>;
  /** ⭐ `createdAt` is strictly increasing per project (the UI dedupes on it). */
  appendMessage(message: NewMessage): Promise<MessageRow>;
  /** Oldest first. With `runId`, only that run's messages. */
  listMessages(projectId: string, opts?: { runId?: string }): Promise<MessageRow[]>;
  insertVersion(row: NewVersionRow): Promise<VersionRow>;
  insertLlmCall(row: NewLlmCall): Promise<void>;
  insertMediaCall(row: NewMediaCall): Promise<void>;
}
