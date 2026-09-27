import { describe, expect, it } from "vitest";
import { activeProject, makeTestEngine } from "./fakes.js";
import { resumeOperations } from "../src/boot.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("provisioning failures", () => {
  it("keeps the transitional status with an error message when the app never answers", async () => {
    const e = makeTestEngine({ repo: "fake" });
    e.sandbox.ready = false;
    await e.json("POST", "/v1/projects", { projectId: "broken-app", description: "" });
    await e.queue.drain();
    const p = (await e.json("GET", "/v1/projects/broken-app")).body.data;
    expect(p.agentServerStatus).toBe("Starting");
    expect(p.serverErrorMessage).toMatch(/did not answer/);
    expect(await e.store.getOperation("broken-app")).toBeNull();
    // The next sandbox request retries instead of waiting forever.
    e.sandbox.ready = true;
    const logs = await e.json("GET", "/v1/projects/broken-app/backend/dev/logs");
    expect(logs.status).toBe(409);
    expect(logs.body.errors.errorCode).toBe("SERVER_NOT_READY");
    expect(e.queue.sent.at(-1)?.name).toBe("sandbox.restart");
    await e.queue.drain();
    expect((await e.json("GET", "/v1/projects/broken-app")).body.data.agentServerStatus).toBe("Active");
  });

  it("stays Creating with the error when Docker refuses", async () => {
    const e = makeTestEngine({ repo: "fake" });
    e.sandbox.provisionError = new Error("Image forja-runner:1.0.0 is not available locally.");
    await e.json("POST", "/v1/projects", { projectId: "no-image", description: "" });
    await e.queue.drain();
    const p = (await e.json("GET", "/v1/projects/no-image")).body.data;
    expect(p.agentServerStatus).toBe("Creating");
    expect(p.serverErrorMessage).toContain("not available");
  });
});

describe("restart (agent/server/start-or-restart)", () => {
  it("leaves Active before answering, then comes back Active", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "restarter");
    const res = await e.json("POST", `/v1/projects/${id}/agent/server/start-or-restart`, {});
    expect(res.status).toBe(200);
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Starting");
    await e.queue.drain();
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Active");
    expect(e.sandbox.calls).toContain(`restart:${id}`);
  });

  it("wakes an archived project (Unarchiving, then Active)", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "archived-one");
    await e.call("POST", `/v2/projects/${id}/archive`);
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Archiving");
    await e.queue.drain();
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Archived");
    expect(e.sandbox.attached.size).toBe(0); // detached before the network went away
    await e.json("POST", `/v1/projects/${id}/agent/server/start-or-restart`, {});
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Unarchiving");
    await e.queue.drain();
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Active");
    expect(e.sandbox.calls).toContain(`unarchive:${id}`);
    expect(e.sandbox.attached.has(`forja-int-${id}>forja-engine-test`)).toBe(true);
  });

  it("re-creates the containers when they are gone", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "vanished");
    e.sandbox.projects.delete(id);
    await e.json("POST", `/v1/projects/${id}/agent/server/start-or-restart`, {});
    await e.queue.drain();
    expect(e.sandbox.calls.filter((c) => c === `provision:${id}`)).toHaveLength(2);
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Active");
  });
});

describe("wake semantics (05 §2.2)", () => {
  it("sandbox endpoints wake + 409; git-only endpoints answer asleep", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "napping");
    await e.call("POST", `/v2/projects/${id}/archive`);
    await e.queue.drain();
    for (const path of ["files/tree", "versions", "source-code", "rebuild/status", "deployments/status", "github/status"]) {
      const r = await e.json("GET", `/v1/projects/${id}/${path}`);
      expect(r.status, path).toBe(200);
    }
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Archived");
    const logs = await e.json("GET", `/v1/projects/${id}/backend/dev/logs`);
    expect(logs.status).toBe(409);
    expect(logs.body.errors.errorCode).toBe("SERVER_NOT_READY");
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Unarchiving");
    // A second refused call does not queue a second wake.
    await e.json("GET", `/v1/projects/${id}/database/tables-structure`);
    expect(e.queue.sent.filter((j) => j.name === "sandbox.wake")).toHaveLength(1);
    await e.queue.drain();
    expect((await e.json("GET", `/v1/projects/${id}/backend/dev/logs`)).body.data.logs).toContain("forja-app-napping");
    expect((await e.json("GET", `/v1/projects/${id}/database/tables-structure`)).body.data.tables).toHaveLength(1);
  });
});

