/**
 * `ProjectRepo`: one project's git repository, laid out as in 04 §1.
 *
 *   <root>/repo.git   bare repository, the source of truth
 *   <root>/work/      worktree of `main`        (mounted in forja-app-<id>)
 *   <root>/run/       worktree of `run/<runId>` (mounted in forja-verify-<id>, one run at a time)
 *
 * What this file protects:
 * - History only moves forward. `restore` = `read-tree -u --reset <sha>` + a new commit
 *   "restore v<N> (from v<M>)"; nothing is ever rewritten, and it works across the
 *   `--no-ff` merge commits that close runs (04 §6).
 * - Every commit on `main` made here gets the next `v<N>` tag (init = v1, merges, restores,
 *   manual edits). `log()` walks `main` with `--first-parent`, so a run is one version.
 * - Manual writes from the same `clientId` within `coalesceWindowMs` (3 s) become ONE
 *   commit: a per-repo debounce commits on flush (visual-edit writes up to 200 files as
 *   one version, not 200). Any other operation that reads history flushes first.
 * - `STALE_WRITE` when `baseCommitSha` is not HEAD, except for the sha this client was
 *   handed before its own coalesced commit landed (a tab never goes stale on itself).
 * - Scratch paths (`.forja/**`, `.totalum/**`) are written byte-exact but never
 *   committed; the visual editor's canary reads back what it wrote.
 * - All mutations of one repo are serialized by a per-root mutex shared by every
 *   `ProjectRepo` instance pointing at the same root.
 */
import { constants as fsConstants } from "node:fs";
import { cp, lstat, mkdir, open, readdir, readFile as fsReadFile, rm, stat, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { FileContent, FileTree, FileTreeEntry } from "@forja/contracts/v1";
import { GitError } from "./errors.js";
import {
  INFO_EXCLUDE_LINES,
  LOCKFILES,
  TEMPLATE_COPY_EXCLUDED,
  TREE_EXCLUDED_NAMES,
  confinePath,
  isEnvName,
  isRebuildRequiredPath,
  isScratchPath,
  normalizeRelPath,
} from "./paths.js";
import { GitRunner } from "./runner.js";

export type CheckoutName = "work" | "run";

export const DEFAULT_COALESCE_WINDOW_MS = 3_000;
export const DEFAULT_COALESCE_MAX_MS = 15_000;
export const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
export const DEFAULT_WRITE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_TREE_LIMIT = 5_000;
export const MAX_TREE_LIMIT = 10_000;
/** Hard ceiling on entries walked by `tree()` (defends against pathological checkouts). */
export const MAX_TREE_WALK = 200_000;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/^~-]{0,199}$/;
const BINARY_SNIFF_BYTES = 8 * 1024;

export interface ProjectRepoOptions {
  /** Debounce for coalesced writes (default 3 s). */
  coalesceWindowMs?: number;
  /** A coalesced commit never waits longer than this after its first write (default 15 s). */
  coalesceMaxMs?: number;
  /** Called when a background (timer) flush fails. */
  onBackgroundError?: (error: unknown) => void;
  gitBinary?: string;
}

export interface InitResult {
  commitSha: string;
  tag: string;
}

export interface RunCheckout {
  runId: string;
  branch: string;
  path: string;
  headSha: string;
}

export interface CommitResult {
  commitSha: string;
  tag: string | null;
  version: number | null;
}

export interface MergeResult extends CommitResult {
  /** False when the run branch had nothing new ("Already up to date"). */
  merged: boolean;
}

export interface RestoreResult extends CommitResult {
  /** False when the target tree equals HEAD (no commit, no tag). */
  changed: boolean;
  restoredFromSha: string;
}

export interface TreeOptions {
  checkout?: CheckoutName;
  path?: string;
  limit?: number;
  offset?: number;
}

export interface ReadFileOptions {
  checkout?: CheckoutName;
  maxBytes?: number;
}

export interface WriteFileOptions {
  checkout?: CheckoutName;
  /** `STALE_WRITE` when this is not HEAD of the checkout. */
  baseCommitSha?: string;
  /** Writes from the same client within the window coalesce into one commit. */
  clientId?: string;
  /** Default true on `work`. False commits now and returns the new sha. */
  coalesce?: boolean;
  /** Default true on `work`, false on `run` (runs commit per task with `commitAll`). */
  commit?: boolean;
  /** Commit message (first message of a coalesced batch wins). */
  message?: string;
  maxBytes?: number;
}

