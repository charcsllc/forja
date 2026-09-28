/**
 * `WorkspacePort` over a folder on disk (the engine passes `/data/projects/<id>/run`).
 *
 * What this protects (the same rules as `@forja/git`'s files API, 07 §1):
 * - Paths are root-relative POSIX. Absolute paths, `..`, NUL, backslashes and `.git`
 *   segments are refused before touching the disk.
 * - `.env*` is never written, and never read except `*.example` templates: secrets live
 *   in the engine, not in the worktree.
 * - Symlinks cannot escape the root: every existing ancestor is resolved with `realpath`
 *   and must stay inside; a symlink leaf is refused for writes.
 * - Listing skips build output and dependencies so a walk stays small.
 */
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { WorkspaceError, type WorkspaceEntry, type WorkspacePort } from "./types.js";

export const WALK_EXCLUDED_NAMES: ReadonlySet<string> = new Set(["node_modules", ".next", ".git", "dist", ".forja", ".totalum", ".turbo", "coverage"]);
const DEFAULT_MAX_WRITE_BYTES = 512 * 1024;
const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

export function isEnvName(name: string): boolean {
  return name.startsWith(".env");
}

export function isReadableEnvTemplate(name: string): boolean {
  return isEnvName(name) && name.endsWith(".example");
}

/** Root-relative POSIX form of a model-supplied path, or a `WorkspaceError`. */
export function normalizeWorkspacePath(input: string, { allowRoot = false, forWrite = false } = {}): string {
  if (typeof input !== "string") throw new WorkspaceError("INVALID_PATH", "Path must be a string.");
  if (input.includes("\0")) throw new WorkspaceError("INVALID_PATH", "Path contains a NUL byte.");
  if (input.includes("\\")) throw new WorkspaceError("INVALID_PATH", "Use forward slashes in paths.");
  let trimmed = input.trim();
  if (trimmed.startsWith("/workspace/")) trimmed = trimmed.slice("/workspace/".length);
  if (allowRoot && (trimmed === "" || trimmed === "." || trimmed === "/" || trimmed === "./" || trimmed === "/workspace")) return "";
  if (trimmed === "") throw new WorkspaceError("INVALID_PATH", "Path is empty.");
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new WorkspaceError("INVALID_PATH", `Absolute paths are not allowed ("${input}"); use a path relative to the project root.`);
  }
  const segments: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new WorkspaceError("INVALID_PATH", "Path escapes the project.");
    if (segment === ".git") throw new WorkspaceError("FORBIDDEN_PATH", "The .git directory is off limits.");
    if (isEnvName(segment) && (forWrite || !isReadableEnvTemplate(segment))) {
      throw new WorkspaceError("FORBIDDEN_PATH", ".env files are managed by the platform as project secrets; report the variables you need in envNeeds instead.");
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    if (allowRoot) return "";
    throw new WorkspaceError("INVALID_PATH", "Path is empty.");
  }
  return segments.join("/");
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface LocalWorkspaceOptions {
  maxWriteBytes?: number;
  maxReadBytes?: number;
}

export class LocalWorkspace implements WorkspacePort {
  private readonly root: string;
  private realRoot: string | null = null;
  private readonly maxWriteBytes: number;
  private readonly maxReadBytes: number;