describe("rebuild", () => {
  it("no-op rebuild: `rebuilding` on the first read, `success` on the next", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "noop-rb");
    const res = await e.json("POST", `/v1/projects/${id}/rebuild`, {});
    expect(res.body.data).toMatchObject({ status: "rebuilding", startedAt: expect.any(String) });
    expect(e.queue.sent.filter((j) => j.name === "sandbox.rebuild")).toHaveLength(0);
    expect((await e.json("GET", `/v1/projects/${id}/rebuild/status`)).body.data).toEqual({ status: "rebuilding" });
    expect((await e.json("GET", `/v1/projects/${id}/rebuild/status`)).body.data).toEqual({ status: "success" });
    expect(await e.store.getOperation(id)).toBeNull();
  });

  it("config change: restarts, migrates, success; lockfile change runs npm ci", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "real-rb");
    await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "package-lock.json", content: b64('{"v":2}'), encoding: "base64" });
    await e.json("POST", `/v1/projects/${id}/rebuild`, {});
    expect((await e.json("GET", `/v1/projects/${id}/rebuild/status`)).body.data.status).toBe("rebuilding");
    const second = await e.json("POST", `/v1/projects/${id}/rebuild`, {});
    expect(second.status).toBe(409);
    expect(second.body.errors.errorCode).toBe("OPERATION_IN_PROGRESS");
    await e.queue.drain();
    expect((await e.json("GET", `/v1/projects/${id}/rebuild/status`)).body.data).toEqual({ status: "success" });
    expect(e.sandbox.calls).toContain(`exec:forja-app-${id}:npm ci --prefer-offline`);
    expect(e.sandbox.calls).toContain(`restart:${id}`);
    // Nothing changed since: the next one is a no-op.
    await e.json("POST", `/v1/projects/${id}/rebuild`, {});
    expect(e.queue.sent.filter((j) => j.name === "sandbox.rebuild")).toHaveLength(1);
  });

  it("a secret change re-creates the app container with the new env", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "env-rb");
    await e.json("POST", `/v1/projects/${id}/secrets`, { secretName: "API_TOKEN", secretValue: "abc", environment: "development" });
    await e.json("POST", `/v1/projects/${id}/rebuild`, {});
    await e.queue.drain();
    expect(e.sandbox.projects.get(id)?.env.API_TOKEN).toBe("abc");
    expect((await e.json("GET", `/v1/projects/${id}/rebuild/status`)).body.data.status).toBe("success");
  });

  it("reports npm ci failures as rebuild errors with a message", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "bad-rb");
    await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "package-lock.json", content: b64('{"v":3}'), encoding: "base64" });
    e.sandbox.execExit["npm ci"] = 1;
    await e.json("POST", `/v1/projects/${id}/rebuild`, {});
    await e.queue.drain();
    const st = (await e.json("GET", `/v1/projects/${id}/rebuild/status`)).body.data;
    expect(st.status).toBe("error");
    expect(st.errorMessage).toMatch(/npm ci failed/);
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Active");
  });
});

describe("restore (versions/:id/recover)", () => {
  it("sets versionRecovery before answering, dumps the DB, restores, clears it", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "restorer");
    const v1 = (await e.json("GET", `/v1/projects/${id}/versions`)).body.data.versions[0]._id;
    await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "src/app/page.tsx", content: b64("changed"), encoding: "base64" });
    const res = await e.json("POST", `/v1/projects/${id}/versions/${v1}/recover`, {});
    expect(res.status).toBe(200);
    const during = (await e.json("GET", `/v1/projects/${id}`)).body.data.versionRecovery;
    expect(during).toMatchObject({ status: "recovering", versionId: v1, startedAt: expect.any(String) });
    await e.queue.drain();
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.versionRecovery).toBeNull();
    expect(e.sandbox.calls).toContain(`exec:forja-db-${id}:pg_dump`);
    const content = (await e.json("GET", `/v1/projects/${id}/files/content?path=src/app/page.tsx`)).body.data.content;
    expect(content).toBe("export default 1\n");
  });

  it("unknown version → VERSION_NOT_FOUND without touching state", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "restorer-2");
    const res = await e.json("POST", `/v1/projects/${id}/versions/nope/recover`, {});
    expect(res.status).toBe(404);
    expect(res.body.errors.errorCode).toBe("VERSION_NOT_FOUND");
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.versionRecovery).toBeNull();
  });

  it("DELETE versions/recovery clears an error marker, refuses while running", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "restorer-3");
    const v1 = (await e.json("GET", `/v1/projects/${id}/versions`)).body.data.versions[0]._id;
    await e.json("POST", `/v1/projects/${id}/versions/${v1}/recover`, {});
    expect((await e.json("DELETE", `/v1/projects/${id}/versions/recovery`)).status).toBe(409);
    await e.store.updateProject(id, { versionRecovery: { status: "error", versionId: v1, startedAt: "x", errorMessage: "boom" } });
    await e.queue.drain(); // the stale job still runs; clears the marker when done
    await e.store.updateProject(id, { versionRecovery: { status: "error", versionId: v1, startedAt: "x", errorMessage: "boom" } });
    expect((await e.json("DELETE", `/v1/projects/${id}/versions/recovery`)).body.data).toEqual({ cleared: true });
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.versionRecovery).toBeNull();
  });
});