export interface WriteFileResult {
  path: string;
  /** Exactly `bytes.byteLength`. */
  bytesWritten: number;
  created: boolean;
  /** HEAD after the write: the new commit, or the unchanged HEAD while a commit is pending. */
  commitSha?: string;
  rebuildRequired: boolean;
  /** True when this call produced (or joined, then flushed) a commit. */
  committed: boolean;
  /** True when the commit is waiting for the coalescing window to close. */
  pending: boolean;
}

export interface VersionEntry {
  commitSha: string;
  parentSha: string | null;
  parentShas: string[];
  tag: string | null;
  version: number | null;
  message: string;
  body: string;
  createdAt: string;
  isMerge: boolean;
  /** From the `Forja-Run:` trailer of run merges. */
  runId: string | null;
  /** From the `Forja-Restored-From:` trailer of restores. */
  restoredFromSha: string | null;
}

export interface LogResult {
  versions: VersionEntry[];
  totalCount: number;
}

export interface DiffResult {
  commitSha: string;
  parentSha: string | null;
  diff: string;
}

interface PendingCommit {
  clientId: string;
  paths: Set<string>;
  baseSha: string | null;
  message: string | null;
  firstAt: number;
  timer: NodeJS.Timeout | null;
}

interface RepoState {
  queue: Promise<unknown>;
  pending: PendingCommit | null;
  /** clientId → the sha it was handed before its coalesced commit, and that commit. */
  aliases: Map<string, { handedOut: string | null; actual: string }>;
}

const STATES = new Map<string, RepoState>();

function stateFor(root: string): RepoState {
  let state = STATES.get(root);
  if (!state) {
    state = { queue: Promise.resolve(), pending: null, aliases: new Map() };
    STATES.set(root, state);
  }
  return state;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function looksBinary(buffer: Buffer): boolean {
  const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    // Not valid UTF-8: base64 keeps it byte-exact.
    return true;
  }
}

function parseVersionTag(tag: string): number | null {
  const match = /^v(\d{1,9})$/.exec(tag);
  return match?.[1] ? Number(match[1]) : null;
}

function trailer(body: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  return re.exec(body)?.[1]?.trim() ?? null;
}

export class ProjectRepo {
  readonly root: string;
  readonly repoDir: string;
  readonly workDir: string;
  readonly runDir: string;
  private readonly git: GitRunner;
  private readonly state: RepoState;
  private readonly coalesceWindowMs: number;
  private readonly coalesceMaxMs: number;
  private readonly onBackgroundError: (error: unknown) => void;

  /** `root` is `/data/projects/<id>` (absolute). */
  constructor(root: string, options: ProjectRepoOptions = {}) {
    if (!path.isAbsolute(root)) throw new GitError("INVALID_PATH", "Project root must be absolute.", { path: root });
    this.root = path.resolve(root);
    this.repoDir = path.join(this.root, "repo.git");
    this.workDir = path.join(this.root, "work");
    this.runDir = path.join(this.root, "run");
    this.git = new GitRunner({ safeDirectories: [this.root], gitBinary: options.gitBinary });
    this.state = stateFor(this.root);
    this.coalesceWindowMs = options.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.coalesceMaxMs = options.coalesceMaxMs ?? DEFAULT_COALESCE_MAX_MS;
    this.onBackgroundError = options.onBackgroundError ?? (() => undefined);
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.state.queue.then(fn, fn);
    this.state.queue = next.catch(() => undefined);
    return next;
  }

  private checkoutDir(checkout: CheckoutName): string {
    return checkout === "work" ? this.workDir : this.runDir;
  }

  private async requireCheckout(checkout: CheckoutName): Promise<string> {
    const dir = this.checkoutDir(checkout);
    if (!(await pathExists(path.join(dir, ".git")))) {
      throw new GitError("INVALID_STATE", `The ${checkout} checkout does not exist.`, { path: dir });
    }
    return dir;
  }

