/**
 * Workdir helpers: materialise a seed repo and diff it afterwards.
 * What this file protects: paths are confined to the workdir (no `..`, no absolute paths),
 * so a case or an executor can never write outside its temp directory.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export function safeJoin(root: string, path: string): string {
  const norm = normalize(path);
  if (isAbsolute(norm) || norm === ".." || norm.startsWith(`..${sep}`)) throw new Error(`path escapes the workdir: ${path}`);
  return join(root, norm);
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const target = safeJoin(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

export async function materialize(files: Record<string, string>, prefix = "forja-eval-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await writeFiles(dir, files);
  return dir;
}

/** All files under `root` as posix relative paths → content. */
export async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.set(relative(root, full).split(sep).join("/"), await readFile(full, "utf8"));
    }
  }
  await walk(root);
  return out;
}

/** Paths created, modified or deleted relative to the seed. */
export function changedPaths(seed: Record<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [path, content] of after) if (seed[path] !== content) changed.add(path);
  for (const path of Object.keys(seed)) if (!after.has(path)) changed.add(path);
  return [...changed].sort();
}
