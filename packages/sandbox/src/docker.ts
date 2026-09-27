/**
 * The narrow Docker surface the sandbox manager needs, and its dockerode implementation.
 *
 * Protects:
 * - `SandboxManager` depends on `DockerApi`, never on dockerode directly, so unit tests
 *   inject a fake and assert the exact specs sent to Docker.
 * - The connection comes from `DOCKER_HOST` (`tcp://socket-proxy:2375` in the stack,
 *   `unix:///...` or unset → the local socket in dev/tests). No TLS material is read here.
 * - `exec` never wraps argv in a shell: what the caller passes is what runs. Output is
 *   demultiplexed (stdout/stderr), capped at `maxOutputBytes` per stream, and bounded in
 *   time twice: a `timeout -s KILL` wrapper inside the container (busybox and coreutils
 *   both have it) and a client-side timer that abandons the stream.
 * - "Not found" is a value (`null` / `false`), not an exception, so idempotent
 *   provision/cleanup code stays linear.
 */
import Docker from "dockerode";
import { PassThrough, type Duplex, type Readable } from "node:stream";

// ── Spec types (the subset of the Engine API create bodies Forja uses) ─────────

export interface MountSpec {
  Type: "bind" | "volume" | "tmpfs";
  Source?: string;
  Target: string;
  ReadOnly?: boolean;
  TmpfsOptions?: { SizeBytes?: number; Mode?: number; Options?: string[][] };
}

export interface HealthcheckSpec {
  Test: string[];
  Interval?: number;
  Timeout?: number;
  Retries?: number;
  StartPeriod?: number;
  StartInterval?: number;
}

export interface HostConfigSpec {
  Mounts?: MountSpec[];
  Tmpfs?: Record<string, string>;
  ReadonlyRootfs?: boolean;
  CapDrop?: string[];
  CapAdd?: string[];
  SecurityOpt?: string[];
  Privileged?: boolean;
  PidsLimit?: number;
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  Ulimits?: { Name: string; Soft: number; Hard: number }[];
  NetworkMode?: string;
  Runtime?: string;
  RestartPolicy?: { Name: "no" | "always" | "unless-stopped" | "on-failure"; MaximumRetryCount?: number };
  LogConfig?: { Type: string; Config: Record<string, string> };
  ShmSize?: number;
  Init?: boolean;
  AutoRemove?: boolean;
}

export interface ContainerSpec {
  name: string;
  Image: string;
  Cmd?: string[];
  Entrypoint?: string[];
  User?: string;
  WorkingDir?: string;
  Env?: string[];
  Labels?: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  Healthcheck?: HealthcheckSpec;
  StopSignal?: string;
  StopTimeout?: number;
  HostConfig: HostConfigSpec;
  NetworkingConfig?: { EndpointsConfig: Record<string, { Aliases?: string[] }> };
}

export interface NetworkSpec {
  Name: string;
  Driver: "bridge";
  Internal: boolean;
  Labels: Record<string, string>;
  Options: Record<string, string>;
}