  /** HEAD of a checkout, or null before the first commit. */
  async headSha(checkout: CheckoutName = "work"): Promise<string | null> {
    const dir = await this.requireCheckout(checkout);
    const result = await this.git.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: dir, okExitCodes: [0, 1] });
    const sha = result.stdout.toString("utf8").trim();
    return result.exitCode === 0 && sha ? sha : null;
  }

  private async resolveCommit(ref: string): Promise<string> {
    if (!REF_RE.test(ref) || ref.includes("..")) throw new GitError("NOT_FOUND", `Unknown version: ${ref}`);
    const result = await this.git.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], {
      cwd: this.repoDir,
      okExitCodes: [0, 1, 128],
    });
    const sha = result.stdout.toString("utf8").trim();
    if (result.exitCode !== 0 || !sha) throw new GitError("NOT_FOUND", `Unknown version: ${ref}`);
    return sha;
  }

  /** `v<N>` tags by commit sha (lightweight or annotated). */
  private async tagsBySha(): Promise<Map<string, string[]>> {
    const out = await this.git.text(
      ["for-each-ref", "--format=%(refname:strip=2)%1f%(objectname)%1f%(*objectname)", "refs/tags/"],
      { cwd: this.repoDir },
    );
    const map = new Map<string, string[]>();
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [name = "", object = "", peeled = ""] = line.split("\x1f");
      if (parseVersionTag(name) === null) continue;
      const sha = peeled || object;
      const list = map.get(sha) ?? [];
      list.push(name);
      map.set(sha, list);
    }
    return map;
  }

  private static highestVersion(tags: readonly string[] | undefined): number | null {
    let best: number | null = null;
    for (const tag of tags ?? []) {
      const n = parseVersionTag(tag);
      if (n !== null && (best === null || n > best)) best = n;
    }
    return best;
  }

  private async nextVersion(): Promise<number> {
    const tags = await this.tagsBySha();
    let max = 0;
    for (const list of tags.values()) max = Math.max(max, ProjectRepo.highestVersion(list) ?? 0);
    return max + 1;
  }

  private async versionOf(sha: string): Promise<number | null> {
    return ProjectRepo.highestVersion((await this.tagsBySha()).get(sha));
  }

  private async tagMain(sha: string): Promise<{ tag: string; version: number }> {
    const version = await this.nextVersion();
    const tag = `v${version}`;
    await this.git.run(["tag", tag, sha], { cwd: this.repoDir });
    return { tag, version };
  }

  private async hasStagedChanges(dir: string): Promise<boolean> {
    const result = await this.git.run(["diff", "--cached", "--quiet", "--no-ext-diff"], { cwd: dir, okExitCodes: [0, 1] });
    return result.exitCode === 1;
  }

  private async commitStaged(dir: string, message: string): Promise<string> {
    await this.git.run(["commit", "--quiet", "--no-verify", "-m", message], { cwd: dir });
    return this.git.text(["rev-parse", "HEAD"], { cwd: dir });
  }

  /** Stages `paths` (literal), skipping ones ignored by the project's .gitignore. */
  private async stagePaths(dir: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    // check-ignore takes plain paths, not pathspecs, and refuses the literal magic.
    const ignored = await this.git.run(["check-ignore", "--", ...paths], {
      cwd: dir,
      okExitCodes: [0, 1],
      env: { GIT_LITERAL_PATHSPECS: "0" },
    });
    const skip = new Set(ignored.stdout.toString("utf8").split("\n").filter(Boolean));
    const keep = paths.filter((p) => !skip.has(p));
    if (keep.length > 0) await this.git.run(["add", "-A", "--", ...keep], { cwd: dir });
  }

  // ── Creation ─────────────────────────────────────────────────────────────

  /** Creates `repo.git` + `work/` on `main`, copies the template, commits and tags `v1`. */
  async initFromTemplate(templateDir: string, { message = "Create project from template" }: { message?: string } = {}): Promise<InitResult> {
    return this.withLock(async () => {
      if (await pathExists(this.repoDir)) throw new GitError("INVALID_STATE", "Repository already exists.", { path: this.repoDir });
      const templateStat = await stat(templateDir).catch(() => null);
      if (!templateStat?.isDirectory()) throw new GitError("NOT_FOUND", "Template directory not found.", { path: templateDir });
      await mkdir(this.root, { recursive: true });
      await this.git.run(["init", "--quiet", "--bare", "--initial-branch=main", this.repoDir], { cwd: this.root });
      await mkdir(path.join(this.repoDir, "info"), { recursive: true });
      await fsWriteFile(path.join(this.repoDir, "info", "exclude"), `${INFO_EXCLUDE_LINES.join("\n")}\n`);
      await this.git.run(["worktree", "add", "--quiet", "--orphan", "-b", "main", this.workDir], { cwd: this.repoDir });
      await cp(templateDir, this.workDir, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (source) => {
          const rel = path.relative(templateDir, source);
          if (rel === "") return true;
          return !rel.split(path.sep).some((segment) => TEMPLATE_COPY_EXCLUDED.has(segment));
        },
      });
      await this.git.run(["add", "-A"], { cwd: this.workDir });
      const commitSha = await this.commitStaged(this.workDir, message);
      await this.git.run(["tag", "v1", commitSha], { cwd: this.repoDir });
      return { commitSha, tag: "v1" };
    });
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  private static assertRunId(runId: string): void {
    if (!RUN_ID_RE.test(runId) || runId.includes("..")) throw new GitError("INVALID_PATH", `Invalid run id: ${runId}`);
  }

  private async currentRunBranch(): Promise<string | null> {
    if (!(await pathExists(path.join(this.runDir, ".git")))) return null;
    const result = await this.git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: this.runDir, okExitCodes: [0, 1, 128] });
    return result.exitCode === 0 ? result.stdout.toString("utf8").trim() : null;
  }

  private async branchExists(branch: string): Promise<boolean> {
    const result = await this.git.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: this.repoDir, okExitCodes: [0, 1] });
    return result.exitCode === 0;
  }

  /** Branch `run/<runId>` from `main`, checked out at `run/`. Idempotent for the same run. */
  async ensureRunCheckout(runId: string): Promise<RunCheckout> {
    ProjectRepo.assertRunId(runId);
    const branch = `run/${runId}`;
    return this.withLock(async () => {
      await this.flushLocked();
      await this.git.run(["worktree", "prune"], { cwd: this.repoDir });
      const current = await this.currentRunBranch();
      if (current !== null && current !== branch) {
        throw new GitError("INVALID_STATE", `The run checkout belongs to ${current}.`, { path: this.runDir });
      }
      if (current === null) {
        if (await pathExists(this.runDir)) await rm(this.runDir, { recursive: true, force: true });
        const args = (await this.branchExists(branch))
          ? ["worktree", "add", "--quiet", this.runDir, branch]
          : ["worktree", "add", "--quiet", "-b", branch, this.runDir, "main"];
        await this.git.run(args, { cwd: this.repoDir });
      }
      const headSha = await this.git.text(["rev-parse", "HEAD"], { cwd: this.runDir });
      return { runId, branch, path: this.runDir, headSha };
    });
  }

  /** Removes `run/` (and, by default, the `run/<runId>` branch). */
  async removeRunCheckout(runId: string, { deleteBranch = true }: { deleteBranch?: boolean } = {}): Promise<void> {
    ProjectRepo.assertRunId(runId);
    const branch = `run/${runId}`;
    return this.withLock(async () => {
      const current = await this.currentRunBranch();
      if (current !== null && current !== branch) {
        throw new GitError("INVALID_STATE", `The run checkout belongs to ${current}.`, { path: this.runDir });
      }
      if (current !== null) {
        await this.git.run(["worktree", "remove", "--force", "--force", this.runDir], { cwd: this.repoDir, okExitCodes: [0, 128] });
      }
      await rm(this.runDir, { recursive: true, force: true });
      await this.git.run(["worktree", "prune"], { cwd: this.repoDir });
      if (deleteBranch && (await this.branchExists(branch))) {
        await this.git.run(["branch", "-D", "--quiet", branch], { cwd: this.repoDir });
      }
    });
  }

  /**
   * `git merge --no-ff run/<runId>` into `main` (in `work/`, which refreshes the files the
   * dev server sees), then tag `v<N>`. Uncommitted changes in `run/` are committed first
   * unless `commitPending` is false.
   */
  async mergeRun(
    runId: string,
    { message, commitPending = true }: { message?: string; commitPending?: boolean } = {},
  ): Promise<MergeResult> {
    ProjectRepo.assertRunId(runId);
    const branch = `run/${runId}`;
    return this.withLock(async () => {
      await this.flushLocked();
      if (!(await this.branchExists(branch))) throw new GitError("NOT_FOUND", `Unknown run branch ${branch}.`);
      if (commitPending && (await this.currentRunBranch()) === branch) {
        await this.git.run(["add", "-A"], { cwd: this.runDir });
        if (await this.hasStagedChanges(this.runDir)) await this.commitStaged(this.runDir, `Run ${runId}: final changes`);
      }
      const before = await this.git.text(["rev-parse", "HEAD"], { cwd: this.workDir });
      const text = `${message ?? `Merge run ${runId}`}\n\nForja-Run: ${runId}`;
      try {
        await this.git.run(["merge", "--no-ff", "--no-edit", "--quiet", "-m", text, branch], { cwd: this.workDir });
      } catch (error) {
        await this.git.run(["merge", "--abort"], { cwd: this.workDir, okExitCodes: [0, 1, 128] });
        const stderr = error instanceof GitError ? error.details.stderr : undefined;
        throw new GitError("CONFLICT", `Could not merge ${branch} into main.`, { stderr });
      }
      const after = await this.git.text(["rev-parse", "HEAD"], { cwd: this.workDir });
      if (after === before) return { commitSha: after, tag: null, version: await this.versionOf(after), merged: false };
      const { tag, version } = await this.tagMain(after);
      return { commitSha: after, tag, version, merged: true };
    });
  }

  /** Stages everything in a checkout and commits (tagging on `work`). Null when clean. */
  async commitAll(checkout: CheckoutName, message: string): Promise<CommitResult | null> {
    return this.withLock(async () => {
      if (checkout === "work") await this.flushLocked();
      const dir = await this.requireCheckout(checkout);
      await this.git.run(["add", "-A"], { cwd: dir });
      if (!(await this.hasStagedChanges(dir))) return null;
      const commitSha = await this.commitStaged(dir, message);
      if (checkout !== "work") return { commitSha, tag: null, version: null };
      return { commitSha, ...(await this.tagMain(commitSha)) };
    });
  }

  // ── Files API ────────────────────────────────────────────────────────────

  /** research/02 §1.8 `FileTree`: flat, depth-first, folders first, exclusions applied. */
  async tree({ checkout = "work", path: sub, limit, offset }: TreeOptions = {}): Promise<FileTree> {
    const dir = await this.requireCheckout(checkout);
    const rel = normalizeRelPath(sub ?? "", { allowRoot: true });
    const start = rel ? await confinePath(dir, rel) : dir;
    const startStat = await lstat(start).catch(() => null);
    if (!startStat?.isDirectory()) throw new GitError("NOT_FOUND", "Folder not found.", { path: rel });
    const pageLimit = Math.min(Math.max(1, Math.floor(limit ?? DEFAULT_TREE_LIMIT)), MAX_TREE_LIMIT);
    const pageOffset = Math.max(0, Math.floor(offset ?? 0));

    const all: { rel: string; name: string; folder: boolean }[] = [];
    let filesCount = 0;
    const walk = async (absDir: string, relDir: string): Promise<void> => {
      const dirents = await readdir(absDir, { withFileTypes: true }).catch(() => []);
      const visible = dirents.filter((d) => !TREE_EXCLUDED_NAMES.has(d.name) && !isEnvName(d.name));
      visible.sort((a, b) => {
        const af = a.isDirectory() ? 0 : 1;
        const bf = b.isDirectory() ? 0 : 1;
        if (af !== bf) return af - bf;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
      for (const d of visible) {
        if (all.length >= MAX_TREE_WALK) return;
        const childRel = relDir ? `${relDir}/${d.name}` : d.name;
        const folder = d.isDirectory();
        all.push({ rel: childRel, name: d.name, folder });
        if (folder) await walk(path.join(absDir, d.name), childRel);
        else filesCount += 1;
      }
    };
    await walk(start, rel);

    const page = all.slice(pageOffset, pageOffset + pageLimit);
    const entries: FileTreeEntry[] = await Promise.all(
      page.map(async (item) => {
        const depth = item.rel.split("/").length - 1;
        if (item.folder) return { path: item.rel, name: item.name, type: "folder" as const, depth };
        const s = await lstat(path.join(dir, item.rel)).catch(() => null);
        return { path: item.rel, name: item.name, type: "file" as const, size: s?.size ?? 0, depth };
      }),
    );
    return {
      entries,
      totalEntries: all.length,
      offset: pageOffset,
      limit: pageLimit,
      hasMore: pageOffset + entries.length < all.length,
      commitSha: await this.headSha(checkout),
      filesCount,
    };
  }

  /** `files/content GET`: utf8 unless binary (NUL in the first 8 KB, or invalid UTF-8). */
  async readFile(filePath: string, { checkout = "work", maxBytes = DEFAULT_READ_MAX_BYTES }: ReadFileOptions = {}): Promise<FileContent> {
    const dir = await this.requireCheckout(checkout);
    const rel = normalizeRelPath(filePath);
    const abs = await confinePath(dir, rel);
    const s = await stat(abs).catch(() => null);
    if (!s) throw new GitError("NOT_FOUND", "File not found.", { path: rel });
    if (!s.isFile()) throw new GitError("INVALID_PATH", "Not a file.", { path: rel });
    if (s.size > maxBytes) throw new GitError("TOO_LARGE", "File is too large to read.", { path: rel, size: s.size, limit: maxBytes });
    const buffer = await fsReadFile(abs);
    const binary = looksBinary(buffer);
    return {
      path: rel,
      name: path.posix.basename(rel),
      size: buffer.byteLength,
      encoding: binary ? "base64" : "utf8",
      content: binary ? buffer.toString("base64") : buffer.toString("utf8"),
      commitSha: await this.headSha(checkout),
    };
  }

  /**
   * `files/content PUT`: confined, byte-exact write. On `work` it commits (coalesced by
   * client); scratch paths are never committed; `.env*` is FORBIDDEN_PATH.
   */
  async writeFile(filePath: string, bytes: Uint8Array, options: WriteFileOptions = {}): Promise<WriteFileResult> {
    const checkout = options.checkout ?? "work";
    const rel = normalizeRelPath(filePath);
    const maxBytes = options.maxBytes ?? DEFAULT_WRITE_MAX_BYTES;
    if (bytes.byteLength > maxBytes) {
      throw new GitError("TOO_LARGE", "File is too large to write.", { path: rel, size: bytes.byteLength, limit: maxBytes });
    }
    const clientId = options.clientId ?? "default";
    const scratch = isScratchPath(rel);
    const shouldCommit = !scratch && (options.commit ?? checkout === "work");
    const coalesce = options.coalesce ?? true;

    return this.withLock(async () => {
      const dir = await this.requireCheckout(checkout);
      const pending = this.state.pending;
      if (checkout === "work" && pending && pending.clientId !== clientId) await this.flushLocked();

      const head = await this.headSha(checkout);
      if (options.baseCommitSha !== undefined && options.baseCommitSha !== head) {
        const alias = checkout === "work" ? this.state.aliases.get(clientId) : undefined;
        const ownCommit = alias !== undefined && alias.handedOut === options.baseCommitSha && alias.actual === head;
        if (!ownCommit) {
          throw new GitError("STALE_WRITE", "The project changed since this file was read.", {
            path: rel,
            headSha: head,
            baseCommitSha: options.baseCommitSha,
          });
        }
      }

      const abs = await confinePath(dir, rel);
      const existing = await lstat(abs).catch(() => null);
      if (existing?.isDirectory()) throw new GitError("INVALID_PATH", "A folder exists at this path.", { path: rel });
      if (existing?.isSymbolicLink()) throw new GitError("INVALID_PATH", "Refusing to write through a symlink.", { path: rel });
      await mkdir(path.dirname(abs), { recursive: true });
      // Re-check after mkdir: a parent could have been swapped for a symlink meanwhile.
      await confinePath(dir, rel);
      const handle = await open(abs, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }

      const base: Omit<WriteFileResult, "commitSha" | "committed" | "pending"> = {
        path: rel,
        bytesWritten: bytes.byteLength,
        created: existing === null,
        rebuildRequired: isRebuildRequiredPath(rel),
      };
      if (!shouldCommit) return { ...base, commitSha: head ?? undefined, committed: false, pending: false };

      if (checkout === "run") {
        await this.stagePaths(dir, [rel]);
        if (!(await this.hasStagedChanges(dir))) return { ...base, commitSha: head ?? undefined, committed: false, pending: false };
        const sha = await this.commitStaged(dir, options.message ?? `Edit ${rel}`);
        return { ...base, commitSha: sha, committed: true, pending: false };
      }

      const batch: PendingCommit = this.state.pending ?? {
        clientId,
        paths: new Set<string>(),
        baseSha: head,
        message: options.message ?? null,
        firstAt: Date.now(),
        timer: null,
      };
      batch.paths.add(rel);
      this.state.pending = batch;

      if (!coalesce) {
        const sha = await this.flushLocked();
        return { ...base, commitSha: sha ?? undefined, committed: sha !== head, pending: false };
      }
      this.schedule(batch);
      return { ...base, commitSha: head ?? undefined, committed: false, pending: true };
    });
  }

  private schedule(batch: PendingCommit): void {
    if (batch.timer) clearTimeout(batch.timer);
    const elapsed = Date.now() - batch.firstAt;
    const delay = Math.max(0, Math.min(this.coalesceWindowMs, this.coalesceMaxMs - elapsed));
    batch.timer = setTimeout(() => {
      this.withLock(() => this.flushLocked()).catch((error: unknown) => this.onBackgroundError(error));
    }, delay);
    batch.timer.unref();
  }

  /** Commits any pending coalesced writes now. Returns HEAD of `work` afterwards. */
  async flush(): Promise<string | null> {
    return this.withLock(() => this.flushLocked());
  }

  private async flushLocked(): Promise<string | null> {
    const batch = this.state.pending;
    if (!batch) return (await pathExists(path.join(this.workDir, ".git"))) ? this.headSha("work") : null;
    this.state.pending = null;
    if (batch.timer) clearTimeout(batch.timer);
    const paths = [...batch.paths];
    await this.stagePaths(this.workDir, paths);
    if (!(await this.hasStagedChanges(this.workDir))) return this.headSha("work");
    const message = batch.message ?? (paths.length === 1 ? `Edit ${paths[0]}` : `Edit ${paths.length} files`);
    const sha = await this.commitStaged(this.workDir, message);
    await this.tagMain(sha);
    this.state.aliases.set(batch.clientId, { handedOut: batch.baseSha, actual: sha });
    return sha;
  }

  /** Flushes pending writes and forgets this root's shared state (timers included). */
  async dispose(): Promise<void> {
    await this.flush();
    STATES.delete(this.root);
  }

  // ── Versions ─────────────────────────────────────────────────────────────

  /** First-parent history of `main`, newest first. */
  async log({ limit = 10, skip = 0 }: { limit?: number; skip?: number } = {}): Promise<LogResult> {
    return this.withLock(async () => {
      await this.flushLocked();
      const count = Math.min(Math.max(1, Math.floor(limit)), 1000);
      const offset = Math.max(0, Math.floor(skip));
      const total = Number(await this.git.text(["rev-list", "--count", "--first-parent", "main"], { cwd: this.repoDir }));
      const raw = await this.git.text(
        ["log", "--first-parent", `--max-count=${count}`, `--skip=${offset}`, "--format=%H%x1f%P%x1f%cI%x1f%s%x1f%b%x1e", "main"],
        { cwd: this.repoDir },
      );
      const tags = await this.tagsBySha();
      const versions: VersionEntry[] = [];
      for (const record of raw.split("\x1e")) {
        const trimmed = record.replace(/^\n+/, "");
        if (!trimmed) continue;
        const [sha = "", parents = "", createdAt = "", subject = "", body = ""] = trimmed.split("\x1f");
        const parentShas = parents.split(" ").filter(Boolean);
        const version = ProjectRepo.highestVersion(tags.get(sha));
        versions.push({
          commitSha: sha,
          parentSha: parentShas[0] ?? null,
          parentShas,
          tag: version === null ? null : `v${version}`,
          version,
          message: subject,
          body: body.trim(),
          createdAt,
          isMerge: parentShas.length > 1,
          runId: trailer(body, "Forja-Run"),
          restoredFromSha: trailer(body, "Forja-Restored-From"),
        });
      }
      return { versions, totalCount: Number.isFinite(total) ? total : versions.length };
    });
  }

  /** Unified diff of a commit against its first parent (the empty tree for the root). */
  async diff(ref: string): Promise<DiffResult> {
    await this.flush();
    const commitSha = await this.resolveCommit(ref);
    const parent = await this.git.run(["rev-parse", "--verify", "--quiet", `${commitSha}^1`], { cwd: this.repoDir, okExitCodes: [0, 1] });
    const parentSha = parent.exitCode === 0 ? parent.stdout.toString("utf8").trim() : null;
    const from = parentSha ?? (await this.git.text(["hash-object", "-t", "tree", "/dev/null"], { cwd: this.repoDir }));
    const out = await this.git.run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", from, commitSha], { cwd: this.repoDir });
    const diff = out.stdout.toString("utf8");
    if (diff.trim() === "") throw new GitError("NO_DIFF_CONTENT", "This version has no changes to show.");
    return { commitSha, parentSha, diff };
  }

  /**
   * Forward restore: `work/` takes the tree of `targetRef`, committed as
   * "restore v<N> (from v<M>)" and tagged. History is never rewritten.
   */
  async restore(targetRef: string): Promise<RestoreResult> {
    return this.withLock(async () => {
      await this.flushLocked();
      const target = await this.resolveCommit(targetRef);
      const head = await this.git.text(["rev-parse", "HEAD"], { cwd: this.workDir });
      await this.git.run(["read-tree", "-u", "--reset", target], { cwd: this.workDir });
      if (!(await this.hasStagedChanges(this.workDir))) {
        return { commitSha: head, tag: null, version: await this.versionOf(head), changed: false, restoredFromSha: target };
      }
      const targetVersion = await this.versionOf(target);
      const headVersion = await this.versionOf(head);
      const label = (v: number | null, sha: string): string => (v === null ? sha.slice(0, 7) : `v${v}`);
      const message = `restore ${label(targetVersion, target)} (from ${label(headVersion, head)})\n\nForja-Restored-From: ${target}`;
      const commitSha = await this.commitStaged(this.workDir, message);
      const { tag, version } = await this.tagMain(commitSha);
      return { commitSha, tag, version, changed: true, restoredFromSha: target };
    });
  }

  /** Number of files in a commit (the `x-files-count` of `source-code`). */
  async filesCount(ref = "main"): Promise<number> {
    const sha = await this.resolveCommit(ref);
    const out = await this.git.run(["ls-tree", "-r", "-z", "--name-only", sha], { cwd: this.repoDir });
    return out.stdout.toString("utf8").split("\0").filter(Boolean).length;
  }

  /** `git archive --format=zip` of a commit (default: `main`), buffered. */
  async archive(ref = "main"): Promise<Buffer> {
    await this.flush();
    const sha = await this.resolveCommit(ref);
    const out = await this.git.run(["archive", "--format=zip", sha], { cwd: this.repoDir, timeoutMs: 300_000 });
    return out.stdout;
  }

  /** Streaming variant of `archive`; the stream errors if git exits non-zero. */
  async archiveStream(ref = "main"): Promise<{ commitSha: string; stream: Readable }> {
    await this.flush();
    const commitSha = await this.resolveCommit(ref);
    const child = this.git.spawn(["archive", "--format=zip", commitSha], this.repoDir);
    const stream = child.stdout;
    if (!stream) throw new GitError("GIT_FAILED", "git archive produced no stream.");
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) stream.destroy(new GitError("GIT_FAILED", `git archive failed: ${stderr.trim()}`, { exitCode: code, stderr }));
    });
    return { commitSha, stream };
  }

  /** True when any lockfile differs between two commits (restore → `npm ci`). */
  async lockfileChanged(fromRef: string, toRef: string): Promise<boolean> {
    const from = await this.resolveCommit(fromRef);
    const to = await this.resolveCommit(toRef);
    const result = await this.git.run(["diff", "--quiet", "--no-ext-diff", from, to, "--", ...LOCKFILES], {
      cwd: this.repoDir,
      okExitCodes: [0, 1],
    });
    return result.exitCode === 1;
  }
}

