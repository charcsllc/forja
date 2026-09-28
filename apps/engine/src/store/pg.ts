/**
 * `Store` over the engine's Postgres (Drizzle). See `types.ts` for the semantics.
 *
 * ⭐ `acquireOperation` is one statement: `INSERT … ON CONFLICT (project_id) DO UPDATE …
 * WHERE operations.expires_at < now`, so two concurrent requests can never both hold a slot,
 * and a slot abandoned by a crash frees itself when its TTL passes.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { llmCalls, mediaCalls, messages, operations, projects, runEvents, runs, secrets, settings, tasks, uploads, versions } from "../db/schema/index.js";
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

const num = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));
const TERMINAL_STATUSES = ["done", "failed", "limit-reached", "cancelled"];

/** Postgres unique violation, unwrapped from drizzle's query error when needed. */
function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const x = e as { code?: string; constraint_name?: string; constraint?: string };
    if (x.code === "23505") return !constraint || x.constraint_name === constraint || x.constraint === constraint;
  }
  return false;
}

export class PgStore implements Store {
  constructor(private readonly db: Db) {}

  async insertProject(row: NewProjectRow): Promise<ProjectRow | null> {
    const out = await this.db.insert(projects).values(row).onConflictDoNothing({ target: projects.id }).returning();
    return out[0] ?? null;
  }

  async getProject(id: string, opts: { includeDeleted?: boolean } = {}): Promise<ProjectRow | null> {
    const where = opts.includeDeleted ? eq(projects.id, id) : and(eq(projects.id, id), isNull(projects.deletedAt));
    const out = await this.db.select().from(projects).where(where).limit(1);
    return out[0] ?? null;
  }

  async projectIdTaken(id: string): Promise<boolean> {
    const out = await this.db.select({ id: projects.id }).from(projects).where(eq(projects.id, id)).limit(1);
    return out.length > 0;
  }

  async listProjects(opts: { includeDeleted?: boolean } = {}): Promise<ProjectRow[]> {
    const q = this.db.select().from(projects);
    return (opts.includeDeleted ? q : q.where(isNull(projects.deletedAt))).orderBy(asc(projects.createdAt));
  }

  async updateProject(id: string, patch: ProjectPatch): Promise<ProjectRow | null> {
    const out = await this.db.update(projects).set({ ...patch, updatedAt: new Date() }).where(eq(projects.id, id)).returning();
    return out[0] ?? null;
  }

