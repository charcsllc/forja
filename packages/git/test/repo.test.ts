/**
 * `ProjectRepo` against real git in a temp dir.
 * Protects: the files API contract (tree shape and exclusions, utf8/base64, byte-exact
 * writes, the visual-editor canary), coalescing, stale writes, the run lifecycle
 * (branch → --no-ff merge → tag), forward restore across merges, diff and archive.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, ProjectRepo, isRebuildRequiredPath } from "../src/index.js";

const CANARY_PATH = ".totalum/visual-edit-write-check.txt";
const CANARY = '<div id="c" className="a b">x</div> 1690000000';

let tmp: string;
let template: string;
let root: string;
let repo: ProjectRepo;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", `safe.directory=*`, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

async function expectGitError(promise: Promise<unknown>, code: GitError["code"]): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(GitError);
  await promise.catch((error: unknown) => expect((error as GitError).code).toBe(code));
}

async function put(p: string, content: string | Buffer): Promise<void> {
  const abs = path.join(template, p);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "forja-git-"));
  template = path.join(tmp, "template");
  root = path.join(tmp, "projects", "demo");
  await put("package.json", '{"name":"demo"}\n');
  await put("package-lock.json", '{"lockfileVersion":3}\n');
  await put("src/app/page.tsx", "export default function Page() { return <main>hi</main>; }\n");
  await put("src/app/[id]/page.tsx", "export default function P() { return null; }\n");
  await put("public/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]));
  await put(".env.example", "DATABASE_URL=\n");
  await put("node_modules/left-pad/index.js", "module.exports = 1;\n");
  await put(".next/cache/x", "x");
  await put("dist/out.js", "x");
  repo = new ProjectRepo(root, { coalesceWindowMs: 60_000 });
});

afterEach(async () => {
  await repo.dispose();
  await rm(tmp, { recursive: true, force: true });
});

describe("initFromTemplate", () => {
  it("creates a bare repo, a main checkout, commit v1, and skips build output", async () => {
    const init = await repo.initFromTemplate(template, { message: "Create demo" });
    expect(init.tag).toBe("v1");
    expect(git(path.join(root, "repo.git"), "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(path.join(root, "work"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(path.join(root, "repo.git"), "rev-parse", "v1")).toBe(init.commitSha);
    const files = git(path.join(root, "repo.git"), "ls-tree", "-r", "--name-only", "main").split("\n");
    expect(files).toContain("src/app/[id]/page.tsx");
    expect(files).toContain(".env.example");
    expect(files.some((f) => f.startsWith("node_modules") || f.startsWith(".next") || f.startsWith("dist"))).toBe(false);
    await expectGitError(repo.initFromTemplate(template), "INVALID_STATE");
  });
});

describe("files API", () => {
  beforeEach(async () => {
    await repo.initFromTemplate(template);
  });

  it("lists the tree with the research/02 §1.8 shape and exclusions", async () => {
    await mkdir(path.join(root, "work", "node_modules", "x"), { recursive: true });
    await mkdir(path.join(root, "work", ".forja"), { recursive: true });
    await writeFile(path.join(root, "work", ".env.local"), "SECRET=1");
    const tree = await repo.tree();
    expect(Object.keys(tree).sort()).toEqual(["commitSha", "entries", "filesCount", "hasMore", "limit", "offset", "totalEntries"]);
    const paths = tree.entries.map((e) => e.path);
    expect(paths).toEqual([
      "public",
      "public/logo.png",
      "src",
      "src/app",
      "src/app/[id]",
      "src/app/[id]/page.tsx",
      "src/app/page.tsx",
      "package-lock.json",
      "package.json",
    ]);
    expect(tree.filesCount).toBe(5);
    expect(tree.totalEntries).toBe(9);
    expect(tree.hasMore).toBe(false);
    expect(tree.commitSha).toMatch(/^[0-9a-f]{40}$/);
    const page = tree.entries.find((e) => e.path === "src/app/page.tsx");
    expect(page).toMatchObject({ name: "page.tsx", type: "file", depth: 2 });
    expect(page?.size).toBeGreaterThan(0);
    expect(tree.entries.find((e) => e.path === "src")).toEqual({ path: "src", name: "src", type: "folder", depth: 0 });

    const paged = await repo.tree({ limit: 2, offset: 2 });
    expect(paged.entries.map((e) => e.path)).toEqual(["src", "src/app"]);
    expect(paged.hasMore).toBe(true);
    const sub = await repo.tree({ path: "src/app" });
    expect(sub.entries.map((e) => e.path)).toEqual(["src/app/[id]", "src/app/[id]/page.tsx", "src/app/page.tsx"]);
    await expectGitError(repo.tree({ path: "nope" }), "NOT_FOUND");
  });

  it("reads utf8 and base64", async () => {
    const text = await repo.readFile("src/app/page.tsx");
    expect(text.encoding).toBe("utf8");
    expect(text.content).toContain("<main>hi</main>");
    expect(text.name).toBe("page.tsx");
    const bin = await repo.readFile("public/logo.png");
    expect(bin.encoding).toBe("base64");
    expect(Buffer.from(bin.content, "base64")).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0xff]));
    expect(bin.size).toBe(8);
    await expectGitError(repo.readFile("missing.ts"), "NOT_FOUND");
    await expectGitError(repo.readFile(".env.example"), "FORBIDDEN_PATH");
    await writeFile(path.join(root, "work", "big.txt"), "x".repeat(1024 * 1024 + 1));
    await expectGitError(repo.readFile("big.txt"), "TOO_LARGE");
  });

  it("writes the visual-editor canary byte-exact, uncommitted and out of the tree", async () => {
    const head = await repo.headSha();
    const bytes = Buffer.from(CANARY, "utf8");
    const result = await repo.writeFile(CANARY_PATH, bytes);
    expect(result).toMatchObject({ path: CANARY_PATH, bytesWritten: Buffer.byteLength(CANARY, "utf8"), created: true, committed: false, rebuildRequired: false });
    const back = await repo.readFile(CANARY_PATH);
    expect(back.encoding).toBe("utf8");
    expect(back.content).toBe(CANARY);
    expect(Buffer.from(await readFile(path.join(root, "work", CANARY_PATH))).equals(bytes)).toBe(true);
    await repo.flush();
    expect(await repo.headSha()).toBe(head);
    expect(git(path.join(root, "work"), "status", "--porcelain")).toBe("");
    expect((await repo.tree()).entries.some((e) => e.path.startsWith(".totalum"))).toBe(false);
  });

  it("reports exact bytesWritten for multi-byte content and rebuildRequired for config", async () => {
    const content = "const s = 'ñandú 🚀';\n";
    const res = await repo.writeFile("src/lib/s.ts", Buffer.from(content, "utf8"), { coalesce: false });
    expect(res.bytesWritten).toBe(Buffer.byteLength(content, "utf8"));
    expect(res.created).toBe(true);
    expect(res.committed).toBe(true);
    expect(res.rebuildRequired).toBe(false);
    expect((await repo.readFile("src/lib/s.ts")).content).toBe(content);
    const cfg = await repo.writeFile("package.json", Buffer.from('{"name":"demo2"}\n'), { coalesce: false });
    expect(cfg.rebuildRequired).toBe(true);
    expect(cfg.created).toBe(false);
    expect(isRebuildRequiredPath("next.config.ts")).toBe(true);
    expect(isRebuildRequiredPath("src/app/next.config.ts")).toBe(false);
  });

  it("coalesces 5 writes from one client into one commit", async () => {
    const before = Number(git(path.join(root, "repo.git"), "rev-list", "--count", "main"));
    for (let i = 0; i < 5; i += 1) {
      const res = await repo.writeFile(`src/c${i}.ts`, Buffer.from(`export const c = ${i};\n`), { clientId: "tab-1" });
      expect(res.pending).toBe(true);
    }
    expect(Number(git(path.join(root, "repo.git"), "rev-list", "--count", "main"))).toBe(before);
    const sha = await repo.flush();
    expect(Number(git(path.join(root, "repo.git"), "rev-list", "--count", "main"))).toBe(before + 1);
    expect(git(path.join(root, "repo.git"), "log", "-1", "--format=%s", "main")).toBe("Edit 5 files");
    expect(git(path.join(root, "repo.git"), "log", "-1", "--format=%an <%ae>", "main")).toBe("Forja <forja@localhost>");
    expect(git(path.join(root, "repo.git"), "rev-parse", "v2")).toBe(sha);
  });

  it("flushes on the debounce timer", async () => {
    const quick = new ProjectRepo(path.join(tmp, "projects", "quick"), { coalesceWindowMs: 50 });
    await quick.initFromTemplate(template);
    const head = await quick.headSha();
    await quick.writeFile("a.txt", Buffer.from("a"), { clientId: "c" });
    await quick.writeFile("b.txt", Buffer.from("b"), { clientId: "c" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await quick.headSha();
    expect(after).not.toBe(head);
    expect(git(quick.repoDir, "rev-list", "--count", "main")).toBe("2");
    await quick.dispose();
  });

  it("refuses stale writes, but not a client's own coalesced commit", async () => {
    const base = await repo.headSha();
    if (!base) throw new Error("no head");
    await repo.writeFile("a.ts", Buffer.from("1"), { clientId: "tab-1", baseCommitSha: base });
    await repo.writeFile("b.ts", Buffer.from("2"), { clientId: "tab-1", baseCommitSha: base });
    await repo.flush();
    // Same client, same handed-out sha: accepted.
    await repo.writeFile("c.ts", Buffer.from("3"), { clientId: "tab-1", baseCommitSha: base, coalesce: false });
    // Another tab still holding the old sha: stale.
    await expectGitError(repo.writeFile("d.ts", Buffer.from("4"), { clientId: "tab-2", baseCommitSha: base }), "STALE_WRITE");
    const head = await repo.headSha();
    if (!head) throw new Error("no head");
    await expect(repo.writeFile("d.ts", Buffer.from("4"), { clientId: "tab-2", baseCommitSha: head })).resolves.toMatchObject({ bytesWritten: 1 });
  });

  it("rejects path escapes and forbidden paths", async () => {
    const bytes = Buffer.from("x");
    await expectGitError(repo.writeFile("/etc/passwd", bytes), "INVALID_PATH");
    await expectGitError(repo.writeFile("../outside.txt", bytes), "INVALID_PATH");
    await expectGitError(repo.writeFile("src/../../outside.txt", bytes), "INVALID_PATH");
    await expectGitError(repo.writeFile("a\\b.txt", bytes), "INVALID_PATH");
    await expectGitError(repo.writeFile(".env", bytes), "FORBIDDEN_PATH");
    await expectGitError(repo.writeFile("config/.env.production", bytes), "FORBIDDEN_PATH");
    await expectGitError(repo.writeFile(".git/config", bytes), "FORBIDDEN_PATH");
    const outside = path.join(tmp, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(root, "work", "escape"));
    await expectGitError(repo.writeFile("escape/pwned.txt", bytes), "INVALID_PATH");
    await expectGitError(repo.readFile("escape/x"), "INVALID_PATH");
    await writeFile(path.join(outside, "secret.txt"), "s");
    await symlink(path.join(outside, "secret.txt"), path.join(root, "work", "leaf.txt"));
    await expectGitError(repo.writeFile("leaf.txt", bytes), "INVALID_PATH");
    await expectGitError(repo.readFile("leaf.txt"), "INVALID_PATH");
    expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("s");
  });
});

describe("runs, versions, restore", () => {
  beforeEach(async () => {
    await repo.initFromTemplate(template);
  });

  it("branches a run, merges --no-ff, tags and refreshes work/", async () => {
    const run = await repo.ensureRunCheckout("r1");
    expect(run.branch).toBe("run/r1");
    expect(await repo.ensureRunCheckout("r1")).toMatchObject({ headSha: run.headSha });
    await expectGitError(repo.ensureRunCheckout("r2"), "INVALID_STATE");
    await repo.writeFile("src/feature.ts", Buffer.from("export const f = 1;\n"), { checkout: "run" });
    const task = await repo.commitAll("run", "Task 1");
    expect(task?.tag).toBeNull();
    await writeFile(path.join(root, "run", "src", "late.ts"), "export const l = 1;\n");
    const merged = await repo.mergeRun("r1");
    expect(merged.merged).toBe(true);
    expect(merged.tag).toBe("v2");
    expect(git(root, "-C", "repo.git", "rev-list", "--parents", "-n", "1", "main").split(" ")).toHaveLength(3);
    expect(await readFile(path.join(root, "work", "src", "feature.ts"), "utf8")).toBe("export const f = 1;\n");
    expect(await readFile(path.join(root, "work", "src", "late.ts"), "utf8")).toBe("export const l = 1;\n");
    await repo.removeRunCheckout("r1");
    expect(git(root, "-C", "repo.git", "branch", "--list", "run/*")).toBe("");
    const log = await repo.log();
    expect(log.totalCount).toBe(2);
    expect(log.versions[0]).toMatchObject({ tag: "v2", version: 2, isMerge: true, runId: "r1" });
    expect(log.versions[1]).toMatchObject({ tag: "v1", parentSha: null });
  });

  it("restores forward across a merge commit", async () => {
    const v1 = await repo.headSha();
    if (!v1) throw new Error("no head");
    await repo.ensureRunCheckout("r1");
    await writeFile(path.join(root, "run", "src", "app", "page.tsx"), "export default function Page() { return <main>v2</main>; }\n");
    await writeFile(path.join(root, "run", "added.ts"), "export {};\n");
    await repo.mergeRun("r1");
    await repo.removeRunCheckout("r1");
    await repo.writeFile("manual.ts", Buffer.from("m\n"), { coalesce: false }); // v3
    const restored = await repo.restore(v1);
    expect(restored.changed).toBe(true);
    expect(restored.tag).toBe("v4");
    expect(git(root, "-C", "repo.git", "log", "-1", "--format=%s", "main")).toBe("restore v1 (from v3)");
    expect(await readFile(path.join(root, "work", "src", "app", "page.tsx"), "utf8")).toContain("<main>hi</main>");
    await expect(readFile(path.join(root, "work", "added.ts"))).rejects.toThrow();
    await expect(readFile(path.join(root, "work", "manual.ts"))).rejects.toThrow();
    expect(git(root, "-C", "work", "status", "--porcelain")).toBe("");
    // History kept: v2 (merge) is still reachable and restorable.
    const again = await repo.restore("v2");
    expect(again.changed).toBe(true);
    expect(await readFile(path.join(root, "work", "added.ts"), "utf8")).toBe("export {};\n");
    const log = await repo.log({ limit: 10 });
    expect(log.totalCount).toBe(5);
    expect(log.versions[1]?.restoredFromSha).toBe(v1);
    const noop = await repo.restore("HEAD");
    expect(noop.changed).toBe(false);
  });

  it("diffs against the first parent and reports empty diffs", async () => {
    const v1 = await repo.headSha();
    if (!v1) throw new Error("no head");
    const root1 = await repo.diff(v1);
    expect(root1.parentSha).toBeNull();
    expect(root1.diff).toContain("+++ b/package.json");
    await repo.writeFile("src/app/page.tsx", Buffer.from("changed\n"), { coalesce: false });
    const d = await repo.diff("main");
    expect(d.parentSha).toBe(v1);
    expect(d.diff).toContain("-export default function Page()");
    expect(d.diff).toContain("+changed");
    await repo.ensureRunCheckout("empty");
    git(path.join(root, "run"), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "empty");
    const empty = git(path.join(root, "run"), "rev-parse", "HEAD");
    await expectGitError(repo.diff(empty), "NO_DIFF_CONTENT");
    await expectGitError(repo.diff("deadbeef"), "NOT_FOUND");
    await expectGitError(repo.diff("--output=/tmp/x"), "NOT_FOUND");
  });

  it("archives a readable zip and detects lockfile changes", async () => {
    const v1 = await repo.headSha();
    if (!v1) throw new Error("no head");
    const zip = await repo.archive();
    const files = unzipSync(new Uint8Array(zip));
    expect(Object.keys(files)).toContain("src/app/[id]/page.tsx");
    expect(new TextDecoder().decode(files["package.json"])).toBe('{"name":"demo"}\n');
    expect(await repo.filesCount()).toBe(6);
    const { stream } = await repo.archiveStream(v1);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(zip)).toBe(true);
    await repo.writeFile("package-lock.json", Buffer.from('{"lockfileVersion":3,"x":1}\n'), { coalesce: false });
    expect(await repo.lockfileChanged(v1, "main")).toBe(true);
    await repo.writeFile("src/x.ts", Buffer.from("x"), { coalesce: false });
    expect(await repo.lockfileChanged("v2", "main")).toBe(false);
  });
});