describe("boot: resumeOperations", () => {
  it("re-queues live slots, fails expired ones, flags orphaned transitional statuses", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const a = await activeProject(e, "resume-a");
    const b = await activeProject(e, "resume-b");
    const c = await activeProject(e, "resume-c");
    await e.store.acquireOperation(a, "restartServer", 60_000, { token: "tok-a" });
    await e.store.updateProject(a, { serverStatus: "Starting" });
    await e.store.acquireOperation(b, "rebuild", -1, { token: "tok-b" });
    await e.store.updateProject(b, { rebuildStatus: "rebuilding" });
    await e.store.updateProject(c, { serverStatus: "Unarchiving" });
    const out = await resumeOperations(e.ctx);
    expect(out.resumed).toEqual([`${a}:restartServer`]);
    expect(out.failed.sort()).toEqual([`${b}:rebuild`, `${c}:Unarchiving`].sort());
    expect(e.queue.sent.at(-1)).toMatchObject({ name: "sandbox.restart", data: { projectId: a, token: "tok-a" } });
    expect((await e.json("GET", `/v1/projects/${b}/rebuild/status`)).body.data.status).toBe("error");
    expect((await e.json("GET", `/v1/projects/${c}`)).body.data.serverErrorMessage).toMatch(/Interrupted/);
    await e.queue.drain();
    expect((await e.json("GET", `/v1/projects/${a}`)).body.data.agentServerStatus).toBe("Active");
  });
});

describe("database routes", () => {
  it("go through the CMS port with the body the UI sends (DELETE link with a JSON body)", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "cms-app");
    expect((await e.json("POST", `/v1/projects/${id}/database/query`, { tableName: "note", queryOptions: { _limit: 25 } })).body.data).toEqual({
      results: [{ _id: "r1" }],
    });
    expect((await e.json("POST", `/v1/projects/${id}/database/query`, {})).body.errors.errorCode).toBe("MISSING_TABLE_NAME");
    expect((await e.json("POST", `/v1/projects/${id}/database/records`, { tableName: "note", data: { title: "a" } })).body.data).toEqual({
      _id: "new",
      title: "a",
    });
    expect((await e.json("PATCH", `/v1/projects/${id}/database/records/r1`, { tableName: "note", data: { title: "b" } })).body.data._id).toBe("r1");
    expect((await e.json("DELETE", `/v1/projects/${id}/database/records/r1?tableName=note`)).body.data.deleted).toBe(true);
    await e.json("POST", `/v1/projects/${id}/database/records/r1/link`, { tableName: "note", propertyId: "tags", referenceId: "t1" });
    await e.json("DELETE", `/v1/projects/${id}/database/records/r1/link`, { tableName: "note", propertyId: "tags", referenceId: "t1" });
    expect(e.cms.calls).toEqual(expect.arrayContaining(["link:tags", "unlink:tags"]));
  });
});

describe("provision retry after a half-initialised repository", () => {
  it("starts the repository over when repo.git exists without a work checkout", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const path = await import("node:path");
    const e = makeTestEngine();
    const root = path.join(e.dataDir, "projects", "half-init");
    mkdirSync(path.join(root, "repo.git"), { recursive: true });
    writeFileSync(path.join(root, "repo.git", "HEAD"), "garbage");
    await e.json("POST", "/v1/projects", { projectId: "half-init", description: "" });
    await e.queue.drain();
    const p = (await e.json("GET", "/v1/projects/half-init")).body.data;
    expect(p.serverErrorMessage).toBeNull();
    expect(p.agentServerStatus).toBe("Active");
    expect((await e.json("GET", "/v1/projects/half-init/versions")).body.data.totalCount).toBe(1);
  });
});

describe("delete during provisioning", () => {
  it("tears down containers created after the delete instead of reviving the project", async () => {
    const e = makeTestEngine({ repo: "fake" });
    await e.json("POST", "/v1/projects", { projectId: "race-del", description: "" });
    const job = e.queue.sent[0];
    // The delete lands while the provision job is already past its slot check.
    const origProvision = e.sandbox.provision.bind(e.sandbox);
    e.sandbox.provision = async (id, o) => {
      const r = await origProvision(id, o);
      await e.store.updateProject(id, { deletedAt: new Date() });
      return r;
    };
    await e.queue.drain();
    expect(job?.name).toBe("sandbox.provision");
    expect(e.sandbox.projects.has("race-del")).toBe(false);
    expect((await e.store.getProject("race-del", { includeDeleted: true }))?.serverStatus).not.toBe("Active");
  });
});
