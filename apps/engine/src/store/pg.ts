/**
 * `Store` over the engine's Postgres (Drizzle). See `types.ts` for the semantics.
 *
 * ⭐ `acquireOperation` is one statement: `INSERT … ON CONFLICT (project_id) DO UPDATE …
 * WHERE operations.expires_at < now`, so two concurrent requests can never both hold a slot,
 * and a slot abandoned by a crash frees itself when its TTL passes.
 */
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { operations, projects, runs, secrets, uploads } from "../db/schema/index.js";
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

const num = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

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
}
