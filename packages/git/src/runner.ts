/**
 * The only way `@forja/git` runs git: `execFile` with an argv array, never a shell.
 *
 * Protects:
 * - No shell, ever: arguments are passed verbatim, so a file name cannot inject a command.
 * - Hermetic config: the user's global and system gitconfig are ignored
 *   (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`), hooks are disabled, signing
 *   is off, and the author/committer is always `Forja <forja@localhost>`. Inherited
 *   `GIT_*` variables (e.g. `GIT_DIR` from a hook that runs the tests) are dropped.
 * - `GIT_TERMINAL_PROMPT=0`: git never waits for a password. `GIT_LITERAL_PATHSPECS=1`:
 *   Next.js route folders like `[id]` or `(group)` are file names, never globs.
 * - `safe.directory` is granted on the command line (a protected scope) for the project
 *   root and everything under it, so a checkout owned by another uid (the sandbox runs as
 *   1000, like the engine, but bind mounts may say otherwise) never fails with
 *   "dubious ownership".
 * - Output is bytes; callers decide how to decode. Locale is forced to C so parsed output
 *   never depends on the host language.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { GitError } from "./errors.js";

export const FORJA_AUTHOR_NAME = "Forja";
export const FORJA_AUTHOR_EMAIL = "forja@localhost";

export interface GitRunOptions {
  /** Working directory (a checkout or the bare repo). */
  cwd: string;
  /** Exit codes treated as success (default `[0]`). */
  okExitCodes?: readonly number[];
  /** Milliseconds before the process is killed (default 120 s). */
  timeoutMs?: number;
  /** Max stdout/stderr bytes (default 512 MiB, archives can be large). */
  maxBuffer?: number;
  /** Extra environment (e.g. `GIT_AUTHOR_DATE` in tests). */
  env?: Record<string, string>;
}

export interface GitRunResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitRunnerConfig {
  /** Directories granted `safe.directory` (the project root; `<root>/*` is added too). */
  safeDirectories: readonly string[];
  /** Path of the git binary (default `git` from PATH). */
  gitBinary?: string;
}

/** A small typed runner bound to one project root. */
export class GitRunner {
  private readonly binary: string;
  private readonly configArgs: string[];

  constructor(config: GitRunnerConfig) {
    this.binary = config.gitBinary ?? "git";
    const safe: string[] = [];
    for (const dir of config.safeDirectories) {
      safe.push("-c", `safe.directory=${dir}`, "-c", `safe.directory=${dir.replace(/\/+$/, "")}/*`);
    }
    this.configArgs = [
      ...safe,
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "core.quotePath=false",
      "-c", "core.autocrlf=false",
      "-c", "commit.gpgSign=false",
      "-c", "tag.gpgSign=false",
      "-c", "advice.detachedHead=false",
      "-c", "init.defaultBranch=main",
      "-c", "gc.auto=0",
    ];
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const base: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("GIT_")) continue;
      base[key] = value;
    }
    return {
      ...base,
      LC_ALL: "C",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: FORJA_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: FORJA_AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: FORJA_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: FORJA_AUTHOR_EMAIL,
      ...extra,
    };
  }

  /** Runs `git <args>`; throws `GitError(GIT_FAILED)` on a non-accepted exit code. */
  run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    const ok = options.okExitCodes ?? [0];
    const fullArgs = [...this.configArgs, ...args];
    return new Promise((resolve, reject) => {
      execFile(
        this.binary,
        fullArgs,
        {
          cwd: options.cwd,
          env: this.env(options.env),
          encoding: "buffer",
          maxBuffer: options.maxBuffer ?? 512 * 1024 * 1024,
          timeout: options.timeoutMs ?? 120_000,
          killSignal: "SIGKILL",
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const stderrText = Buffer.from(stderr).toString("utf8");
          let exitCode: number | null = 0;
          if (error) {
            const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
            exitCode = typeof code === "number" ? code : null;
          }
          if (exitCode !== null && ok.includes(exitCode)) {
            resolve({ exitCode, stdout: Buffer.from(stdout), stderr: stderrText });
            return;
          }
          reject(
            new GitError("GIT_FAILED", `git ${args[0] ?? ""} failed: ${stderrText.trim() || error?.message || "unknown error"}`, {
              args,
              exitCode,
              stderr: stderrText.slice(0, 4000),
            }),
          );
        },
      );
    });
  }

  /** Runs git and returns trimmed UTF-8 stdout. */
  async text(args: readonly string[], options: GitRunOptions): Promise<string> {
    const result = await this.run(args, options);
    return result.stdout.toString("utf8").trim();
  }

  /** Spawns git with piped stdout for streaming output (e.g. `git archive`). */
  spawn(args: readonly string[], cwd: string): ChildProcess {
    return spawn(this.binary, [...this.configArgs, ...args], {
      cwd,
      env: this.env(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }
}
