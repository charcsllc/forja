/**
 * `SandboxManager`: the lifecycle of one project's Docker sandbox (04 §1, §3, §9).
 *
 *   provision → (start | stop | restart) → archive → unarchive → … → remove → destroy
 *
 * What this file protects:
 * - Provision is idempotent: networks and volumes are reused, the DB script is
 *   idempotent (roles' passwords are reset to the ones returned), and the app container
 *   is recreated so its DATABASE_URL always matches those passwords.
 * - The DB is reachable only on `forja-int-<id>` (internal); app and verify are also on
 *   `forja-apps` so Traefik and the engine reach them. Nothing publishes a port.
 * - Archive stops app and DB and removes the internal network after force-disconnecting
 *   both containers, so unarchive can recreate it and reconnect them (a stopped container
 *   pointing at a deleted network would never start again). Nothing is destroyed.
 * - `remove` keeps volumes (soft delete); only `destroy` deletes them.
 * - Images are never pulled here: a missing runner or DB image is `IMAGE_MISSING`.
 * - Host directories are created by the engine (uid 1000) before any bind, because
 *   Docker would otherwise create them as root and the sandbox could not write `$HOME`.
 */
import { randomBytes } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import type { AgentServerStatus } from "@forja/contracts/v1";
import { DockerodeApi, type ContainerState, type DockerApi, type ExecOptions, type ExecResult, type LogsOptions } from "./docker.js";
import { SandboxError } from "./errors.js";
import { hostPathCheck, type HostPathCheckResult } from "./hostcheck.js";
import {
  APPS_NETWORK,
  APP_DATABASE,
  APP_PORT,
  DB_SUPERUSER,
  DEFAULT_DB_IMAGE,
  LABEL_PROJECT,
  PROBE_IMAGE,
  assertProjectId,
  assertRunId,
  baseLabels,
  names,
  previewUrl,
  projectPaths,
} from "./names.js";
import { inContainerProbe, type HttpProbe } from "./probe.js";
import {
  appContainerSpec,
  createRunDatabaseSql,
  databaseUrl,
  dbContainerSpec,
  dropRunDatabaseSql,
  internalNetworkSpec,
  rolesSql,
  verifyContainerSpec,
  volumeInitSpec,
  type DbPasswords,
} from "./specs.js";

export interface SandboxManagerConfig {
  /** Default: dockerode from `DOCKER_HOST` or the local socket. */
  docker?: DockerApi;
  /** `DATA_DIR`: the data folder as the engine sees it. */
  dataDir: string;
  /** `DATA_DIR_HOST`: the same folder as the Docker daemon sees it (bind sources). */
  dataDirHost: string;
  /** `forja-runner:<template-version>`. */
  runnerImage: string;
  dbImage?: string;
  previewDomain: string;
  previewTls?: boolean;
  previewPublic?: boolean;
  /** `SANDBOX_RUNTIME` (`runsc` = gVisor); empty = runc. */
  runtime?: string;
  mem?: string | number;
  cpus?: number;
  pids?: number;
  watchpackPolling?: boolean;
  /** Default: `inContainerProbe(docker)` (node fetch). The engine passes `networkProbe()`. */
  probe?: HttpProbe;
  /** Override the app/verify command (tests use a stand-in image). */
  appCommand?: readonly string[];
  appsNetwork?: string;
  dbReadyTimeoutSec?: number;
}

export interface ProvisionOptions {
  /** Overrides `config.runnerImage` for this project. */
  runnerImage?: string;
  /** Existing passwords (from the engine's secrets) for a re-provision; missing ones are generated. */
  dbPasswords?: Partial<DbPasswords>;
  /** Extra app env (rendered project secrets). */
  env?: Record<string, string>;
  /** Start the app container (default true). */
  startApp?: boolean;
}

export interface DbConnectionInfo {
  container: string;
  host: string;
  port: number;
  database: string;
  superuser: { user: string; password: string };
  passwords: DbPasswords;
  urls: { app: string; cmsRo: string; cmsRw: string };
}

export interface ProvisionResult {
  projectId: string;
  network: string;
  appContainer: string;
  previewUrl: string;
  internalUrl: string;
  db: DbConnectionInfo;
}