export interface ContainerState {
  id: string;
  name: string;
  status: "created" | "running" | "paused" | "restarting" | "removing" | "exited" | "dead" | string;
  running: boolean;
  exitCode: number | null;
  health: "starting" | "healthy" | "unhealthy" | null;
  labels: Record<string, string>;
  networks: string[];
  image: string;
  /** The create body as Docker stored it (for assertions and drift checks). */
  hostConfig: Record<string, unknown>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  user?: string;
  timeoutSec?: number;
  maxOutputBytes?: number;
  /** Bytes written to the process stdin, then closed. */
  stdin?: string | Uint8Array;
  /** Wrap argv in `timeout -s KILL <sec>` inside the container (default true). */
  killInContainer?: boolean;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface LogsOptions {
  /** Unix seconds or an ISO date. */
  since?: number | string;
  tail?: number;
  timestamps?: boolean;
}

export interface DockerApi {
  inspectNetwork(name: string): Promise<{ id: string; name: string; internal: boolean; labels: Record<string, string>; options: Record<string, string> } | null>;
  createNetwork(spec: NetworkSpec): Promise<void>;
  removeNetwork(name: string): Promise<boolean>;
  connectNetwork(network: string, container: string, aliases?: string[]): Promise<void>;
  disconnectNetwork(network: string, container: string): Promise<boolean>;
  volumeExists(name: string): Promise<boolean>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<boolean>;
  imageExists(image: string): Promise<boolean>;
  inspectContainer(name: string): Promise<ContainerState | null>;
  createContainer(spec: ContainerSpec): Promise<void>;
  startContainer(name: string): Promise<void>;
  stopContainer(name: string, timeoutSec?: number): Promise<void>;
  restartContainer(name: string, timeoutSec?: number): Promise<void>;
  removeContainer(name: string, options?: { force?: boolean; volumes?: boolean }): Promise<boolean>;
  waitContainer(name: string): Promise<number>;
  listContainers(labels: Record<string, string>): Promise<ContainerState[]>;
  exec(container: string, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  logs(container: string, options?: LogsOptions): Promise<string>;
}

// ── Connection ────────────────────────────────────────────────────────────────

/** Builds dockerode options from `DOCKER_HOST` (tcp:// or unix://), else the local socket. */
export function dockerOptionsFromEnv(env: Record<string, string | undefined> = process.env): Docker.DockerOptions {
  const host = env.DOCKER_HOST?.trim();
  if (!host) return { socketPath: "/var/run/docker.sock" };
  if (host.startsWith("unix://")) return { socketPath: host.slice("unix://".length) };
  if (host.startsWith("tcp://") || host.startsWith("http://")) {
    const url = new URL(host.replace(/^tcp:/, "http:"));
    return { host: url.hostname, port: Number(url.port || 2375), protocol: "http" };
  }
  throw new Error(`Unsupported DOCKER_HOST: ${host}`);
}

// ── Stream helpers ────────────────────────────────────────────────────────────

/** Collects bytes up to a cap, remembering whether anything was dropped. */
export class CappedBuffer {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    const room = this.cap - this.size;
    if (room <= 0) {
      if (chunk.length > 0) this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size += room;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Splits Docker's multiplexed stream format (8-byte headers: stream type, 3 zero bytes,
 * big-endian length) held in one buffer. Non-multiplexed input (TTY) is returned as stdout.
 */
export function demuxBuffer(buffer: Buffer): { stdout: Buffer; stderr: Buffer; combined: Buffer } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const combined: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const type = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);
    if ((type !== 0 && type !== 1 && type !== 2) || buffer[offset + 1] !== 0 || offset + 8 + length > buffer.length) {
      if (offset === 0) return { stdout: buffer, stderr: Buffer.alloc(0), combined: buffer };
      break;
    }
    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    (type === 2 ? stderr : stdout).push(payload);
    combined.push(payload);
    offset += 8 + length;
  }
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), combined: Buffer.concat(combined) };
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { statusCode?: number }).statusCode === 404;
}

function isStatus(error: unknown, ...codes: number[]): boolean {
  const code = typeof error === "object" && error !== null ? (error as { statusCode?: number }).statusCode : undefined;
  return code !== undefined && codes.includes(code);
}

function toState(info: Docker.ContainerInspectInfo): ContainerState {
  const health = (info.State as { Health?: { Status?: string } }).Health?.Status;
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ""),
    status: info.State.Status,
    running: info.State.Running,
    exitCode: typeof info.State.ExitCode === "number" ? info.State.ExitCode : null,
    health: health === "starting" || health === "healthy" || health === "unhealthy" ? health : null,
    labels: info.Config.Labels ?? {},
    networks: Object.keys(info.NetworkSettings.Networks ?? {}),
    image: info.Config.Image,
    hostConfig: info.HostConfig as unknown as Record<string, unknown>,
  };
}

// ── dockerode implementation ──────────────────────────────────────────────────

export class DockerodeApi implements DockerApi {
  readonly docker: Docker;

  constructor(docker: Docker = new Docker(dockerOptionsFromEnv())) {
    this.docker = docker;
  }

