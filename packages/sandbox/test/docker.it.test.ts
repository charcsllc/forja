/**
 * Integration tests against the real local Docker daemon. Run with FORJA_DOCKER_IT=1.
 *
 * Uses only images already present locally: `alpine:3.22` stands in for the runner
 * image (command `sleep`), `postgres:17-alpine` is the real DB. Protects: the hardening
 * actually holds in a running container (read-only root, uid 1000, no caps), the DB is
 * provisioned with working roles and default privileges, run databases come and go,
 * exec honours timeout/truncation/stdin, archive/unarchive keep data, the host-path
 * check detects a mismatch, and every object created here is removed afterwards.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerodeApi, SandboxManager, hostPathCheck, inContainerProbe, names } from "../src/index.js";

const RUN = process.env.FORJA_DOCKER_IT === "1";
const ID = `it-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!RUN)("sandbox against real Docker", { timeout: 180_000 }, () => {
  const docker = new DockerodeApi();
  let tmp: string;
  let manager: SandboxManager;
  let createdAppsNetwork = false;
  let appRwPassword = "";

  const sql = async (query: string, database = "app") => {
    const r = await manager.exec(names.dbContainer(ID), ["psql", "-X", "-q", "-tA", "-U", "postgres", "-d", database, "-c", query], {
      user: "postgres",
      cwd: "/",
      timeoutSec: 20,
    });
    return r;
  };
  // Over the internal network (not loopback, which the image trusts): passwords are checked.
  const asRole = async (role: string, password: string, query: string, database = "app") =>
    manager.exec(
      names.dbContainer(ID),
      ["psql", "-X", "-q", "-tA", "-h", names.dbContainer(ID), "-U", role, "-d", database, "-c", query],
      { user: "postgres", cwd: "/", env: { PGPASSWORD: password }, timeoutSec: 20 },
    );

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "forja-sbx-it-"));
    await mkdir(path.join(tmp, "projects", ID, "work"), { recursive: true });
    await mkdir(path.join(tmp, "projects", ID, "run"), { recursive: true });
    if (!(await docker.inspectNetwork("forja-apps"))) {
      await docker.docker.createNetwork({ Name: "forja-apps", Driver: "bridge", Labels: { "forja.test": "1" } });
      createdAppsNetwork = true;
    }
    manager = new SandboxManager({
      docker,
      dataDir: tmp,
      dataDirHost: tmp,
      runnerImage: "alpine:3.22",
      previewDomain: "forja.localhost",
      appCommand: ["sleep", "3600"],
      mem: "256m",
      cpus: 1,
    });
  });

  afterAll(async () => {
    if (!manager) return;
    await manager.destroy(ID).catch(() => undefined);
    if (createdAppsNetwork) await docker.removeNetwork("forja-apps");
    await rm(tmp, { recursive: true, force: true });
  });

  it("hostPathCheck: ok when both paths match, mismatch otherwise", async () => {
    expect(await hostPathCheck(tmp, tmp, { docker })).toEqual({ status: "ok" });
    const other = await mkdtemp(path.join(os.tmpdir(), "forja-sbx-other-"));
    try {
      const result = await hostPathCheck(tmp, other, { docker });
      expect(result.status).toBe("mismatch");
      const missing = await hostPathCheck(tmp, path.join(other, "does-not-exist"), { docker });
      expect(missing.status).toBe("mismatch");
    } finally {
      await rm(other, { recursive: true, force: true });
    }
    expect((await docker.docker.listContainers({ all: true, filters: { label: ["forja.role=probe"] } })).length).toBe(0);
  });

  it("provisions the DB with roles and the hardened app", async () => {
    const result = await manager.provision(ID);
    appRwPassword = result.db.passwords.app_rw;
    expect(await manager.status(ID)).toBe("Active");
    const roles = await sql("SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('app_rw','cms_ro','cms_rw')");
    expect(roles.stdout.trim()).toBe("app_rw,cms_ro,cms_rw");
    expect((await asRole("app_rw", result.db.passwords.app_rw, "CREATE TABLE t (id serial primary key, v text); INSERT INTO t (v) VALUES ('x'); SELECT count(*) FROM t;")).stdout.trim()).toBe("1");
    expect((await asRole("cms_ro", result.db.passwords.cms_ro, "SELECT v FROM t")).stdout.trim()).toBe("x");
    const roWrite = await asRole("cms_ro", result.db.passwords.cms_ro, "INSERT INTO t (v) VALUES ('no')");
    expect(roWrite.exitCode).not.toBe(0);
    expect(roWrite.stderr).toContain("permission denied");
    expect((await asRole("cms_rw", result.db.passwords.cms_rw, "INSERT INTO t (v) VALUES ('y'); SELECT count(*) FROM t;")).stdout.trim()).toBe("2");
    const wrong = await asRole("app_rw", "wrong", "SELECT 1");
    expect(wrong.exitCode).not.toBe(0);

    const app = await docker.inspectContainer(names.appContainer(ID));
    expect(app?.running).toBe(true);
    expect(app?.networks.sort()).toEqual(["forja-apps", names.internalNetwork(ID)].sort());
    expect(app?.labels["traefik.http.routers.app-" + ID + ".rule"]).toBe(`Host(\`${ID}.forja.localhost\`)`);
    expect(app?.hostConfig.ReadonlyRootfs).toBe(true);
    expect(app?.hostConfig.CapDrop).toEqual(["ALL"]);
    expect(app?.hostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    const db = await docker.inspectContainer(names.dbContainer(ID));
    expect(db?.networks).toEqual([names.internalNetwork(ID)]);
    const net = await docker.inspectNetwork(names.internalNetwork(ID));
    expect(net?.internal).toBe(true);
    expect(net?.options["com.docker.network.bridge.name"]).toBe(names.internalBridge(ID));
  });

  it("the app container is really hardened", async () => {
    const app = names.appContainer(ID);
    expect((await manager.exec(app, ["id", "-u"])).stdout.trim()).toBe("1000");
    const rootWrite = await manager.exec(app, ["touch", "/etc/forja"]);
    expect(rootWrite.exitCode).not.toBe(0);
    expect(rootWrite.stderr).toMatch(/Read-only file system/i);
    expect((await manager.exec(app, ["touch", "/workspace/ok", "/home/node/ok", "/tmp/ok", "/workspace/.next/ok"])).exitCode).toBe(0);
    const caps = await manager.exec(app, ["grep", "CapEff", "/proc/self/status"]);
    expect(caps.stdout).toMatch(/CapEff:\s+0000000000000000/);
    const nnp = await manager.exec(app, ["grep", "NoNewPrivs", "/proc/self/status"]);
    expect(nnp.stdout).toMatch(/NoNewPrivs:\s+1/);
  });

  it("exec: demux, stdin, timeout and truncation", async () => {
    const app = names.appContainer(ID);
    const both = await manager.exec(app, ["sh", "-c", "echo out; echo err >&2; exit 3"]);
    expect(both).toMatchObject({ exitCode: 3, stdout: "out\n", stderr: "err\n", truncated: false, timedOut: false });
    const cat = await manager.exec(app, ["cat"], { stdin: "hello stdin" });
    expect(cat.stdout).toBe("hello stdin");
    const slow = await manager.exec(app, ["sleep", "30"], { timeoutSec: 1 });
    expect(slow.timedOut).toBe(true);
    expect(slow.durationMs).toBeLessThan(10_000);
    const big = await manager.exec(app, ["head", "-c", "100000", "/dev/zero"], { maxOutputBytes: 1000 });
    expect(big.truncated).toBe(true);
    expect(big.stdout.length).toBe(1000);
    expect(big.exitCode).toBe(0);
    const env = await manager.exec(app, ["printenv", "FOO"], { env: { FOO: "bar" } });
    expect(env.stdout.trim()).toBe("bar");
    const cwd = await manager.exec(app, ["pwd"]);
    expect(cwd.stdout.trim()).toBe("/workspace");
  });

  it("waitHttpReady with the in-container probe, and logs", async () => {
    const app = names.appContainer(ID);
    const probe = inContainerProbe(docker, { tool: "wget" });
    const before = await manager.waitHttpReady(app, "/", 1, { probe, intervalMs: 200 });
    expect(before.ready).toBe(false);
    const server =
      '(while true; do printf "HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nok" | nc -l -p 3000 >/dev/null; done) >/dev/null 2>&1 </dev/null &';
    await manager.exec(app, ["sh", "-c", server]);
    const ready = await manager.waitHttpReady(app, "/", 15, { probe, intervalMs: 200 });
    expect(ready).toMatchObject({ ready: true, status: 200 });
    const logs = await manager.logs(names.dbContainer(ID), { tail: 200 });
    expect(logs).toContain("ready to accept connections");
  });

  it("creates and drops the per-run database and verify container", async () => {
    const verify = await manager.createVerify(ID, "Run_1", { appRwPassword });
    expect(verify.database).toBe("verify_run_1");
    expect((await sql("SELECT count(*) FROM pg_database WHERE datname = 'verify_run_1'", "postgres")).stdout.trim()).toBe("1");
    expect((await asRole("app_rw", appRwPassword, "CREATE TABLE v (id int); SELECT 1", "verify_run_1")).stdout.trim()).toBe("1");
    const container = await docker.inspectContainer(names.verifyContainer(ID));
    expect(container?.running).toBe(true);
    expect(Object.keys(container?.labels ?? {}).some((k) => k.startsWith("traefik"))).toBe(false);
    expect(container?.labels["forja.run"]).toBe("Run_1");
    await manager.destroyVerify(ID, "Run_1");
    expect(await docker.inspectContainer(names.verifyContainer(ID))).toBeNull();
    expect((await sql("SELECT count(*) FROM pg_database WHERE datname = 'verify_run_1'", "postgres")).stdout.trim()).toBe("0");
  });

  it("archives and unarchives without losing data", async () => {
    await manager.archive(ID);
    expect(await docker.inspectNetwork(names.internalNetwork(ID))).toBeNull();
    expect(await manager.status(ID)).toBe("Archived");
    expect((await docker.inspectContainer(names.dbContainer(ID)))?.running).toBe(false);
    await manager.unarchive(ID);
    expect(await manager.status(ID)).toBe("Active");
    expect(await docker.inspectNetwork(names.internalNetwork(ID))).not.toBeNull();
    expect((await asRole("app_rw", appRwPassword, "SELECT count(*) FROM t")).stdout.trim()).toBe("2");
    await manager.restart(ID);
    expect(await manager.status(ID)).toBe("Active");
  });

  it("destroy removes every container, network and volume of the project", async () => {
    await manager.destroy(ID);
    expect(await manager.listContainers(ID)).toHaveLength(0);
    expect(await docker.inspectNetwork(names.internalNetwork(ID))).toBeNull();
    for (const volume of [names.dbVolume(ID), names.appNextVolume(ID), names.verifyNextVolume(ID)]) {
      expect(await docker.volumeExists(volume)).toBe(false);
    }
  });
});
