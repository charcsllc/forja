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
import type { operations, projects, secrets, uploads } from "../db/schema/index.js";

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type ProjectPatch = Partial<Omit<ProjectRow, "id" | "createdAt">>;

export type OperationRow = typeof operations.$inferSelect;
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

  // ── runs (read-only in phase 1: the ledger arrives with phase 2) ──
  listRuns(projectId: string, since: Date): Promise<RunSummary[]>;
  monthSpentUsd(since: Date, projectId?: string): Promise<number>;
}