  async inspectNetwork(name: string) {
    try {
      const info = (await this.docker.getNetwork(name).inspect()) as {
        Id: string;
        Name: string;
        Internal?: boolean;
        Labels?: Record<string, string> | null;
        Options?: Record<string, string> | null;
      };
      return { id: info.Id, name: info.Name, internal: info.Internal === true, labels: info.Labels ?? {}, options: info.Options ?? {} };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async createNetwork(spec: NetworkSpec): Promise<void> {
    await this.docker.createNetwork({ ...spec, CheckDuplicate: true });
  }

  async removeNetwork(name: string): Promise<boolean> {
    try {
      await this.docker.getNetwork(name).remove();
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async connectNetwork(network: string, container: string, aliases?: string[]): Promise<void> {
    try {
      await this.docker.getNetwork(network).connect({ Container: container, EndpointConfig: aliases ? { Aliases: aliases } : {} });
    } catch (error) {
      // 403 "already exists in network" / 409: idempotent.
      if (isStatus(error, 403, 409) && /already exists|already attached/i.test(String((error as Error).message))) return;
      throw error;
    }
  }

  async disconnectNetwork(network: string, container: string): Promise<boolean> {
    try {
      await this.docker.getNetwork(network).disconnect({ Container: container, Force: true });
      return true;
    } catch (error) {
      if (isStatus(error, 404, 403)) return false;
      throw error;
    }
  }

  async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    await this.docker.createVolume({ Name: name, Labels: labels });
  }

  async removeVolume(name: string): Promise<boolean> {
    try {
      await this.docker.getVolume(name).remove();
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async imageExists(image: string): Promise<boolean> {
    try {
      await this.docker.getImage(image).inspect();
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async inspectContainer(name: string): Promise<ContainerState | null> {
    try {
      return toState(await this.docker.getContainer(name).inspect());
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async createContainer(spec: ContainerSpec): Promise<void> {
    await this.docker.createContainer(spec as unknown as Docker.ContainerCreateOptions);
  }

  async startContainer(name: string): Promise<void> {
    try {
      await this.docker.getContainer(name).start();
    } catch (error) {
      if (isStatus(error, 304)) return; // already started
      throw error;
    }
  }

  async stopContainer(name: string, timeoutSec = 10): Promise<void> {
    try {
      await this.docker.getContainer(name).stop({ t: timeoutSec });
    } catch (error) {
      if (isStatus(error, 304, 404)) return; // already stopped / gone
      throw error;
    }
  }

  async restartContainer(name: string, timeoutSec = 10): Promise<void> {
    await this.docker.getContainer(name).restart({ t: timeoutSec });
  }

  async removeContainer(name: string, { force = true, volumes = false }: { force?: boolean; volumes?: boolean } = {}): Promise<boolean> {
    try {
      await this.docker.getContainer(name).remove({ force, v: volumes });
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      if (isStatus(error, 409) && /already in progress/i.test(String((error as Error).message))) return true;
      throw error;
    }
  }

  async waitContainer(name: string): Promise<number> {
    const result = (await this.docker.getContainer(name).wait()) as { StatusCode?: number };
    return result.StatusCode ?? -1;
  }

  async listContainers(labels: Record<string, string>): Promise<ContainerState[]> {
    const filters = { label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) };
    const list = await this.docker.listContainers({ all: true, filters });
    const states: ContainerState[] = [];
    for (const item of list) {
      const state = await this.inspectContainer(item.Id);
      if (state) states.push(state);
    }
    return states;
  }

  async exec(container: string, argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
    if (argv.length === 0) throw new Error("exec needs a command");
    const started = Date.now();
    const timeoutSec = options.timeoutSec ?? 60;
    const cap = options.maxOutputBytes ?? 1024 * 1024;
    const cmd = options.killInContainer === false ? [...argv] : ["timeout", "-s", "KILL", String(Math.max(1, Math.ceil(timeoutSec))), ...argv];
    const withStdin = options.stdin !== undefined;
    const exec = await this.docker.getContainer(container).exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: withStdin,
      Tty: false,
      WorkingDir: options.cwd,
      User: options.user,
      Env: options.env ? Object.entries(options.env).map(([k, v]) => `${k}=${v}`) : undefined,
    });
    const stream = (await exec.start({ hijack: true, stdin: withStdin })) as Duplex;
    const out = new CappedBuffer(cap);
    const err = new CappedBuffer(cap);
    const stdoutSink = new PassThrough();
    const stderrSink = new PassThrough();
    stdoutSink.on("data", (chunk: Buffer) => out.push(chunk));
    stderrSink.on("data", (chunk: Buffer) => err.push(chunk));
    this.docker.modem.demuxStream(stream, stdoutSink, stderrSink);
    if (withStdin && options.stdin !== undefined) {
      stream.write(Buffer.from(options.stdin));
      stream.end();
    }

    let timedOut = false;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        stream.destroy();
        resolve();
      }, timeoutSec * 1000 + 2000);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      stream.on("end", done);
      stream.on("close", done);
      stream.on("error", done);
    });

    let exitCode: number | null = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const info = await exec.inspect();
      if (!info.Running) {
        exitCode = typeof info.ExitCode === "number" ? info.ExitCode : null;
        break;
      }
      if (timedOut) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const durationMs = Date.now() - started;
    if (!timedOut && options.killInContainer !== false && exitCode === 137 && durationMs >= timeoutSec * 1000 - 250) timedOut = true;
    return {
      exitCode,
      stdout: out.toString(),
      stderr: err.toString(),
      truncated: out.truncated || err.truncated,
      timedOut,
      durationMs,
    };
  }

  async logs(container: string, { since, tail, timestamps = false }: LogsOptions = {}): Promise<string> {
    const sinceValue = typeof since === "string" ? Math.floor(new Date(since).getTime() / 1000) : since;
    const info = await this.docker.getContainer(container).inspect();
    const raw = (await this.docker.getContainer(container).logs({
      stdout: true,
      stderr: true,
      follow: false,
      timestamps,
      ...(sinceValue !== undefined && Number.isFinite(sinceValue) ? { since: sinceValue } : {}),
      ...(tail !== undefined ? { tail } : {}),
    })) as unknown as Buffer | Readable;
    const buffer = Buffer.isBuffer(raw) ? raw : await streamToBuffer(raw);
    if (info.Config.Tty) return buffer.toString("utf8");
    // Frames in arrival order: stdout and stderr stay interleaved as the app wrote them.
    return demuxBuffer(buffer).combined.toString("utf8");
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}