  async updateProjectIfStatus(id: string, from: readonly string[], patch: ProjectPatch): Promise<ProjectRow | null> {
    const out = await this.db
      .update(projects)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(projects.id, id), inArray(projects.serverStatus, [...from])))
      .returning();
    return out[0] ?? null;
  }

  async acquireOperation(projectId: string, kind: OperationKind, ttlMs: number, payload: OperationPayload): Promise<AcquireResult> {
    const now = new Date();
    const values = { projectId, kind, startedAt: now, expiresAt: new Date(now.getTime() + ttlMs), payload, updatedAt: now };
    const out = await this.db
      .insert(operations)
      .values(values)
      .onConflictDoUpdate({
        target: operations.projectId,
        set: { kind, startedAt: now, expiresAt: values.expiresAt, payload, updatedAt: now },
        setWhere: sql`${operations.expiresAt} < ${now.toISOString()}::timestamptz`,
      })
      .returning();
    const row = out[0];
    if (row) return { ok: true, operation: row as OperationRow & { payload: OperationPayload } };
    const current = await this.getOperation(projectId);
    if (!current) return this.acquireOperation(projectId, kind, ttlMs, payload); // freed meanwhile
    return { ok: false, current };
  }

  async getOperation(projectId: string): Promise<OperationRow | null> {
    const out = await this.db.select().from(operations).where(eq(operations.projectId, projectId)).limit(1);
    return out[0] ?? null;
  }

  listOperations(): Promise<OperationRow[]> {
    return this.db.select().from(operations);
  }

  async releaseOperation(projectId: string, token: string): Promise<boolean> {
    const out = await this.db
      .delete(operations)
      .where(and(eq(operations.projectId, projectId), sql`${operations.payload}->>'token' = ${token}`))
      .returning({ projectId: operations.projectId });
    return out.length > 0;
  }

  async extendOperation(projectId: string, token: string, ttlMs: number): Promise<boolean> {
    const out = await this.db
      .update(operations)
      .set({ expiresAt: new Date(Date.now() + ttlMs), updatedAt: new Date() })
      .where(and(eq(operations.projectId, projectId), sql`${operations.payload}->>'token' = ${token}`))
      .returning({ projectId: operations.projectId });
    return out.length > 0;
  }

  listSecrets(projectId: string, kind?: "user" | "system"): Promise<SecretRow[]> {
    const where = kind ? and(eq(secrets.projectId, projectId), eq(secrets.kind, kind)) : eq(secrets.projectId, projectId);
    return this.db.select().from(secrets).where(where).orderBy(asc(secrets.createdAt));
  }

  async upsertSecret(s: NewSecret): Promise<SecretRow> {
    const out = await this.db
      .insert(secrets)
      .values(s)
      .onConflictDoUpdate({
        target: [secrets.projectId, secrets.name, secrets.environment],
        set: { ciphertext: s.ciphertext, nonce: s.nonce, keyVersion: s.keyVersion, kind: s.kind, updatedAt: new Date() },
      })
      .returning();
    return out[0] as SecretRow;
  }

  async deleteSecret(projectId: string, id: string, kind: "user" | "system"): Promise<boolean> {
    const out = await this.db
      .delete(secrets)
      .where(and(eq(secrets.projectId, projectId), eq(secrets.id, id), eq(secrets.kind, kind)))
      .returning({ id: secrets.id });
    return out.length > 0;
  }

  async insertUpload(row: typeof uploads.$inferInsert): Promise<UploadRow> {
    const out = await this.db.insert(uploads).values(row).returning();
    return out[0] as UploadRow;
  }

  async getUpload(projectId: string, fileNameId: string): Promise<UploadRow | null> {
    const out = await this.db
      .select()
      .from(uploads)
      .where(and(eq(uploads.projectId, projectId), eq(uploads.fileNameId, fileNameId)))
      .limit(1);
    return out[0] ?? null;
  }

  async getSetting(key: string): Promise<unknown | null> {
    const out = await this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    return out[0]?.value ?? null;
  }

  async putSetting(key: string, value: unknown): Promise<void> {
    const now = new Date();
    await this.db
      .insert(settings)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
  }

  async deleteSetting(key: string): Promise<boolean> {
    const out = await this.db.delete(settings).where(eq(settings.key, key)).returning({ key: settings.key });
    return out.length > 0;
  }

  async listRuns(projectId: string, since: Date): Promise<RunSummary[]> {
    const rows = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.projectId, projectId), gte(runs.createdAt, since)))
      .orderBy(asc(runs.createdAt));
    return rows.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      createdAt: r.createdAt,
      status: r.status,
      spentUsd: num(r.spentUsd),
      budgetUsd: r.budgetUsd === null ? null : num(r.budgetUsd),
    }));
  }

  async monthSpentUsd(since: Date, projectId?: string): Promise<number> {
    const where = projectId ? and(gte(runs.createdAt, since), eq(runs.projectId, projectId)) : gte(runs.createdAt, since);
    const out = await this.db.select({ total: sql<string | null>`sum(${runs.spentUsd})` }).from(runs).where(where);
    return num(out[0]?.total ?? null);
  }

  // ── runs, tasks, events, messages, versions, ledger ──

  async insertRun(row: NewRunRow): Promise<RunRow | null> {
    try {
      const out = await this.db.insert(runs).values(row).returning();
      return out[0] ?? null;
    } catch (err) {
      if (isUniqueViolation(err, "runs_one_active_per_project")) return null;
      throw err;
    }
  }

  async getRun(id: string): Promise<RunRow | null> {
    const out = await this.db.select().from(runs).where(eq(runs.id, id)).limit(1);
    return out[0] ?? null;
  }

  async latestRun(projectId: string): Promise<RunRow | null> {
    const out = await this.db.select().from(runs).where(eq(runs.projectId, projectId)).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1);
    return out[0] ?? null;
  }

  async updateRun(id: string, patch: RunPatch): Promise<RunRow | null> {
    const out = await this.db.update(runs).set({ ...patch, updatedAt: new Date() }).where(eq(runs.id, id)).returning();
    return out[0] ?? null;
  }

  listActiveRuns(): Promise<RunRow[]> {
    return this.db.select().from(runs).where(notInArray(runs.status, TERMINAL_STATUSES));
  }

  async recentRunMinutes(intent: string, limit: number): Promise<number[]> {
    const rows = await this.db
      .select({ startedAt: runs.startedAt, finishedAt: runs.finishedAt })
      .from(runs)
      .where(and(eq(runs.intent, intent), eq(runs.status, "done"), isNotNull(runs.startedAt), isNotNull(runs.finishedAt)))
      .orderBy(desc(runs.finishedAt))
      .limit(limit);
    return rows.map((r) => ((r.finishedAt?.getTime() ?? 0) - (r.startedAt?.getTime() ?? 0)) / 60_000);
  }

  async insertTask(row: NewTaskRow): Promise<TaskRow> {
    const out = await this.db.insert(tasks).values(row).returning();
    return out[0] as TaskRow;
  }

  async updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
    const out = await this.db.update(tasks).set({ ...patch, updatedAt: new Date() }).where(eq(tasks.id, id)).returning();
    return out[0] ?? null;
  }

  listTasks(runId: string): Promise<TaskRow[]> {
    return this.db.select().from(tasks).where(eq(tasks.runId, runId)).orderBy(asc(tasks.createdAt));
  }

  async appendEvent(event: NewRunEvent): Promise<number> {
    const out = await this.db
      .insert(runEvents)
      .values({ runId: event.runId, taskId: event.taskId ?? null, type: event.type, payload: event.payload, blobPath: event.blobPath ?? null })
      .returning({ seq: runEvents.seq });
    return out[0]?.seq ?? 0;
  }

  listEvents(runId: string, afterSeq: number, limit: number): Promise<RunEventRow[]> {
    return this.db.select().from(runEvents).where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq))).orderBy(asc(runEvents.seq)).limit(limit);
  }

  /**
   * ⭐ One transaction under a per-project advisory lock: read the newest `created_at`,
   * take max(now, newest + 1 ms), insert. Concurrent writers of one project serialize, so
   * the unique index (the backstop) never fires and the UI's dedupe key never collides.
   */
  async appendMessage(m: NewMessage): Promise<MessageRow> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`forja:messages:${m.projectId}`}))`);
      const last = await tx
        .select({ at: messages.createdAt })
        .from(messages)
        .where(eq(messages.projectId, m.projectId))
        .orderBy(desc(messages.createdAt))
        .limit(1);
      const lastMs = last[0]?.at.getTime() ?? 0;
      const createdAt = new Date(Math.max(Date.now(), lastMs + 1));
      const out = await tx
        .insert(messages)
        .values({
          projectId: m.projectId,
          runId: m.runId ?? null,
          author: m.author,
          type: m.type,
          text: m.text,
          versionId: m.versionId ?? null,
          secretKeysNeeded: m.secretKeysNeeded ?? [],
          files: m.files ?? [],
          createdAt,
        })
        .returning();
      return out[0] as MessageRow;
    });
  }

  listMessages(projectId: string, opts: { runId?: string } = {}): Promise<MessageRow[]> {
    const where = opts.runId ? and(eq(messages.projectId, projectId), eq(messages.runId, opts.runId)) : eq(messages.projectId, projectId);
    return this.db.select().from(messages).where(where).orderBy(asc(messages.createdAt));
  }

  async insertVersion(row: NewVersionRow): Promise<VersionRow> {
    const out = await this.db.insert(versions).values(row).returning();
    return out[0] as VersionRow;
  }

  async insertLlmCall(row: NewLlmCall): Promise<void> {
    await this.db.insert(llmCalls).values(row);
  }

  async insertMediaCall(row: NewMediaCall): Promise<void> {
    await this.db.insert(mediaCalls).values(row);
  }
}