  constructor(root: string, opts: LocalWorkspaceOptions = {}) {
    if (!path.isAbsolute(root)) throw new Error("LocalWorkspace root must be absolute");
    this.root = path.resolve(root);
    this.maxWriteBytes = opts.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    this.maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  private async rootReal(): Promise<string> {
    this.realRoot ??= await realpath(this.root);
    return this.realRoot;
  }

  /** Absolute path of `rel`, after checking that no existing ancestor escapes the root. */
  private async confine(rel: string): Promise<string> {
    const rootReal = await this.rootReal();
    const abs = path.join(rootReal, ...rel.split("/"));
    let probe = abs;
    for (;;) {
      const exists = await lstat(probe).then(() => true, () => false);
      if (exists) {
        const real = await realpath(probe);
        if (!inside(rootReal, real)) throw new WorkspaceError("FORBIDDEN_PATH", "Path resolves outside the project.");
        break;
      }
      const parent = path.dirname(probe);
      if (parent === probe || !inside(rootReal, parent)) break;
      probe = parent;
    }
    return abs;
  }

  async readFile(p: string): Promise<Uint8Array> {
    const rel = normalizeWorkspacePath(p);
    const abs = await this.confine(rel);
    const s = await stat(abs).catch(() => null);
    if (!s) throw new WorkspaceError("NOT_FOUND", `File not found: ${rel}`);
    if (!s.isFile()) throw new WorkspaceError("NOT_A_FILE", `Not a file: ${rel} (use list_dir for folders)`);
    if (s.size > this.maxReadBytes) throw new WorkspaceError("TOO_LARGE", `File is too large to read (${s.size} bytes): ${rel}`);
    return new Uint8Array(await readFile(abs));
  }

  async writeFile(p: string, data: Uint8Array): Promise<{ created: boolean }> {
    const rel = normalizeWorkspacePath(p, { forWrite: true });
    if (data.byteLength > this.maxWriteBytes) {
      throw new WorkspaceError("TOO_LARGE", `Content is ${data.byteLength} bytes; the limit is ${this.maxWriteBytes}. Split the file.`);
    }
    const abs = await this.confine(rel);
    const existing = await lstat(abs).catch(() => null);
    if (existing?.isDirectory()) throw new WorkspaceError("INVALID_PATH", `A folder exists at ${rel}.`);
    if (existing?.isSymbolicLink()) throw new WorkspaceError("FORBIDDEN_PATH", `Refusing to write through a symlink: ${rel}`);
    await mkdir(path.dirname(abs), { recursive: true });
    await this.confine(rel);
    const handle = await open(abs, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    return { created: existing === null };
  }

  async stat(p: string): Promise<{ type: "file" | "dir"; size: number } | null> {
    let rel: string;
    try {
      rel = normalizeWorkspacePath(p, { allowRoot: true });
    } catch {
      return null;
    }
    const abs = rel ? await this.confine(rel) : await this.rootReal();
    const s = await stat(abs).catch(() => null);
    if (!s) return null;
    return { type: s.isDirectory() ? "dir" : "file", size: s.size };
  }

  async list(p: string, opts: { depth?: number; limit?: number } = {}): Promise<WorkspaceEntry[]> {
    const rel = normalizeWorkspacePath(p, { allowRoot: true });
    const start = rel ? await this.confine(rel) : await this.rootReal();
    const s = await stat(start).catch(() => null);
    if (!s) throw new WorkspaceError("NOT_FOUND", `Folder not found: ${rel || "."}`);
    if (!s.isDirectory()) throw new WorkspaceError("INVALID_PATH", `Not a folder: ${rel}`);
    const maxDepth = opts.depth ?? Number.POSITIVE_INFINITY;
    const limit = opts.limit ?? 5000;
    const out: WorkspaceEntry[] = [];
    const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
      if (out.length >= limit) return;
      const names = (await readdir(absDir, { withFileTypes: true }))
        .filter((d) => !WALK_EXCLUDED_NAMES.has(d.name) && !(isEnvName(d.name) && !isReadableEnvTemplate(d.name)))
        .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
      for (const d of names) {
        if (out.length >= limit) return;
        if (d.isSymbolicLink()) continue;
        const childRel = relDir ? `${relDir}/${d.name}` : d.name;
        const childAbs = path.join(absDir, d.name);
        if (d.isDirectory()) {
          out.push({ path: childRel, type: "dir", size: 0 });
          if (depth < maxDepth) await walk(childAbs, childRel, depth + 1);
        } else if (d.isFile()) {
          const size = await stat(childAbs).then((x) => x.size, () => 0);
          out.push({ path: childRel, type: "file", size });
        }
      }
    };
    await walk(start, rel, 1);
    return out;
  }
}
