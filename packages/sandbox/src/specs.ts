/**
 * Pure builders for every Docker object of a project sandbox (04 §1, §3, §4, §9).
 *
 * Protects the hardening list of 04 §1 for `forja-app-<id>` and `forja-verify-<id>`:
 * `User 1000:1000`, `CapDrop [ALL]`, `no-new-privileges:true`, read-only root with
 * writes only to `/workspace` (bind), `/home/node` (bind), `/tmp` (tmpfs exec,512m) and
 * `/workspace/.next` (a named volume); pids, memory (no swap), cpus and nofile limits;
 * never privileged, never the Docker socket, no other mounts; `SANDBOX_RUNTIME=runsc`
 * sets the gVisor runtime. Binds use the `Mounts` API, so a missing host path is an
 * error instead of a root-owned directory Docker silently creates.
 *
 * Also protects: Traefik labels only on the app container (never verify, never DB); the
 * DB has no published ports and lives only on the internal network; secrets are
 * passed as values, never logged or labelled.
 */
import type { ContainerSpec, HostConfigSpec, NetworkSpec } from "./docker.js";
import {
  APP_DATABASE,
  APP_PORT,
  DB_SUPERUSER,
  DEFAULT_DB_IMAGE,
  baseLabels,
  names,
  projectPaths,
  traefikLabels,
  type TraefikLabelOptions,
} from "./names.js";

export const SANDBOX_UID = "1000:1000";
export const DEFAULT_MEM = "2g";
export const DEFAULT_CPUS = 2;
export const DEFAULT_PIDS = 512;
export const NOFILE_LIMIT = 65536;
export const TMP_TMPFS = "rw,exec,nosuid,nodev,size=512m";
export const NPM_CACHE_SEED = "/opt/forja/npm-cache";

/**
 * Start script of app/verify (run with `bash -lc`, the one explicit shell): seed the
 * npm cache from the image on first run, `npm ci --prefer-offline` when node_modules is
 * missing or older than the lockfile, then `exec npm run dev` (PID 1 = the dev server).
 */
export const START_SCRIPT = [
  "set -e",
  `if [ -d ${NPM_CACHE_SEED} ] && [ -z "$(ls -A /home/node/.npm 2>/dev/null)" ]; then mkdir -p /home/node/.npm && cp -R ${NPM_CACHE_SEED}/. /home/node/.npm/; fi`,
  "if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then npm ci --prefer-offline --no-audit --no-fund; fi",
  "exec npm run dev",
].join("\n");

export const DEFAULT_APP_COMMAND: readonly string[] = ["bash", "-lc", START_SCRIPT];

/** "2g" / "512m" / "1073741824" → bytes. */
export function parseMemory(value: string | number): number {
  if (typeof value === "number") return Math.floor(value);
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i.exec(value.trim());
  if (!match?.[1]) throw new Error(`Invalid memory size: ${value}`);
  const units: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };
  return Math.floor(Number(match[1]) * (units[(match[2] ?? "").toLowerCase()] ?? 1));
}

export interface ResourceLimits {
  mem?: string | number;
  cpus?: number;
  pids?: number;
}

export interface RunnerSpecInput extends ResourceLimits {
  projectId: string;
  image: string;
  /** `DATA_DIR_HOST`: bind sources are host paths (the daemon resolves them). */
  dataDirHost: string;
  /** Full DATABASE_URL for the container (app → `app`, verify → `verify_<runId>`). */
  databaseUrl: string;
  runtime?: string;
  watchpackPolling?: boolean;
  command?: readonly string[];
  /** Extra env (rendered project secrets, NEXT_PUBLIC_APP_URL…). Overrides nothing Forja sets. */
  env?: Record<string, string>;
}

export interface AppSpecInput extends RunnerSpecInput, TraefikLabelOptions {
  /** Public preview URL for NEXT_PUBLIC_APP_URL. */
  publicUrl?: string;
}

export interface VerifySpecInput extends RunnerSpecInput {
  runId: string;
}

export function internalNetworkSpec(projectId: string): NetworkSpec {
  return {
    Name: names.internalNetwork(projectId),
    Driver: "bridge",
    Internal: true,
    Labels: baseLabels(projectId, "app"),
    Options: { "com.docker.network.bridge.name": names.internalBridge(projectId) },
  };
}

