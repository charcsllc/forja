/**
 * Path rules of the files API: confinement, exclusions, scratch dirs and config files.
 *
 * Protects:
 * - A client path is always root-relative POSIX. Absolute paths, `..`, NUL bytes,
 *   backslashes and `.git` segments are refused before touching the disk.
 * - `.env*` (any segment) is FORBIDDEN_PATH for reads and writes: secrets live in the
 *   engine, never in the worktree (07 §1).
 * - `files/tree` hides `node_modules`, `.next`, `.git`, `dist`, `.forja`, `.totalum` and
 *   `.env*` at every depth (05 §2.1).
 * - `.forja/**` and `.totalum/**` are scratch: readable and writable, never committed
 *   (they are listed in the repo's `info/exclude`), never in the tree (04 §5).
 * - `rebuildRequired` is true only for the config files of 04 §5.
 * - Symlinks cannot be used to escape a checkout: ancestors are resolved with `realpath`
 *   and must stay inside the checkout; a symlink leaf is refused for writes.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { GitError } from "./errors.js";

/** Names hidden from `tree()` at any depth. */
export const TREE_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  ".forja",
  ".totalum",
]);

/** Top-level scratch directories: written faithfully, never committed. */
export const SCRATCH_DIRS = [".forja", ".totalum"] as const;

/** Lines written to `info/exclude` of every project repo. */
export const INFO_EXCLUDE_LINES = [
  "# Forja: scratch and build output, never versioned (04 §5)",
  "/.forja/",
  "/.totalum/",
  "node_modules/",
  "/.next/",
] as const;

/** Template copy skips these names at any depth. */
export const TEMPLATE_COPY_EXCLUDED: ReadonlySet<string> = new Set(["node_modules", ".next", "dist", ".git"]);

export const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"] as const;

export function isEnvName(name: string): boolean {
  return name.startsWith(".env");
}

/**
 * Normalizes a client path to root-relative POSIX form, or throws INVALID_PATH /
 * FORBIDDEN_PATH. `allowRoot` accepts "" / "." / "/" as the checkout root (tree only).
 */
export function normalizeRelPath(input: string, { allowRoot = false }: { allowRoot?: boolean } = {}): string {
  if (typeof input !== "string") throw new GitError("INVALID_PATH", "Path must be a string.");
  if (input.includes("\0")) throw new GitError("INVALID_PATH", "Path contains a NUL byte.", { path: input });
  if (input.includes("\\")) throw new GitError("INVALID_PATH", "Use forward slashes in paths.", { path: input });
  const trimmed = input.trim();
  if (allowRoot && (trimmed === "" || trimmed === "." || trimmed === "/" || trimmed === "./")) return "";
  if (trimmed === "") throw new GitError("INVALID_PATH", "Path is empty.", { path: input });
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new GitError("INVALID_PATH", "Absolute paths are not allowed.", { path: input });
  }
  const segments: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new GitError("INVALID_PATH", "Path escapes the project.", { path: input });
    if (segment === ".git") throw new GitError("FORBIDDEN_PATH", "The .git directory is off limits.", { path: input });
    if (isEnvName(segment)) throw new GitError("FORBIDDEN_PATH", ".env files are managed as project secrets.", { path: input });
    segments.push(segment);
  }
  if (segments.length === 0) {
    if (allowRoot) return "";
    throw new GitError("INVALID_PATH", "Path is empty.", { path: input });
  }
  return segments.join("/");
}

/** True for `.forja/**` and `.totalum/**` (and the directories themselves). */
export function isScratchPath(rel: string): boolean {
  const first = rel.split("/")[0] ?? "";
  return (SCRATCH_DIRS as readonly string[]).includes(first);
}

/** 04 §5: a write needs a rebuild only when it touches a config file. */
export function isRebuildRequiredPath(rel: string): boolean {
  const base = path.posix.basename(rel);
  if (isEnvName(base)) return true;
  if (rel.includes("/")) {
    // Nested package.json / lockfiles (workspaces) still change dependencies.
    return base === "package.json" || (LOCKFILES as readonly string[]).includes(base);
  }
  return (
    base === "package.json" ||
    (LOCKFILES as readonly string[]).includes(base) ||
    base === "tsconfig.json" ||
    /^next\.config\.[cm]?[jt]s$/.test(base) ||
    /^drizzle\.config\.[cm]?[jt]s$/.test(base) ||
    /^postcss\.config\.[cm]?[jt]s$/.test(base) ||
    /^tailwind\.config\.[cm]?[jt]s$/.test(base)
  );
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves `rel` inside `rootDir` and proves no symlink on the way leads outside.
 * Returns the absolute path to use (not realpath'd, so a symlink leaf stays visible to
 * the caller, which decides whether to follow it).
 */
export async function confinePath(rootDir: string, rel: string): Promise<string> {
  const realRoot = await realpath(rootDir);
  const target = path.join(realRoot, rel);
  if (!isInside(realRoot, target)) throw new GitError("INVALID_PATH", "Path escapes the project.", { path: rel });
  // Deepest existing ancestor (the parent chain) must resolve inside the root.
  let probe = path.dirname(target);
  while (!(await exists(probe))) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const realProbe = await realpath(probe);
  if (!isInside(realRoot, realProbe)) {
    throw new GitError("INVALID_PATH", "Path escapes the project through a symlink.", { path: rel });
  }
  // An existing leaf that is a symlink must also point inside.
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      const realTarget = await realpath(target).catch(() => null);
      if (realTarget === null || !isInside(realRoot, realTarget)) {
        throw new GitError("INVALID_PATH", "Path escapes the project through a symlink.", { path: rel });
      }
    }
  } catch (error) {
    if (error instanceof GitError) throw error;
  }
  return target;
}
