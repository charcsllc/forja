/**
 * Unit tests of the sandbox specs and manager against a fake Docker.
 * Protects: every hardening flag of 04 §1, the Traefik labels of 04 §4, names and
 * labels, the provision/archive/unarchive order, and that DB passwords never reach argv.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CappedBuffer,
  InvalidIdError,
  SandboxError,
  SandboxManager,
  START_SCRIPT,
  appContainerSpec,
  dbContainerSpec,
  demuxBuffer,
  dockerOptionsFromEnv,
  internalNetworkSpec,
  names,
  parseMemory,
  rolesSql,
  traefikLabels,
  verifyContainerSpec,
  type HttpProbe,
} from "../src/index.js";
import { FakeDocker } from "./fake-docker.js";

const ID = "my-app";
const HOST = "/srv/forja/data";

function appSpec(overrides: Partial<Parameters<typeof appContainerSpec>[0]> = {}) {
  return appContainerSpec({
    projectId: ID,
    image: "forja-runner:test",
    dataDirHost: HOST,
    databaseUrl: "postgres://app_rw:pw@forja-db-my-app:5432/app",
    previewDomain: "forja.localhost",
    ...overrides,
  });
}

describe("names", () => {
  it("derives every name from the project id", () => {
    expect(names.internalNetwork(ID)).toBe("forja-int-my-app");
    expect(names.internalBridge(ID)).toMatch(/^fj-i-[0-9a-f]{8}$/);
    expect(names.internalBridge(ID).length).toBeLessThanOrEqual(15);
    expect(names.dbContainer(ID)).toBe("forja-db-my-app");
    expect(names.dbVolume(ID)).toBe("forja-pgdata-my-app");
    expect(names.appContainer(ID)).toBe("forja-app-my-app");
    expect(names.appNextVolume(ID)).toBe("forja-next-my-app");
    expect(names.verifyContainer(ID)).toBe("forja-verify-my-app");
    expect(names.verifyDatabase("Run-01.x")).toBe("verify_run_01_x");
    expect(names.verifyDatabase("a".repeat(100)).length).toBe(63);
  });

  it("refuses ids that could inject into Docker names or SQL", () => {
    expect(() => names.appContainer("Bad;rm")).toThrow(InvalidIdError);
    expect(() => names.appContainer("-x")).toThrow(InvalidIdError);
    expect(() => names.verifyDatabase("x'; drop")).toThrow(InvalidIdError);
  });
});

describe("app container spec (04 §1 hardening, §4 labels)", () => {
  it("applies every hardening flag", () => {
    const spec = appSpec({ runtime: "runsc", watchpackPolling: true });
    const h = spec.HostConfig;
    expect(spec.name).toBe("forja-app-my-app");
    expect(spec.User).toBe("1000:1000");
    expect(h.CapDrop).toEqual(["ALL"]);
    expect(h.CapAdd).toBeUndefined();
    expect(h.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.Privileged).toBe(false);
    expect(h.Tmpfs).toEqual({ "/tmp": "rw,exec,nosuid,nodev,size=512m" });
    expect(h.Mounts).toEqual([
      { Type: "bind", Source: `${HOST}/projects/my-app/work`, Target: "/workspace" },
      { Type: "bind", Source: `${HOST}/projects/my-app/home`, Target: "/home/node" },
      { Type: "volume", Source: "forja-next-my-app", Target: "/workspace/.next" },
    ]);
    expect(JSON.stringify(spec)).not.toContain("docker.sock");
    expect(h.PidsLimit).toBe(512);
    expect(h.Memory).toBe(2 * 1024 ** 3);
    expect(h.MemorySwap).toBe(h.Memory);
    expect(h.NanoCpus).toBe(2e9);
    expect(h.Ulimits).toEqual([{ Name: "nofile", Soft: 65536, Hard: 65536 }]);
    expect(h.Runtime).toBe("runsc");
    expect(h.NetworkMode).toBe("forja-int-my-app");
    expect(spec.NetworkingConfig?.EndpointsConfig).toEqual({ "forja-int-my-app": { Aliases: ["app"] } });
    expect(Object.keys(spec)).not.toContain("PortBindings");
    expect(JSON.stringify(h)).not.toContain("PortBindings");
    const env = new Map((spec.Env ?? []).map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
    expect(env.get("HOME")).toBe("/home/node");
    expect(env.get("npm_config_cache")).toBe("/home/node/.npm");
    expect(env.get("NEXT_TELEMETRY_DISABLED")).toBe("1");
    expect(env.get("WATCHPACK_POLLING")).toBe("true");
    expect(env.get("DATABASE_URL")).toBe("postgres://app_rw:pw@forja-db-my-app:5432/app");
    expect(env.get("INTERNAL_APP_URL")).toBe("http://forja-app-my-app:3000");
    expect(spec.Cmd).toEqual(["bash", "-lc", START_SCRIPT]);
    expect(START_SCRIPT).toContain("npm ci --prefer-offline");
    expect(START_SCRIPT).toContain("/opt/forja/npm-cache");
    expect(START_SCRIPT.trim().endsWith("exec npm run dev")).toBe(true);
  });

  it("omits runtime and polling by default, and user env cannot override Forja's", () => {
    const spec = appSpec({ env: { HOME: "/root", DATABASE_URL: "evil", FOO: "bar" } });
    expect(spec.HostConfig.Runtime).toBeUndefined();
    expect(spec.Env).toContain("FOO=bar");
    expect(spec.Env).toContain("HOME=/home/node");
    expect(spec.Env).not.toContain("DATABASE_URL=evil");
    expect(spec.Env?.some((e) => e.startsWith("WATCHPACK_POLLING="))).toBe(false);
  });

  it("carries exactly the Traefik labels of 04 §4", () => {
    const spec = appSpec();
    expect(spec.Labels).toEqual({
      "forja.project": "my-app",
      "forja.role": "app",
      "traefik.enable": "true",
      "traefik.docker.network": "forja-apps",
      "traefik.http.routers.app-my-app.rule": "Host(`my-app.forja.localhost`)",
      "traefik.http.routers.app-my-app.entrypoints": "web",
      "traefik.http.services.app-my-app.loadbalancer.server.port": "3000",
    });
    const priv = traefikLabels(ID, { previewDomain: "p.example.com", previewPublic: false, previewTls: true });
    expect(priv["traefik.http.routers.app-my-app.middlewares"]).toBe("forja-preview-auth@file");
    expect(priv["traefik.http.routers.app-my-app.entrypoints"]).toBe("websecure");
    expect(priv["traefik.http.routers.app-my-app.rule"]).toBe("Host(`my-app.p.example.com`)");
  });
});

describe("verify, db and network specs", () => {
  it("verify: same hardening on run/, no Traefik labels", () => {
    const spec = verifyContainerSpec({
      projectId: ID,
      runId: "r1",
      image: "forja-runner:test",
      dataDirHost: HOST,
      databaseUrl: "postgres://app_rw:pw@forja-db-my-app:5432/verify_r1",
    });
    expect(spec.name).toBe("forja-verify-my-app");
    expect(spec.Labels).toEqual({ "forja.project": "my-app", "forja.role": "verify", "forja.run": "r1" });
    expect(Object.keys(spec.Labels ?? {}).some((k) => k.startsWith("traefik"))).toBe(false);
    expect(spec.HostConfig.Mounts?.[0]).toEqual({ Type: "bind", Source: `${HOST}/projects/my-app/run`, Target: "/workspace" });
    expect(spec.HostConfig.Mounts?.[2]?.Source).toBe("forja-next-verify-my-app");
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.User).toBe("1000:1000");
  });

  it("db: internal only, volume, healthcheck, minimal caps, no ports", () => {
    const spec = dbContainerSpec({ projectId: ID, superuserPassword: "s3cret" });
    expect(spec.name).toBe("forja-db-my-app");
    expect(spec.Image).toBe("postgres:17-alpine");
    expect(spec.Labels).toEqual({ "forja.project": "my-app", "forja.role": "db" });
    expect(spec.HostConfig.Mounts).toEqual([{ Type: "volume", Source: "forja-pgdata-my-app", Target: "/var/lib/postgresql/data" }]);
    expect(spec.HostConfig.NetworkMode).toBe("forja-int-my-app");
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(spec.Healthcheck?.Test).toContain("pg_isready");
    expect(spec.ExposedPorts).toBeUndefined();
  });

  it("internal network: internal bridge with the fj-i- prefix", () => {
    const spec = internalNetworkSpec(ID);
    expect(spec).toMatchObject({ Name: "forja-int-my-app", Driver: "bridge", Internal: true });
    expect(spec.Options["com.docker.network.bridge.name"]).toBe(names.internalBridge(ID));
    expect(spec.Labels["forja.project"]).toBe("my-app");
  });

  it("roles script is idempotent SQL with escaped passwords", () => {
    const sql = rolesSql({ superuser: "a'b", app_rw: "x", cms_ro: "y", cms_rw: "z" });
    expect(sql).toContain("ALTER ROLE postgres WITH PASSWORD 'a''b';");
    for (const role of ["app_rw", "cms_ro", "cms_rw"]) expect(sql).toContain(`WHERE rolname = '${role}')\\gexec`);
    expect(sql).toContain("CREATE DATABASE app OWNER app_rw");
    expect(sql).toContain("GRANT SELECT ON TABLES TO cms_ro");
  });
});

describe("helpers", () => {
  it("parses memory, DOCKER_HOST, demuxes and caps", () => {
    expect(parseMemory("512m")).toBe(512 * 1024 ** 2);
    expect(parseMemory("2g")).toBe(2 * 1024 ** 3);
    expect(() => parseMemory("lots")).toThrow();
    expect(dockerOptionsFromEnv({ DOCKER_HOST: "tcp://socket-proxy:2375" })).toEqual({ host: "socket-proxy", port: 2375, protocol: "http" });
    expect(dockerOptionsFromEnv({ DOCKER_HOST: "unix:///run/docker.sock" })).toEqual({ socketPath: "/run/docker.sock" });
    expect(dockerOptionsFromEnv({})).toEqual({ socketPath: "/var/run/docker.sock" });
    const frame = (type: number, text: string) => {
      const payload = Buffer.from(text);
      const header = Buffer.alloc(8);
      header[0] = type;
      header.writeUInt32BE(payload.length, 4);
      return Buffer.concat([header, payload]);
    };
    const demuxed = demuxBuffer(Buffer.concat([frame(1, "out1 "), frame(2, "err "), frame(1, "out2")]));
    expect(demuxed.stdout.toString()).toBe("out1 out2");
    expect(demuxed.stderr.toString()).toBe("err ");
    expect(demuxed.combined.toString()).toBe("out1 err out2");
    const capped = new CappedBuffer(4);
    capped.push(Buffer.from("abc"));
    capped.push(Buffer.from("def"));
    expect(capped.toString()).toBe("abcd");
    expect(capped.truncated).toBe(true);
  });
});

describe("SandboxManager with a fake Docker", () => {
  let tmp: string;
  let docker: FakeDocker;
  let manager: SandboxManager;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "forja-sbx-"));
    await mkdir(path.join(tmp, "projects", ID, "work"), { recursive: true });
    await mkdir(path.join(tmp, "projects", ID, "run"), { recursive: true });
    docker = new FakeDocker();
    docker.networks.set("forja-apps", { Name: "forja-apps", Driver: "bridge", Internal: false, Labels: {}, Options: {} });
    manager = new SandboxManager({ docker, dataDir: tmp, dataDirHost: HOST, runnerImage: "forja-runner:test", previewDomain: "forja.localhost" });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("provisions network, volumes, DB (+roles via stdin) and the app on both networks", async () => {
    const result = await manager.provision(ID);
    expect(result.previewUrl).toBe("http://my-app.forja.localhost");
    expect(result.db.urls.app).toBe(`postgres://app_rw:${result.db.passwords.app_rw}@forja-db-my-app:5432/app`);
    expect(result.db.superuser.user).toBe("postgres");
    const ops = docker.ops();
    const order = ["createNetwork:forja-int-my-app", "createContainer:forja-db-my-app", "startContainer:forja-db-my-app", "exec:forja-db-my-app", "createContainer:forja-app-my-app", "startContainer:forja-app-my-app"];
    let cursor = -1;
    for (const op of order) {
      const next = ops.indexOf(op, cursor + 1);
      expect(next, op).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(docker.volumes.has("forja-pgdata-my-app")).toBe(true);
    expect(docker.volumes.has("forja-next-my-app")).toBe(true);
    // The fresh .next volume is handed to uid 1000 by a one-shot chown container, then removed.
    const init = docker.calls.find((c) => c.op === "createContainer" && c.args[0] === "forja-init-forja-next-my-app")?.args[1] as
      | { User: string; Entrypoint: string[]; HostConfig: { CapAdd: string[]; CapDrop: string[]; NetworkMode: string } }
      | undefined;
    expect(init?.User).toBe("0:0");
    expect(init?.Entrypoint).toEqual(["chown", "1000:1000", "/v"]);
    expect(init?.HostConfig).toMatchObject({ CapAdd: ["CHOWN"], CapDrop: ["ALL"], NetworkMode: "none" });
    expect(docker.containers.has("forja-init-forja-next-my-app")).toBe(false);
    const app = docker.containers.get("forja-app-my-app");
    expect([...(app?.networks ?? [])].sort()).toEqual(["forja-apps", "forja-int-my-app"]);
    const db = docker.containers.get("forja-db-my-app");
    expect([...(db?.networks ?? [])]).toEqual(["forja-int-my-app"]);
    // Passwords travel on stdin, never argv.
    const psql = docker.execs.find((e) => e.argv[0] === "psql");
    expect(psql?.options.stdin).toContain(result.db.passwords.cms_rw);
    expect(psql?.options.user).toBe("postgres");
    for (const pw of Object.values(result.db.passwords)) expect(psql?.argv.join(" ")).not.toContain(pw);
    // home/ was created by the engine before binding.
    await expect(import("node:fs/promises").then((fs) => fs.stat(path.join(tmp, "projects", ID, "home")))).resolves.toBeTruthy();
    // Re-provision reuses passwords when given and recreates the app.
    const again = await manager.provision(ID, { dbPasswords: result.db.passwords });
    expect(again.db.passwords).toEqual(result.db.passwords);
    expect(docker.calls.filter((c) => c.op === "createNetwork")).toHaveLength(1);
    expect(docker.calls.filter((c) => c.op === "createContainer" && c.args[0] === "forja-db-my-app")).toHaveLength(1);
  });

  it("refuses missing images, apps network and checkout", async () => {
    docker.images.delete("forja-runner:test");
    await expect(manager.provision(ID)).rejects.toMatchObject({ code: "IMAGE_MISSING" });
    docker.images.add("forja-runner:test");
    await expect(manager.provision("other")).rejects.toMatchObject({ code: "WORK_MISSING" });
    docker.networks.delete("forja-apps");
    await expect(manager.provision(ID)).rejects.toBeInstanceOf(SandboxError);
    expect(docker.calls.filter((c) => c.op === "createContainer")).toHaveLength(0);
  });

  it("psql failures surface as DB_SCRIPT_FAILED", async () => {
    docker.execResult = () => ({ exitCode: 3, stdout: "", stderr: "ERROR: boom", truncated: false, timedOut: false, durationMs: 1 });
    await expect(manager.provision(ID)).rejects.toMatchObject({ code: "DB_SCRIPT_FAILED" });
  });

  it("archives (disconnect, then remove the network) and unarchives", async () => {
    await manager.provision(ID);
    expect(await manager.status(ID)).toBe("Active");
    await manager.archive(ID);
    expect(docker.networks.has("forja-int-my-app")).toBe(false);
    expect(await manager.status(ID)).toBe("Archived");
    const ops = docker.ops();
    expect(ops.indexOf("disconnectNetwork:forja-int-my-app>forja-db-my-app")).toBeLessThan(ops.indexOf("removeNetwork:forja-int-my-app"));
    await manager.unarchive(ID);
    expect(docker.networks.has("forja-int-my-app")).toBe(true);
    expect(await manager.status(ID)).toBe("Active");
    expect(docker.containers.get("forja-db-my-app")?.networks.has("forja-int-my-app")).toBe(true);
  });

  it("creates and destroys the per-run verify container and database", async () => {
    const provisioned = await manager.provision(ID);
    const verify = await manager.createVerify(ID, "r1", { appRwPassword: provisioned.db.passwords.app_rw });
    expect(verify.database).toBe("verify_r1");
    expect(verify.databaseUrl).toContain("/verify_r1");
    const container = docker.containers.get("forja-verify-my-app");
    expect(Object.keys(container?.spec.Labels ?? {}).some((k) => k.startsWith("traefik"))).toBe(false);
    expect(container?.networks.has("forja-apps")).toBe(true);
    const create = docker.execs.find((e) => typeof e.options.stdin === "string" && e.options.stdin.includes("CREATE DATABASE verify_r1"));
    expect(create).toBeTruthy();
    await manager.destroyVerify(ID, "r1");
    expect(docker.containers.has("forja-verify-my-app")).toBe(false);
    expect(docker.execs.some((e) => typeof e.options.stdin === "string" && e.options.stdin.includes("DROP DATABASE IF EXISTS verify_r1"))).toBe(true);
  });

  it("remove keeps volumes; destroy deletes them", async () => {
    await manager.provision(ID);
    await manager.remove(ID);
    expect(docker.containers.size).toBe(0);
    expect(docker.volumes.has("forja-pgdata-my-app")).toBe(true);
    expect(await manager.status(ID)).toBeNull();
    await manager.destroy(ID);
    expect(docker.volumes.size).toBe(0);
  });

  it("waitHttpReady polls the probe until ready or timeout", async () => {
    const statuses: (number | null)[] = [null, 503, 200];
    let i = 0;
    const probe: HttpProbe = { kind: "fake", status: async () => statuses[Math.min(i++, statuses.length - 1)] ?? null };
    const ok = await manager.waitHttpReady("forja-app-my-app", "/", 5, { probe, intervalMs: 5 });
    expect(ok).toMatchObject({ ready: true, status: 200, attempts: 3 });
    const never: HttpProbe = { kind: "fake", status: async () => 503 };
    const late = await manager.waitHttpReady("forja-app-my-app", "/", 0.05, { probe: never, intervalMs: 10 });
    expect(late.ready).toBe(false);
    expect(late.status).toBe(503);
  });
});