function hardenedHostConfig(input: RunnerSpecInput, workSource: string, nextVolume: string): HostConfigSpec {
  const mem = parseMemory(input.mem ?? DEFAULT_MEM);
  const host: HostConfigSpec = {
    Mounts: [
      { Type: "bind", Source: workSource, Target: "/workspace" },
      { Type: "bind", Source: projectPaths(input.dataDirHost, input.projectId).home, Target: "/home/node" },
      { Type: "volume", Source: nextVolume, Target: "/workspace/.next" },
    ],
    Tmpfs: { "/tmp": TMP_TMPFS },
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges:true"],
    Privileged: false,
    PidsLimit: input.pids ?? DEFAULT_PIDS,
    Memory: mem,
    MemorySwap: mem,
    NanoCpus: Math.round((input.cpus ?? DEFAULT_CPUS) * 1e9),
    Ulimits: [{ Name: "nofile", Soft: NOFILE_LIMIT, Hard: NOFILE_LIMIT }],
    NetworkMode: names.internalNetwork(input.projectId),
    RestartPolicy: { Name: "no" },
    LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
  };
  if (input.runtime) host.Runtime = input.runtime;
  return host;
}

function runnerEnv(input: RunnerSpecInput, extra: Record<string, string>): string[] {
  const env: Record<string, string> = {
    ...(input.env ?? {}),
    ...extra,
    HOME: "/home/node",
    npm_config_cache: "/home/node/.npm",
    npm_config_update_notifier: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    PORT: String(APP_PORT),
    HOSTNAME: "0.0.0.0",
    DATABASE_URL: input.databaseUrl,
  };
  if (input.watchpackPolling) env.WATCHPACK_POLLING = "true";
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

/** `forja-app-<id>`: the dev server on `work/`, routed by Traefik. */
export function appContainerSpec(input: AppSpecInput): ContainerSpec {
  const { projectId } = input;
  const name = names.appContainer(projectId);
  return {
    name,
    Image: input.image,
    Cmd: [...(input.command ?? DEFAULT_APP_COMMAND)],
    User: SANDBOX_UID,
    WorkingDir: "/workspace",
    Env: runnerEnv(input, {
      INTERNAL_APP_URL: `http://${name}:${APP_PORT}`,
      ...(input.publicUrl ? { NEXT_PUBLIC_APP_URL: input.publicUrl } : {}),
    }),
    Labels: { ...baseLabels(projectId, "app"), ...traefikLabels(projectId, input) },
    ExposedPorts: { [`${APP_PORT}/tcp`]: {} },
    StopTimeout: 10,
    HostConfig: hardenedHostConfig(input, projectPaths(input.dataDirHost, projectId).work, names.appNextVolume(projectId)),
    NetworkingConfig: { EndpointsConfig: { [names.internalNetwork(projectId)]: { Aliases: ["app"] } } },
  };
}

/** `forja-verify-<id>`: same image on `run/`, NO Traefik labels, one per run. */
export function verifyContainerSpec(input: VerifySpecInput): ContainerSpec {
  const { projectId, runId } = input;
  const name = names.verifyContainer(projectId);
  return {
    name,
    Image: input.image,
    Cmd: [...(input.command ?? DEFAULT_APP_COMMAND)],
    User: SANDBOX_UID,
    WorkingDir: "/workspace",
    Env: runnerEnv(input, { INTERNAL_APP_URL: `http://${name}:${APP_PORT}`, FORJA_RUN_ID: runId }),
    Labels: baseLabels(projectId, "verify", runId),
    ExposedPorts: { [`${APP_PORT}/tcp`]: {} },
    StopTimeout: 5,
    HostConfig: hardenedHostConfig(input, projectPaths(input.dataDirHost, projectId).run, names.verifyNextVolume(projectId)),
    NetworkingConfig: { EndpointsConfig: { [names.internalNetwork(projectId)]: { Aliases: ["verify"] } } },
  };
}

/**
 * A fresh named volume is root-owned, so the sandbox (uid 1000) could not write
 * `/workspace/.next`. This one-shot container (root, only CAP_CHOWN, no network, read-only
 * root) chowns the volume root to 1000:1000 and exits; the manager removes it.
 */
export function volumeInitSpec(projectId: string, volume: string, image: string): ContainerSpec {
  return {
    name: names.volumeInitContainer(volume),
    Image: image,
    Entrypoint: ["chown", SANDBOX_UID, "/v"],
    Cmd: [],
    User: "0:0",
    Labels: baseLabels(projectId, "init"),
    HostConfig: {
      Mounts: [{ Type: "volume", Source: volume, Target: "/v" }],
      NetworkMode: "none",
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 16,
      Memory: 64 * 1024 * 1024,
    },
  };
}

export interface DbSpecInput {
  projectId: string;
  superuserPassword: string;
  image?: string;
  runtime?: string;
  mem?: string | number;
}

/**
 * `forja-db-<id>`: Postgres on the internal network only, no published ports, data in
 * `forja-pgdata-<id>`. The official entrypoint needs to chown and drop to `postgres`, so
 * it keeps exactly CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID over `cap_drop ALL`.
 */
export function dbContainerSpec(input: DbSpecInput): ContainerSpec {
  const { projectId } = input;
  const mem = parseMemory(input.mem ?? "512m");
  const host: HostConfigSpec = {
    Mounts: [{ Type: "volume", Source: names.dbVolume(projectId), Target: "/var/lib/postgresql/data" }],
    Tmpfs: { "/var/run/postgresql": "rw,nosuid,nodev,size=16m", "/tmp": "rw,nosuid,nodev,size=64m" },
    ReadonlyRootfs: true,
    CapDrop: ["ALL"],
    CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
    SecurityOpt: ["no-new-privileges:true"],
    Privileged: false,
    PidsLimit: 256,
    Memory: mem,
    MemorySwap: mem,
    ShmSize: 128 * 1024 * 1024,
    NetworkMode: names.internalNetwork(projectId),
    RestartPolicy: { Name: "no" },
    LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
  };
  if (input.runtime) host.Runtime = input.runtime;
  return {
    name: names.dbContainer(projectId),
    Image: input.image ?? DEFAULT_DB_IMAGE,
    Env: [`POSTGRES_USER=${DB_SUPERUSER}`, `POSTGRES_PASSWORD=${input.superuserPassword}`, "POSTGRES_DB=postgres"],
    Labels: baseLabels(projectId, "db"),
    Healthcheck: {
      Test: ["CMD", "pg_isready", "-U", DB_SUPERUSER, "-d", "postgres", "-h", "127.0.0.1"],
      Interval: 2e9,
      Timeout: 3e9,
      Retries: 30,
      StartPeriod: 5e9,
      StartInterval: 1e9,
    },
    StopTimeout: 30,
    HostConfig: host,
    NetworkingConfig: { EndpointsConfig: { [names.internalNetwork(projectId)]: { Aliases: ["db"] } } },
  };
}

export interface DbPasswords {
  superuser: string;
  app_rw: string;
  cms_ro: string;
  cms_rw: string;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
  return value;
}

/**
 * Idempotent psql script (sent on stdin, never argv, so passwords stay out of `ps`):
 * superuser password (POSTGRES_PASSWORD only applies to a fresh volume), roles `app_rw`,
 * `cms_ro`, `cms_rw` (passwords reset to the given ones), database `app`
 * owned by `app_rw`, CMS grants via default privileges of `app_rw`.
 */
export function rolesSql(passwords: DbPasswords): string {
  const lines = ["\\set ON_ERROR_STOP on", `ALTER ROLE ${DB_SUPERUSER} WITH PASSWORD ${sqlLiteral(passwords.superuser)};`];
  for (const role of ["app_rw", "cms_ro", "cms_rw"] as const) {
    lines.push(`SELECT 'CREATE ROLE ${role} LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}')\\gexec`);
    lines.push(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${sqlLiteral(passwords[role])};`);
  }
  lines.push(
    `SELECT 'CREATE DATABASE ${APP_DATABASE} OWNER app_rw' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${APP_DATABASE}')\\gexec`,
    `REVOKE ALL ON DATABASE ${APP_DATABASE} FROM PUBLIC;`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${APP_DATABASE} TO app_rw;`,
    `GRANT CONNECT ON DATABASE ${APP_DATABASE} TO cms_ro, cms_rw;`,
    `\\connect ${APP_DATABASE}`,
    ...cmsGrantsSql(),
  );
  return `${lines.join("\n")}\n`;
}

function cmsGrantsSql(): string[] {
  return [
    "ALTER SCHEMA public OWNER TO app_rw;",
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
    "GRANT USAGE ON SCHEMA public TO cms_ro, cms_rw;",
    "GRANT SELECT ON ALL TABLES IN SCHEMA public TO cms_ro;",
    "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cms_rw;",
    "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_rw;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE app_rw IN SCHEMA public GRANT SELECT ON TABLES TO cms_ro;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE app_rw IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cms_rw;",
    "ALTER DEFAULT PRIVILEGES FOR ROLE app_rw IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cms_rw;",
  ];
}

/** `verify_<runId>` from template0, owned by `app_rw`, same CMS grants as `app`. */
export function createRunDatabaseSql(database: string): string {
  const db = sqlIdent(database);
  return [
    "\\set ON_ERROR_STOP on",
    `SELECT 'CREATE DATABASE ${db} OWNER app_rw TEMPLATE template0' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${db}')\\gexec`,
    `REVOKE ALL ON DATABASE ${db} FROM PUBLIC;`,
    `GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO app_rw;`,
    `GRANT CONNECT ON DATABASE ${db} TO cms_ro, cms_rw;`,
    `\\connect ${db}`,
    ...cmsGrantsSql(),
    "",
  ].join("\n");
}

export function dropRunDatabaseSql(database: string): string {
  return `\\set ON_ERROR_STOP on\nDROP DATABASE IF EXISTS ${sqlIdent(database)} WITH (FORCE);\n`;
}

export function databaseUrl(projectId: string, role: string, password: string, database: string): string {
  return `postgres://${role}:${encodeURIComponent(password)}@${names.dbContainer(projectId)}:5432/${database}`;
}

