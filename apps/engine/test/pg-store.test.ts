/**
 * PgStore against a real Postgres (skipped unless FORJA_TEST_DATABASE_URL is set):
 *   docker run -d --rm --name forja-pgtest -e POSTGRES_PASSWORD=t -p 127.0.0.1:55432:5432 postgres:17-alpine
 *   FORJA_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres npx vitest run test/pg-store.test.ts
 * Runs the migrations, then checks the semantics MemoryStore mirrors.
 */
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { PgStore } from "../src/store/pg.js";

const url = process.env.FORJA_TEST_DATABASE_URL;

describe.skipIf(!url)("PgStore (real Postgres)", () => {
  let dbh: DbHandle;
  let store: PgStore;
  beforeAll(async () => {
    await runMigrations(url as string, pino({ level: "silent" }));
    dbh = createDb(url as string);
    await dbh.sql`truncate projects cascade`;
    store = new PgStore(dbh.db);
  });
  afterAll(async () => {
    await dbh?.close();
  });

  it("projects: insert refuses a taken id, soft delete hides, CAS on status", async () => {
    expect(await store.insertProject({ id: "pg-one", label: "pg-one" })).toMatchObject({ id: "pg-one", serverStatus: "Creating", rebuildStatus: "idle" });
    expect(await store.insertProject({ id: "pg-one", label: "x" })).toBeNull();
    expect(await store.updateProjectIfStatus("pg-one", ["Archived"], { serverStatus: "Unarchiving" })).toBeNull();
    expect((await store.updateProjectIfStatus("pg-one", ["Creating"], { serverStatus: "Active" }))?.serverStatus).toBe("Active");
    await store.updateProject("pg-one", { versionRecovery: { status: "recovering", versionId: "v1", startedAt: "t" } });
    expect((await store.getProject("pg-one"))?.versionRecovery).toEqual({ status: "recovering", versionId: "v1", startedAt: "t" });
    await store.updateProject("pg-one", { deletedAt: new Date() });
    expect(await store.getProject("pg-one")).toBeNull();
    expect(await store.projectIdTaken("pg-one")).toBe(true);
    expect((await store.listProjects()).map((p) => p.id)).not.toContain("pg-one");
  });

  it("operations: atomic slot, takeover after expiry, token-bound release", async () => {
    await store.insertProject({ id: "pg-ops", label: "pg-ops" });
    const a = await store.acquireOperation("pg-ops", "rebuild", 60_000, { token: "a" });
    expect(a.ok).toBe(true);
    const results = await Promise.all([1, 2, 3].map((i) => store.acquireOperation("pg-ops", "wake", 60_000, { token: `x${i}` })));
    expect(results.every((r) => !r.ok)).toBe(true);
    expect(await store.releaseOperation("pg-ops", "nope")).toBe(false);
    expect(await store.extendOperation("pg-ops", "a", 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const b = await store.acquireOperation("pg-ops", "wake", 60_000, { token: "b" });
    expect(b.ok).toBe(true);
    expect(await store.releaseOperation("pg-ops", "a")).toBe(false);
    expect(await store.releaseOperation("pg-ops", "b")).toBe(true);
    expect(await store.getOperation("pg-ops")).toBeNull();
  });

  it("secrets upsert by (project, name, environment); uploads; runs sums", async () => {
    await store.insertProject({ id: "pg-sec", label: "pg-sec" });
    const s1 = await store.upsertSecret({ projectId: "pg-sec", name: "K", environment: "both", kind: "user", ciphertext: "c1", nonce: "n1", keyVersion: 1 });
    const s2 = await store.upsertSecret({ projectId: "pg-sec", name: "K", environment: "both", kind: "user", ciphertext: "c2", nonce: "n2", keyVersion: 1 });
    expect(s2.id).toBe(s1.id);
    expect((await store.listSecrets("pg-sec", "user"))[0]?.ciphertext).toBe("c2");
    expect(await store.deleteSecret("pg-sec", s1.id, "system")).toBe(false);
    expect(await store.deleteSecret("pg-sec", s1.id, "user")).toBe(true);
    await store.insertUpload({ projectId: "pg-sec", fileNameId: "f.png", originalName: "a.png", mime: "image/png", size: 3, path: "p", sha256: "h" });
    expect((await store.getUpload("pg-sec", "f.png"))?.mime).toBe("image/png");
    expect(await store.monthSpentUsd(new Date(0), "pg-sec")).toBe(0);
    expect(await store.listRuns("pg-sec", new Date(0))).toEqual([]);
  });

  it("settings: upsert, read JSON back, delete", async () => {
    await store.deleteSetting("test.key");
    expect(await store.getSetting("test.key")).toBeNull();
    await store.putSetting("test.key", "web-search");
    await store.putSetting("test.key", { mode: "generate" });
    expect(await store.getSetting("test.key")).toEqual({ mode: "generate" });
    expect(await store.deleteSetting("test.key")).toBe(true);
    expect(await store.deleteSetting("test.key")).toBe(false);
  });

  it("runs: one active per project, latest, events, ledger, versions, stale queries", async () => {
    await store.insertProject({ id: "pg-run", label: "pg-run" });
    const r1 = await store.insertRun({ projectId: "pg-run", prompt: "a", status: "received", startedAt: new Date(), budgetUsd: "8.0000" });
    expect(r1).toMatchObject({ status: "received", spentUsd: "0.0000" });
    expect(await store.insertRun({ projectId: "pg-run", prompt: "b" })).toBeNull();
    expect((await store.listActiveRuns()).map((r) => r.id)).toContain(r1!.id);
    await store.updateRun(r1!.id, { status: "done", intent: "tweak", finishedAt: new Date(Date.now() + 120_000), spentUsd: "0.2500" });
    const r2 = await store.insertRun({ projectId: "pg-run", prompt: "c" });
    expect(r2).not.toBeNull();
    expect((await store.latestRun("pg-run"))?.id).toBe(r2!.id);
    expect((await store.recentRunMinutes("tweak", 5))[0]).toBeGreaterThan(1.9);
    expect(await store.monthSpentUsd(new Date(0), "pg-run")).toBeCloseTo(0.25);
    const task = await store.insertTask({ runId: r2!.id, planTaskId: "t1", role: "frontend", scope: { write: ["src/**"] } });
    await store.updateTask(task.id, { status: "done", turns: 3, report: { status: "done" } });
    expect((await store.listTasks(r2!.id))[0]).toMatchObject({ status: "done", turns: 3 });
    const s1 = await store.appendEvent({ runId: r2!.id, taskId: task.id, type: "task.started", payload: { taskId: "t1" } });
    const s2 = await store.appendEvent({ runId: r2!.id, type: "run.phase", payload: { from: "received", to: "directing" } });
    expect(s2).toBeGreaterThan(s1);
    expect((await store.listEvents(r2!.id, s1, 10)).map((e) => e.type)).toEqual(["run.phase"]);
    await store.insertLlmCall({ projectId: "pg-run", runId: r2!.id, taskId: task.id, role: "frontend", provider: "nvidia", model: "z-ai/glm-5.3", inputTokens: 10, outputTokens: 5, costUsd: "0.000000", outcome: "ok" });
    await store.insertMediaCall({ projectId: "pg-run", runId: r2!.id, provider: "openverse", kind: "search", outcome: "ok" });
    const v = await store.insertVersion({ id: "a".repeat(40), projectId: "pg-run", runId: r2!.id, tag: "v2", commitSha: "a".repeat(40), message: "m", checks: { gates: [] } });
    expect(v.id).toBe("a".repeat(40));
  });

  it("messages: created_at strictly increasing per project under concurrency; version link", async () => {
    await store.insertProject({ id: "pg-msg", label: "pg-msg" });
    const writes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.appendMessage({ projectId: "pg-msg", author: i === 0 ? "user" : "agent", type: i === 0 ? "regular" : "building", text: `m${i}` })),
    );
    const times = writes.map((m) => m.createdAt.getTime()).sort((a, b) => a - b);
    expect(new Set(times).size).toBe(20);
    const listed = await store.listMessages("pg-msg");
    expect(listed.map((m) => m.createdAt.getTime())).toEqual(times);
    await store.insertVersion({ id: "b".repeat(40), projectId: "pg-msg", tag: "v1", commitSha: "b".repeat(40), message: "m" });
    const withVersion = await store.appendMessage({ projectId: "pg-msg", author: "agent", type: "finished", text: "done", versionId: "b".repeat(40), secretKeysNeeded: { STRIPE_KEY: { isProvided: false, description: "d" } } });
    expect(withVersion).toMatchObject({ versionId: "b".repeat(40), secretKeysNeeded: { STRIPE_KEY: { isProvided: false, description: "d" } } });
  });
});