export interface VerifyOptions {
  /** `app_rw` password (from provision / secrets) for the verify DATABASE_URL. */
  appRwPassword: string;
  runnerImage?: string;
  env?: Record<string, string>;
  start?: boolean;
}

export interface VerifyResult {
  container: string;
  database: string;
  databaseUrl: string;
  internalUrl: string;
}

export interface WaitHttpOptions {
  probe?: HttpProbe;
  port?: number;
  intervalMs?: number;
  /** Default: 200–399. */
  isReady?: (status: number) => boolean;
}

export interface WaitHttpResult {
  ready: boolean;
  status: number | null;
  attempts: number;
  elapsedMs: number;
}

function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SandboxManager {
  readonly docker: DockerApi;
  private readonly config: SandboxManagerConfig;
  private readonly appsNetwork: string;

  constructor(config: SandboxManagerConfig) {
    this.config = config;
    this.docker = config.docker ?? new DockerodeApi();
    this.appsNetwork = config.appsNetwork ?? APPS_NETWORK;
  }

  // ── Provision ──────────────────────────────────────────────────────────────

  async provision(projectId: string, options: ProvisionOptions = {}): Promise<ProvisionResult> {
    assertProjectId(projectId);
    const runnerImage = options.runnerImage ?? this.config.runnerImage;
    const dbImage = this.config.dbImage ?? DEFAULT_DB_IMAGE;
    await this.requireImages([runnerImage, dbImage]);
    await this.prepareHostDirs(projectId, "work");
    if (!(await this.docker.inspectNetwork(this.appsNetwork))) {
      throw new SandboxError("APPS_NETWORK_MISSING", `Network ${this.appsNetwork} does not exist; start the Forja stack first.`);
    }
    await this.ensureInternalNetwork(projectId);
    await this.ensureVolume(names.dbVolume(projectId), baseLabels(projectId, "db"));
    await this.ensureRunnerVolume(projectId, names.appNextVolume(projectId), baseLabels(projectId, "app"), runnerImage);

    const passwords: DbPasswords = {
      superuser: options.dbPasswords?.superuser ?? generatePassword(),
      app_rw: options.dbPasswords?.app_rw ?? generatePassword(),
      cms_ro: options.dbPasswords?.cms_ro ?? generatePassword(),
      cms_rw: options.dbPasswords?.cms_rw ?? generatePassword(),
    };

    const dbName = names.dbContainer(projectId);
    if (!(await this.docker.inspectContainer(dbName))) {
      await this.docker.createContainer(
        dbContainerSpec({ projectId, superuserPassword: passwords.superuser, image: dbImage, runtime: this.config.runtime }),
      );
    }
    await this.connectInternal(projectId, dbName, "db");
    await this.docker.startContainer(dbName);
    await this.waitDbHealthy(projectId);
    await this.psql(projectId, rolesSql(passwords), "postgres");

    const db = this.connectionInfo(projectId, passwords);
    const appName = names.appContainer(projectId);
    await this.docker.removeContainer(appName, { force: true });
    await this.docker.createContainer(
      appContainerSpec({
        projectId,
        image: runnerImage,
        dataDirHost: this.config.dataDirHost,
        databaseUrl: db.urls.app,
        runtime: this.config.runtime,
        mem: this.config.mem,
        cpus: this.config.cpus,
        pids: this.config.pids,
        watchpackPolling: this.config.watchpackPolling,
        command: this.config.appCommand,
        env: options.env,
        previewDomain: this.config.previewDomain,
        previewTls: this.config.previewTls,
        previewPublic: this.config.previewPublic,
        publicUrl: previewUrl(projectId, this.config.previewDomain, this.config.previewTls),
      }),
    );
    await this.docker.connectNetwork(this.appsNetwork, appName);
    if (options.startApp ?? true) await this.docker.startContainer(appName);

    return {
      projectId,
      network: names.internalNetwork(projectId),
      appContainer: appName,
      previewUrl: previewUrl(projectId, this.config.previewDomain, this.config.previewTls),
      internalUrl: `http://${appName}:${APP_PORT}`,
      db,
    };
  }

  private connectionInfo(projectId: string, passwords: DbPasswords): DbConnectionInfo {
    return {
      container: names.dbContainer(projectId),
      host: names.dbContainer(projectId),
      port: 5432,
      database: APP_DATABASE,
      superuser: { user: DB_SUPERUSER, password: passwords.superuser },
      passwords,
      urls: {
        app: databaseUrl(projectId, "app_rw", passwords.app_rw, APP_DATABASE),
        cmsRo: databaseUrl(projectId, "cms_ro", passwords.cms_ro, APP_DATABASE),
        cmsRw: databaseUrl(projectId, "cms_rw", passwords.cms_rw, APP_DATABASE),
      },
    };
  }

  private async requireImages(images: readonly string[]): Promise<void> {
    for (const image of images) {
      if (!(await this.docker.imageExists(image))) {
        throw new SandboxError("IMAGE_MISSING", `Image ${image} is not available locally.`, { image });
      }
    }
  }

  /** Creates `home/` (engine-owned) and checks the checkout exists before binding it. */
  private async prepareHostDirs(projectId: string, checkout: "work" | "run"): Promise<void> {
    const paths = projectPaths(this.config.dataDir, projectId);
    await mkdir(paths.home, { recursive: true, mode: 0o755 });
    const dir = checkout === "work" ? paths.work : paths.run;
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) throw new SandboxError("WORK_MISSING", `Checkout ${checkout}/ does not exist for ${projectId}.`, { path: dir });
  }

  private async ensureInternalNetwork(projectId: string): Promise<void> {
    if (await this.docker.inspectNetwork(names.internalNetwork(projectId))) return;
    await this.docker.createNetwork(internalNetworkSpec(projectId));
  }

  private async ensureVolume(name: string, labels: Record<string, string>): Promise<void> {
    if (!(await this.docker.volumeExists(name))) await this.docker.createVolume(name, labels);
  }

  /** Creates a runner volume (e.g. `.next`) and hands it to uid 1000 once. */
  private async ensureRunnerVolume(projectId: string, name: string, labels: Record<string, string>, image: string): Promise<void> {
    if (await this.docker.volumeExists(name)) return;
    await this.docker.createVolume(name, labels);
    const spec = volumeInitSpec(projectId, name, image);
    await this.docker.removeContainer(spec.name, { force: true });
    try {
      await this.docker.createContainer(spec);
      await this.docker.startContainer(spec.name);
      const exitCode = await this.docker.waitContainer(spec.name);
      if (exitCode !== 0) throw new SandboxError("VOLUME_INIT_FAILED", `Could not prepare volume ${name} (chown exited ${exitCode}).`, { image });
    } catch (error) {
      // Never leave a root-owned volume behind: the next provision retries from scratch.
      await this.docker.removeContainer(spec.name, { force: true });
      await this.docker.removeVolume(name).catch(() => false);
      throw error;
    }
    await this.docker.removeContainer(spec.name, { force: true });
  }

  private async connectInternal(projectId: string, container: string, alias: string): Promise<void> {
    await this.docker.connectNetwork(names.internalNetwork(projectId), container, [alias]);
  }

  // ── Database ───────────────────────────────────────────────────────────────

  async waitDbHealthy(projectId: string, timeoutSec = this.config.dbReadyTimeoutSec ?? 90): Promise<void> {
    const name = names.dbContainer(projectId);
    const deadline = Date.now() + timeoutSec * 1000;
    let last: ContainerState | null = null;
    while (Date.now() < deadline) {
      last = await this.docker.inspectContainer(name);
      if (!last) throw new SandboxError("NOT_PROVISIONED", `${name} does not exist.`);
      if (last.running && last.health === "healthy") return;
      if (!last.running && last.status !== "created" && last.status !== "restarting") {
        throw new SandboxError("DB_NOT_READY", `${name} is ${last.status}.`, { exitCode: last.exitCode });
      }
      await sleep(500);
    }
    throw new SandboxError("DB_NOT_READY", `${name} was not healthy after ${timeoutSec}s.`, { health: last?.health });
  }

  /** Runs a psql script (stdin) as the superuser over the local socket. */
  async psql(projectId: string, script: string, database = "postgres"): Promise<ExecResult> {
    const result = await this.docker.exec(
      names.dbContainer(projectId),
      ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", DB_SUPERUSER, "-d", database, "-f", "-"],
      { user: "postgres", stdin: script, timeoutSec: 60, maxOutputBytes: 64 * 1024 },
    );
    if (result.exitCode !== 0) {
      throw new SandboxError("DB_SCRIPT_FAILED", `psql failed (${result.exitCode}): ${result.stderr.trim().slice(0, 500)}`, {
        exitCode: result.exitCode,
      });
    }
    return result;
  }

  /** `verify_<runId>` from template0, owned by `app_rw`. */
  async createRunDatabase(projectId: string, runId: string): Promise<{ database: string }> {
    const database = names.verifyDatabase(runId);
    await this.psql(projectId, createRunDatabaseSql(database), "postgres");
    return { database };
  }

  async dropRunDatabase(projectId: string, runId: string): Promise<void> {
    await this.psql(projectId, dropRunDatabaseSql(names.verifyDatabase(runId)), "postgres");
  }

  // ── Verify (per run) ───────────────────────────────────────────────────────

  /** Creates the run database and `forja-verify-<id>` on `run/` (no Traefik labels). */
  async createVerify(projectId: string, runId: string, options: VerifyOptions): Promise<VerifyResult> {
    assertRunId(runId);
    const runnerImage = options.runnerImage ?? this.config.runnerImage;
    await this.requireImages([runnerImage]);
    await this.prepareHostDirs(projectId, "run");
    const { database } = await this.createRunDatabase(projectId, runId);
    const url = databaseUrl(projectId, "app_rw", options.appRwPassword, database);
    const name = names.verifyContainer(projectId);
    await this.docker.removeContainer(name, { force: true });
    await this.ensureRunnerVolume(projectId, names.verifyNextVolume(projectId), baseLabels(projectId, "verify", runId), runnerImage);
    await this.docker.createContainer(
      verifyContainerSpec({
        projectId,
        runId,
        image: runnerImage,
        dataDirHost: this.config.dataDirHost,
        databaseUrl: url,
        runtime: this.config.runtime,
        mem: this.config.mem,
        cpus: this.config.cpus,
        pids: this.config.pids,
        watchpackPolling: this.config.watchpackPolling,
        command: this.config.appCommand,
        env: options.env,
      }),
    );
    await this.docker.connectNetwork(this.appsNetwork, name);
    if (options.start ?? true) await this.docker.startContainer(name);
    return { container: name, database, databaseUrl: url, internalUrl: `http://${name}:${APP_PORT}` };
  }

  /** Removes `forja-verify-<id>`, its `.next` volume and `verify_<runId>`. */
  async destroyVerify(projectId: string, runId: string): Promise<void> {
    assertRunId(runId);
    await this.docker.removeContainer(names.verifyContainer(projectId), { force: true });
    await this.docker.removeVolume(names.verifyNextVolume(projectId));
    const db = await this.docker.inspectContainer(names.dbContainer(projectId));
    if (db?.running) await this.dropRunDatabase(projectId, runId);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Docker's view mapped to `agentServerStatus`; null when never provisioned. */
  async status(projectId: string): Promise<AgentServerStatus | null> {
    const app = await this.docker.inspectContainer(names.appContainer(projectId));
    if (!app) return null;
    switch (app.status) {
      case "running":
        return "Active";
      case "created":
        return "Creating";
      case "restarting":
        return "Starting";
      case "removing":
        return "Archiving";
      default:
        return "Archived";
    }
  }

  /** Starts DB then app, recreating the internal network if an archive removed it. */
  async start(projectId: string): Promise<void> {
    await this.unarchive(projectId);
  }

  /** Stops app (and verify) then DB; the network stays. */
  async stop(projectId: string): Promise<void> {
    await this.docker.stopContainer(names.verifyContainer(projectId), 5);
    await this.docker.stopContainer(names.appContainer(projectId), 10);
    await this.docker.stopContainer(names.dbContainer(projectId), 30);
  }

  /** `agent/server/start-or-restart`: restarts the app (DB started if needed). */
  async restart(projectId: string): Promise<void> {
    const app = await this.docker.inspectContainer(names.appContainer(projectId));
    if (!app) throw new SandboxError("NOT_PROVISIONED", `${names.appContainer(projectId)} does not exist.`);
    const db = await this.docker.inspectContainer(names.dbContainer(projectId));
    if (!db?.running || !(await this.docker.inspectNetwork(names.internalNetwork(projectId)))) {
      await this.unarchive(projectId);
      return;
    }
    await this.docker.restartContainer(names.appContainer(projectId), 10);
  }

  /** Archive: stop app and DB, drop the verify container, remove the internal network. */
  async archive(projectId: string): Promise<void> {
    const network = names.internalNetwork(projectId);
    await this.docker.removeContainer(names.verifyContainer(projectId), { force: true });
    await this.docker.stopContainer(names.appContainer(projectId), 10);
    await this.docker.stopContainer(names.dbContainer(projectId), 30);
    await this.docker.disconnectNetwork(network, names.appContainer(projectId));
    await this.docker.disconnectNetwork(network, names.dbContainer(projectId));
    await this.docker.removeNetwork(network);
  }

  /** Unarchive: recreate the internal network, reconnect, start DB (healthy) then app. */
  async unarchive(projectId: string): Promise<void> {
    const appName = names.appContainer(projectId);
    const dbName = names.dbContainer(projectId);
    if (!(await this.docker.inspectContainer(appName)) || !(await this.docker.inspectContainer(dbName))) {
      throw new SandboxError("NOT_PROVISIONED", `Project ${projectId} has no sandbox.`);
    }
    await this.ensureInternalNetwork(projectId);
    await this.connectInternal(projectId, dbName, "db");
    await this.connectInternal(projectId, appName, "app");
    await this.docker.connectNetwork(this.appsNetwork, appName);
    await this.docker.startContainer(dbName);
    await this.waitDbHealthy(projectId);
    await this.docker.startContainer(appName);
  }

  /** Soft delete: containers and the internal network go; volumes stay. */
  async remove(projectId: string): Promise<void> {
    await this.docker.removeContainer(names.verifyContainer(projectId), { force: true });
    await this.docker.removeContainer(names.appContainer(projectId), { force: true });
    await this.docker.removeContainer(names.dbContainer(projectId), { force: true });
    await this.docker.removeNetwork(names.internalNetwork(projectId));
  }

  /** Purge: `remove` plus every volume of the project. Bind-mounted files are the engine's. */
  async destroy(projectId: string): Promise<void> {
    await this.remove(projectId);
    for (const container of await this.docker.listContainers({ [LABEL_PROJECT]: projectId })) {
      await this.docker.removeContainer(container.name, { force: true });
    }
    await this.docker.removeVolume(names.appNextVolume(projectId));
    await this.docker.removeVolume(names.verifyNextVolume(projectId));
    await this.docker.removeVolume(names.dbVolume(projectId));
  }

  // ── Operations ─────────────────────────────────────────────────────────────

  /** argv is executed as-is (no shell unless the caller passes e.g. `['bash','-lc',…]`). */
  exec(container: string, argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    return this.docker.exec(container, argv, { cwd: "/workspace", ...options });
  }

  logs(container: string, options: LogsOptions = {}): Promise<string> {
    return this.docker.logs(container, options);
  }

  /** Polls `path` on the container's port 3000 until ready or `timeoutSec`. */
  async waitHttpReady(container: string, path = "/", timeoutSec = 300, options: WaitHttpOptions = {}): Promise<WaitHttpResult> {
    const probe = options.probe ?? this.config.probe ?? inContainerProbe(this.docker);
    const isReady = options.isReady ?? ((status: number) => status >= 200 && status < 400);
    const started = Date.now();
    const deadline = started + timeoutSec * 1000;
    let attempts = 0;
    let status: number | null = null;
    while (true) {
      attempts += 1;
      status = await probe.status({ container, port: options.port ?? APP_PORT, path });
      if (status !== null && isReady(status)) return { ready: true, status, attempts, elapsedMs: Date.now() - started };
      if (Date.now() + (options.intervalMs ?? 1000) > deadline) break;
      await sleep(options.intervalMs ?? 1000);
    }
    return { ready: false, status, attempts, elapsedMs: Date.now() - started };
  }

  /** 04 §1: proves DATA_DIR and DATA_DIR_HOST are the same folder. */
  hostPathCheck(image = PROBE_IMAGE): Promise<HostPathCheckResult> {
    return hostPathCheck(this.config.dataDir, this.config.dataDirHost, { docker: this.docker, image });
  }

  listContainers(projectId: string): Promise<ContainerState[]> {
    return this.docker.listContainers({ [LABEL_PROJECT]: assertProjectId(projectId) });
  }
}
