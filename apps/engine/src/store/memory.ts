/**
 * In-memory `Store` for unit tests (and `SANDBOX_DRIVER=process` experiments). Same
 * semantics as `PgStore` (see `types.ts`), including column defaults of the schema.
 */
import { uuidv7 } from "../ids.js";
import type {
  AcquireResult,
  NewProjectRow,
  NewSecret,
  OperationKind,
  OperationPayload,
  OperationRow,
  ProjectPatch,
  ProjectRow,
  RunSummary,
  SecretRow,
  Store,
  UploadRow,
} from "./types.js";
import type { uploads } from "../db/schema/index.js";

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  readonly projects = new Map<string, ProjectRow>();
  readonly operations = new Map<string, OperationRow>();
  readonly secrets = new Map<string, SecretRow>();
  readonly uploads = new Map<string, UploadRow>();
  runs: (RunSummary & { projectId: string })[] = [];

  async insertProject(row: NewProjectRow): Promise<ProjectRow | null> {
    if (this.projects.has(row.id)) return null;
    const now = new Date();
    const full: ProjectRow = {
      id: row.id,
      label: row.label,
      description: row.description ?? null,
      template: row.template ?? "nextjs-postgres",
      templateVersion: row.templateVersion ?? null,
      language: row.language ?? "en",
      serverStatus: row.serverStatus ?? "Creating",
      processStatus: row.processStatus ?? "idle",
      devUrl: row.devUrl ?? null,
      internalDevUrl: row.internalDevUrl ?? null,
      cachedUrl: row.cachedUrl ?? null,
      urlFieldToUse: row.urlFieldToUse ?? "temporalDevelopmentProjectUrl",
      productionHost: row.productionHost ?? null,
      previewImagePath: row.previewImagePath ?? null,
      archivedAt: row.archivedAt ?? null,
      lastActivityAt: row.lastActivityAt ?? null,
      deletedAt: row.deletedAt ?? null,
      purgeAfter: row.purgeAfter ?? null,
      serverError: row.serverError ?? null,
      rebuildStatus: row.rebuildStatus ?? "idle",
      rebuildStartedAt: row.rebuildStartedAt ?? null,
      rebuildError: row.rebuildError ?? null,
      rebuildNoop: row.rebuildNoop ?? false,
      rebuildSha: row.rebuildSha ?? null,
      rebuildEnvHash: row.rebuildEnvHash ?? null,
      versionRecovery: row.versionRecovery ?? null,
      createdAt: row.createdAt ?? now,
      updatedAt: row.updatedAt ?? now,
    };
    this.projects.set(full.id, full);
    return clone(full);
  }

  async getProject(id: string, opts: { includeDeleted?: boolean } = {}): Promise<ProjectRow | null> {
    const p = this.projects.get(id);
    if (!p || (!opts.includeDeleted && p.deletedAt)) return null;
    return clone(p);
  }

  async projectIdTaken(id: string): Promise<boolean> {
    return this.projects.has(id);
  }

  async listProjects(opts: { includeDeleted?: boolean } = {}): Promise<ProjectRow[]> {
    return [...this.projects.values()]
      .filter((p) => opts.includeDeleted || !p.deletedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async updateProject(id: string, patch: ProjectPatch): Promise<ProjectRow | null> {
    const p = this.projects.get(id);
    if (!p) return null;
    const next = { ...p, ...clone(patch), updatedAt: new Date() } as ProjectRow;
    this.projects.set(id, next);
    return clone(next);
  }

  async updateProjectIfStatus(id: string, from: readonly string[], patch: ProjectPatch): Promise<ProjectRow | null> {
    const p = this.projects.get(id);
    if (!p || !from.includes(p.serverStatus)) return null;
    return this.updateProject(id, patch);
  }

  async acquireOperation(projectId: string, kind: OperationKind, ttlMs: number, payload: OperationPayload): Promise<AcquireResult> {
    const now = new Date();
    const current = this.operations.get(projectId);
    if (current && current.expiresAt.getTime() >= now.getTime()) return { ok: false, current: clone(current) };
    const row: OperationRow = {
      projectId,
      kind,
      startedAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      payload,
      createdAt: now,
      updatedAt: now,
    };
    this.operations.set(projectId, row);
    return { ok: true, operation: clone(row) as OperationRow & { payload: OperationPayload } };
  }

  async getOperation(projectId: string): Promise<OperationRow | null> {
    const op = this.operations.get(projectId);
    return op ? clone(op) : null;
  }

  async listOperations(): Promise<OperationRow[]> {
    return [...this.operations.values()].map(clone);
  }

  async releaseOperation(projectId: string, token: string): Promise<boolean> {
    const op = this.operations.get(projectId);
    if (!op || (op.payload as OperationPayload).token !== token) return false;
    this.operations.delete(projectId);
    return true;
  }

  async extendOperation(projectId: string, token: string, ttlMs: number): Promise<boolean> {
    const op = this.operations.get(projectId);
    if (!op || (op.payload as OperationPayload).token !== token) return false;
    op.expiresAt = new Date(Date.now() + ttlMs);
    return true;
  }

  async listSecrets(projectId: string, kind?: "user" | "system"): Promise<SecretRow[]> {
    return [...this.secrets.values()]
      .filter((s) => s.projectId === projectId && (!kind || s.kind === kind))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async upsertSecret(s: NewSecret): Promise<SecretRow> {
    const existing = [...this.secrets.values()].find(
      (x) => x.projectId === s.projectId && x.name === s.name && x.environment === s.environment,
    );
    const now = new Date();
    const row: SecretRow = existing
      ? { ...existing, ciphertext: s.ciphertext, nonce: s.nonce, keyVersion: s.keyVersion, kind: s.kind, updatedAt: now }
      : { id: uuidv7(), ...s, createdAt: now, updatedAt: now };
    this.secrets.set(row.id, row);
    return clone(row);
  }

  async deleteSecret(projectId: string, id: string, kind: "user" | "system"): Promise<boolean> {
    const s = this.secrets.get(id);
    if (!s || s.projectId !== projectId || s.kind !== kind) return false;
    return this.secrets.delete(id);
  }

  async insertUpload(row: typeof uploads.$inferInsert): Promise<UploadRow> {
    const now = new Date();
    const full: UploadRow = { id: row.id ?? uuidv7(), ...row, createdAt: now, updatedAt: now } as UploadRow;
    this.uploads.set(`${full.projectId}/${full.fileNameId}`, full);
    return clone(full);
  }

  async getUpload(projectId: string, fileNameId: string): Promise<UploadRow | null> {
    const u = this.uploads.get(`${projectId}/${fileNameId}`);
    return u ? clone(u) : null;
  }

  async listRuns(projectId: string, since: Date): Promise<RunSummary[]> {
    return this.runs.filter((r) => r.projectId === projectId && r.createdAt >= since).map(({ projectId: _p, ...r }) => r);
  }

  async monthSpentUsd(since: Date, projectId?: string): Promise<number> {
    return this.runs.filter((r) => r.createdAt >= since && (!projectId || r.projectId === projectId)).reduce((a, r) => a + r.spentUsd, 0);
  }
}
