/**
 * In-memory `Store` for unit tests (and `SANDBOX_DRIVER=process` experiments). Same
 * semantics as `PgStore` (see `types.ts`), including column defaults of the schema.
 */
import { uuidv7 } from "../ids.js";
import type {
  AcquireResult,
  MessageRow,
  NewLlmCall,
  NewMediaCall,
  NewMessage,
  NewRunEvent,
  NewRunRow,
  NewTaskRow,
  NewVersionRow,
  RunEventRow,
  RunPatch,
  RunRow,
  TaskPatch,
  TaskRow,
  VersionRow,
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
const TERMINAL: ReadonlySet<string> = new Set(["done", "failed", "limit-reached", "cancelled"]);

export class MemoryStore implements Store {
  readonly projects = new Map<string, ProjectRow>();
  readonly operations = new Map<string, OperationRow>();
  readonly secrets = new Map<string, SecretRow>();
  readonly uploads = new Map<string, UploadRow>();
  readonly runRows = new Map<string, RunRow>();
  readonly taskRows = new Map<string, TaskRow>();
  readonly events: RunEventRow[] = [];
  readonly messageRows: MessageRow[] = [];
  readonly versionRows: VersionRow[] = [];
  readonly llmCalls: NewLlmCall[] = [];
  readonly mediaCalls: NewMediaCall[] = [];
  readonly settings = new Map<string, unknown>();

  async getSetting(key: string): Promise<unknown | null> {
    return this.settings.has(key) ? clone(this.settings.get(key)) : null;
  }

  async putSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, clone(value));
  }

  async deleteSetting(key: string): Promise<boolean> {
    return this.settings.delete(key);
  }

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
    return [...this.runRows.values()]
      .filter((r) => r.projectId === projectId && r.createdAt >= since)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        createdAt: r.createdAt,
        status: r.status,
        spentUsd: Number(r.spentUsd),
        budgetUsd: r.budgetUsd === null ? null : Number(r.budgetUsd),
      }));
  }

  async monthSpentUsd(since: Date, projectId?: string): Promise<number> {
    return [...this.runRows.values()]
      .filter((r) => r.createdAt >= since && (!projectId || r.projectId === projectId))
      .reduce((a, r) => a + Number(r.spentUsd), 0);
  }

  // ── runs, tasks, events, messages, versions, ledger ──

  async insertRun(row: NewRunRow): Promise<RunRow | null> {
    const active = [...this.runRows.values()].some((r) => r.projectId === row.projectId && !TERMINAL.has(r.status));
    if (active && !TERMINAL.has(row.status ?? "received")) return null;
    const now = new Date();
    const full: RunRow = {
      id: row.id ?? uuidv7(),
      projectId: row.projectId,
      status: row.status ?? "received",
      intent: row.intent ?? null,
      prompt: row.prompt,
      inputFiles: row.inputFiles ?? [],
      options: row.options ?? {},
      plan: row.plan ?? null,
      budgetUsd: row.budgetUsd ?? null,
      spentUsd: row.spentUsd ?? "0",
      startedAt: row.startedAt ?? null,
      finishedAt: row.finishedAt ?? null,
      heartbeatAt: row.heartbeatAt ?? null,
      expectedMinutes: row.expectedMinutes ?? null,
      error: row.error ?? null,
      cancelRequestedAt: row.cancelRequestedAt ?? null,
      createdAt: row.createdAt ?? now,
      updatedAt: now,
    };
    this.runRows.set(full.id, full);
    return clone(full);
  }

  async getRun(id: string): Promise<RunRow | null> {
    const r = this.runRows.get(id);
    return r ? clone(r) : null;
  }

  async latestRun(projectId: string): Promise<RunRow | null> {
    const rows = [...this.runRows.values()].filter((r) => r.projectId === projectId);
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id > a.id ? 1 : -1));
    return rows[0] ? clone(rows[0]) : null;
  }

  async updateRun(id: string, patch: RunPatch): Promise<RunRow | null> {
    const r = this.runRows.get(id);
    if (!r) return null;
    const next = { ...r, ...clone(patch), updatedAt: new Date() } as RunRow;
    this.runRows.set(id, next);
    return clone(next);
  }

  async listActiveRuns(): Promise<RunRow[]> {
    return [...this.runRows.values()].filter((r) => !TERMINAL.has(r.status)).map(clone);
  }

  async recentRunMinutes(intent: string, limit: number): Promise<number[]> {
    return [...this.runRows.values()]
      .filter((r) => r.intent === intent && r.status === "done" && r.startedAt && r.finishedAt)
      .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))
      .slice(0, limit)
      .map((r) => ((r.finishedAt?.getTime() ?? 0) - (r.startedAt?.getTime() ?? 0)) / 60_000);
  }

  async insertTask(row: NewTaskRow): Promise<TaskRow> {
    const now = new Date();
    const full: TaskRow = {
      id: row.id ?? uuidv7(),
      runId: row.runId,
      planTaskId: row.planTaskId,
      role: row.role,
      status: row.status ?? "pending",
      scope: row.scope ?? {},
      attempt: row.attempt ?? 0,
      turns: row.turns ?? 0,
      spentUsd: row.spentUsd ?? "0",
      leaseUntil: row.leaseUntil ?? null,
      checkpoint: row.checkpoint ?? null,
      report: row.report ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.taskRows.set(full.id, full);
    return clone(full);
  }

  async updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
    const t = this.taskRows.get(id);
    if (!t) return null;
    const next = { ...t, ...clone(patch), updatedAt: new Date() } as TaskRow;
    this.taskRows.set(id, next);
    return clone(next);
  }

  async listTasks(runId: string): Promise<TaskRow[]> {
    return [...this.taskRows.values()].filter((t) => t.runId === runId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(clone);
  }

  async appendEvent(event: NewRunEvent): Promise<number> {
    const now = new Date();
    const seq = this.events.length + 1;
    this.events.push({
      seq,
      runId: event.runId,
      taskId: event.taskId ?? null,
      ts: now,
      type: event.type,
      payload: clone(event.payload),
      blobPath: event.blobPath ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return seq;
  }

  async listEvents(runId: string, afterSeq: number, limit: number): Promise<RunEventRow[]> {
    return this.events.filter((e) => e.runId === runId && e.seq > afterSeq).slice(0, limit).map(clone);
  }

  async appendMessage(m: NewMessage): Promise<MessageRow> {
    const last = this.messageRows.filter((x) => x.projectId === m.projectId).reduce((a, x) => Math.max(a, x.createdAt.getTime()), 0);
    const createdAt = new Date(Math.max(Date.now(), last + 1));
    const row: MessageRow = {
      id: uuidv7(),
      projectId: m.projectId,
      runId: m.runId ?? null,
      author: m.author,
      type: m.type,
      text: m.text,
      versionId: m.versionId ?? null,
      secretKeysNeeded: m.secretKeysNeeded ?? [],
      files: m.files ?? [],
      createdAt,
      updatedAt: createdAt,
    };
    this.messageRows.push(row);
    return clone(row);
  }

  async listMessages(projectId: string, opts: { runId?: string } = {}): Promise<MessageRow[]> {
    return this.messageRows
      .filter((m) => m.projectId === projectId && (!opts.runId || m.runId === opts.runId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async insertVersion(row: NewVersionRow): Promise<VersionRow> {
    const now = new Date();
    const full: VersionRow = {
      id: row.id ?? uuidv7(),
      projectId: row.projectId,
      runId: row.runId ?? null,
      tag: row.tag,
      commitSha: row.commitSha,
      parentSha: row.parentSha ?? null,
      message: row.message,
      prompt: row.prompt ?? null,
      recoveredFromId: row.recoveredFromId ?? null,
      checks: row.checks ?? {},
      dbDumpPath: row.dbDumpPath ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.versionRows.push(full);
    return clone(full);
  }

  async insertLlmCall(row: NewLlmCall): Promise<void> {
    this.llmCalls.push(clone(row));
  }

  async insertMediaCall(row: NewMediaCall): Promise<void> {
    this.mediaCalls.push(clone(row));
  }
}
