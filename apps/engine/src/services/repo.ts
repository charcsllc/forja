/**
 * `RepoPort` over `@forja/git`'s `ProjectRepo` for `/data/projects/<id>`.
 *
 * Adds the two read-only queries the engine needs (resolve a version id, list the files a
 * range of commits touched) through the same hermetic `GitRunner` the package uses.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { GitRunner, ProjectRepo, type WriteFileOptions } from "@forja/git";
import type { Logger } from "../logger.js";
import type { RepoPort } from "./context.js";

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/^~-]{0,199}$/;

/** A path argument after `--`: relative, no `..`, no NUL. */
function safePathArg(p: string): string {
  const v = p.trim().replace(/^\.\//, "");
  if (!v || v.startsWith("/") || v.includes("\0") || v.split("/").includes("..")) throw new Error(`invalid path: ${p}`);
  return v;
}

export function projectRoot(dataDir: string, projectId: string): string {
  return path.join(dataDir, "projects", projectId);
}

export class GitProjectRepo implements RepoPort {
  readonly root: string;
  private readonly repo: ProjectRepo;
  private readonly git: GitRunner;

  constructor(dataDir: string, projectId: string, logger?: Pick<Logger, "error">) {
    this.root = projectRoot(dataDir, projectId);
    this.repo = new ProjectRepo(this.root, {
      onBackgroundError: (err) => logger?.error({ err, projectId }, "coalesced commit failed"),
    });
    this.git = new GitRunner({ safeDirectories: [this.root] });
  }

  private get repoDir(): string {
    return path.join(this.root, "repo.git");
  }

  async exists(): Promise<boolean> {
    const s = await stat(path.join(this.root, "work", ".git")).catch(() => null);
    return s !== null;
  }

  initFromTemplate(templateDir: string) {
    return this.repo.initFromTemplate(templateDir);
  }

  headSha() {
    return this.repo.headSha("work");
  }

  async resolve(ref: string): Promise<string | null> {
    if (!REF_RE.test(ref) || ref.includes("..")) return null;
    const out = await this.git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
      cwd: this.repoDir,
      okExitCodes: [0, 1, 128],
    });
    const sha = out.stdout.toString("utf8").trim();
    return out.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  }

  tree(opts: { path?: string; limit?: number; offset?: number }) {
    return this.repo.tree({ checkout: "work", ...opts });
  }

  readFile(p: string) {
    return this.repo.readFile(p, { checkout: "work" });
  }

  writeFile(p: string, bytes: Uint8Array, opts: WriteFileOptions) {
    return this.repo.writeFile(p, bytes, { ...opts, checkout: "work" });
  }

  flush() {
    return this.repo.flush();
  }

  log(opts: { limit?: number; skip?: number }) {
    return this.repo.log(opts);
  }

  diff(ref: string) {
    return this.repo.diff(ref);
  }

  restore(ref: string) {
    return this.repo.restore(ref);
  }

  filesCount(ref?: string) {
    return this.repo.filesCount(ref);
  }

  archiveStream(ref?: string) {
    return this.repo.archiveStream(ref);
  }

  lockfileChanged(from: string, to: string) {
    return this.repo.lockfileChanged(from, to);
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  ensureRunCheckout(runId: string) {
    return this.repo.ensureRunCheckout(runId);
  }

  removeRunCheckout(runId: string, opts?: { deleteBranch?: boolean }) {
    return this.repo.removeRunCheckout(runId, opts);
  }

  async commitRun(message: string): Promise<string | null> {
    return (await this.repo.commitAll("run", message))?.commitSha ?? null;
  }

  mergeRun(runId: string, opts?: { message?: string }) {
    return this.repo.mergeRun(runId, opts);
  }

  async runDiff({ from, to, path: sub }: { from: string; to?: string; path?: string }): Promise<string> {
    for (const ref of [from, to]) if (ref !== undefined && (!REF_RE.test(ref) || ref.includes(".."))) throw new Error(`invalid ref: ${ref}`);
    const pathArgs = sub ? ["--", safePathArg(sub)] : [];
    if (to) {
      const out = await this.git.run(["diff", "--no-color", "--end-of-options", from, to, ...pathArgs], { cwd: this.repoDir });
      return out.stdout.toString("utf8");
    }
    const runDir = path.join(this.root, "run");
    // Untracked files only show up in a diff once staged; commits stage everything anyway.
    await this.git.run(["add", "-A"], { cwd: runDir });
    const out = await this.git.run(["diff", "--no-color", "--cached", "--end-of-options", from, ...pathArgs], { cwd: runDir });
    return out.stdout.toString("utf8");
  }

  async logText({ limit, path: sub }: { limit: number; path?: string }): Promise<string> {
    await this.repo.flush();
    const n = Math.min(Math.max(1, Math.floor(limit)), 200);
    const out = await this.git.run(
      ["log", "--first-parent", `--max-count=${n}`, "--format=%h %cs %s", "main", ...(sub ? ["--", safePathArg(sub)] : [])],
      { cwd: this.repoDir },
    );
    return out.stdout.toString("utf8");
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    await this.repo.flush();
    const out = await this.git.run(["diff", "--name-only", "-z", "--no-renames", from, to], { cwd: this.repoDir });
    return out.stdout.toString("utf8").split("\0").filter(Boolean);
  }
}
