/**
 * What every engine service and route receives: configuration, the store, and the ports to
 * the outside world (Docker sandboxes, git repositories, the job queue, the CMS).
 *
 * Protects: services depend on these narrow interfaces, never on dockerode, pg-boss or the
 * filesystem layout directly, so unit tests swap in fakes (`test/fakes.ts`) and the real
 * implementations (`SandboxManager`, `GitProjectRepo`, pg-boss) stay in `index.ts`.
 */
import type { AgentServerStatus } from "@forja/contracts/v1";
import type {
  ContainerState,
  DockerApi,
  ExecOptions,
  ExecResult,
  HostPathCheckResult,
  HttpProbe,
  LogsOptions,
  ProvisionOptions,
  ProvisionResult,
  VerifyOptions,
  VerifyResult,
  WaitHttpOptions,
  WaitHttpResult,
} from "@forja/sandbox";
import type { Readable } from "node:stream";
import type { FileContent, FileTree } from "@forja/contracts/v1";
import type { DiffResult, InitResult, LogResult, MergeResult, RestoreResult, RunCheckout, WriteFileOptions, WriteFileResult } from "@forja/git";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Store } from "../store/types.js";
import type { SecretsService } from "./secrets.js";
import type { CmsPort } from "./cms.js";
import type { ImageSourcingPort } from "@forja/contracts/media";
import type { SettingsService } from "./settings.js";
import type { LlmService } from "./llm.js";
import type { RunEnvironmentFactory } from "./runs/environment.js";

/** The slice of `SandboxManager` the engine uses. */
export interface SandboxPort {
  provision(projectId: string, options?: ProvisionOptions): Promise<ProvisionResult>;
  restart(projectId: string): Promise<void>;
  unarchive(projectId: string): Promise<void>;
  archive(projectId: string): Promise<void>;
  remove(projectId: string): Promise<void>;
  status(projectId: string): Promise<AgentServerStatus | null>;
  exec(container: string, argv: readonly string[], options?: ExecOptions): Promise<ExecResult>;
  logs(container: string, options?: LogsOptions): Promise<string>;
  waitHttpReady(container: string, path?: string, timeoutSec?: number, options?: WaitHttpOptions): Promise<WaitHttpResult>;
  hostPathCheck(): Promise<HostPathCheckResult>;
  /** Phase 2: the run's `verify_<runId>` database and `forja-verify-<id>` on `run/` (04 §1, §9). */
  createVerify(projectId: string, runId: string, options: VerifyOptions): Promise<VerifyResult>;
  destroyVerify(projectId: string, runId: string): Promise<void>;
  readonly docker: Pick<
    DockerApi,
    "inspectNetwork" | "createNetwork" | "connectNetwork" | "disconnectNetwork" | "inspectContainer" | "exec"
  >;
}

/** One project's repository (`ProjectRepo` plus the two queries the engine adds). */
export interface RepoPort {
  readonly root: string;
  exists(): Promise<boolean>;
  initFromTemplate(templateDir: string): Promise<InitResult>;
  headSha(): Promise<string | null>;
  /** Full sha of a version id (sha, abbreviated sha or `v<N>` tag); null when unknown. */
  resolve(ref: string): Promise<string | null>;
  tree(opts: { path?: string; limit?: number; offset?: number }): Promise<FileTree>;
  readFile(path: string): Promise<FileContent>;
  writeFile(path: string, bytes: Uint8Array, opts: WriteFileOptions): Promise<WriteFileResult>;
  flush(): Promise<string | null>;
  log(opts: { limit?: number; skip?: number }): Promise<LogResult>;
  diff(ref: string): Promise<DiffResult>;
  restore(ref: string): Promise<RestoreResult>;
  filesCount(ref?: string): Promise<number>;
  archiveStream(ref?: string): Promise<{ commitSha: string; stream: Readable }>;
  lockfileChanged(from: string, to: string): Promise<boolean>;
  /** Paths that differ between two commits (`git diff --name-only`). */
  changedFiles(from: string, to: string): Promise<string[]>;

  // ── Runs (phase 2, 04 §1, §6): branch `run/<runId>` checked out at `run/` ──
  ensureRunCheckout(runId: string): Promise<RunCheckout>;
  removeRunCheckout(runId: string, opts?: { deleteBranch?: boolean }): Promise<void>;
  /** Commits everything in `run/`; null when there was nothing to commit. */
  commitRun(message: string): Promise<string | null>;
  /** `git merge --no-ff run/<runId>` into main + tag `v<N>`. */
  mergeRun(runId: string, opts?: { message?: string }): Promise<MergeResult>;
  /** Unified diff of `run/` (working tree) against `from`, optionally one path; `to` compares two refs. */
  runDiff(opts: { from: string; to?: string; path?: string }): Promise<string>;
  /** `git log --oneline`-style history of main (newest first). */
  logText(opts: { limit: number; path?: string }): Promise<string>;
}

export const JOB_NAMES = [
  "sandbox.provision",
  "sandbox.wake",
  "sandbox.restart",
  "sandbox.rebuild",
  "sandbox.archive",
  "sandbox.remove",
  "version.restore",
  "run.execute",
] as const;
export type JobName = (typeof JOB_NAMES)[number];

export interface JobData {
  projectId: string;
  /** The operation slot token the job belongs to. */
  token: string;
  [key: string]: unknown;
}

export interface QueuePort {
  send(name: JobName, data: JobData): Promise<void>;
}

export type EngineConfig = Pick<
  Config,
  | "DATA_DIR"
  | "TEMPLATE_DIR"
  | "RUNNER_IMAGE"
  | "PREVIEW_DOMAIN"
  | "PREVIEW_TLS"
  | "PUBLISH_DOMAIN"
  | "PUBLISH_TLS"
  | "WEB_PUBLIC_URL"
  | "UPLOAD_MAX_MB"
  | "SANDBOX_START_TIMEOUT_SEC"
  | "PROJECT_PURGE_AFTER_DAYS"
  | "ALLOW_ENV_EXPORT"
  | "SANDBOX_DRIVER"
  | "BUDGET_PER_RUN_USD"
  | "BUDGET_PER_PROJECT_MONTH_USD"
  | "BUDGET_GLOBAL_MONTH_USD"
  | "ENGINE_MAX_CONCURRENT_RUNS"
>;

export interface EngineContext {
  config: EngineConfig;
  store: Store;
  logger: Logger;
  masterKey: string;
  secrets: SecretsService;
  sandbox: SandboxPort;
  repo(projectId: string): RepoPort;
  queue: QueuePort;
  cms: CmsPort;
  /** Instance settings the UI can change (`/v2/system/settings`). */
  settings: SettingsService;
  /** Image sourcing for the `image_find` tool (`@forja/media`; strategy from `settings` + env). */
  imageSourcing: ImageSourcingPort;
  /** The LLM gateway and agent settings (phase 2, `services/llm.ts`). */
  llm: LlmService;
  /** Per-run infrastructure (run checkout, verify container); tests inject a fake. */
  runEnvironments?: RunEnvironmentFactory;
  /** The engine's own container (name or id) to attach to project networks; null = not in Docker. */
  selfContainer: string | null;
  /** Readiness probe for app containers (networkProbe over forja-apps in production). */
  probe?: HttpProbe;
  /** Poll interval of readiness waits (tests shorten it). */
  readyIntervalMs?: number;
  /** Origin the preview proxy forwards to; default `http://forja-app-<id>:3000` (tests override). */
  previewOrigin?: (projectId: string, target: "app" | "verify") => string;
}

export type { ContainerState };
