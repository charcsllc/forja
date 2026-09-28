/**
 * Fakes for engine unit tests: a sandbox with just enough Docker state, an in-memory repo,
 * an inline/async job queue, a CMS recorder, and `makeTestEngine` that wires them with the
 * in-memory store into a real `EngineContext` and Hono app.
 *
 * Protects: unit tests never touch Docker, Postgres or the network.
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import pino from "pino";
import type { FileContent, FileTree } from "@forja/contracts/v1";
import { GitError, isRebuildRequiredPath, type WriteFileOptions, type WriteFileResult } from "@forja/git";
import type { ExecOptions, ExecResult, ProvisionOptions, ProvisionResult, VerifyOptions, VerifyResult, WaitHttpResult } from "@forja/sandbox";
import type { Provider } from "@forja/llm";
import { parseConfig, type Config } from "../src/config.js";
import { createApp } from "../src/http/app.js";
import { JOB_HANDLERS } from "../src/jobs.js";
import type { CmsPort, LinkInput } from "../src/services/cms.js";
import type { EngineContext, JobData, JobName, QueuePort, RepoPort, SandboxPort } from "../src/services/context.js";
import { GitProjectRepo } from "../src/services/repo.js";
import { SecretBox, SecretsService } from "../src/services/secrets.js";
import { SettingsService } from "../src/services/settings.js";
import { createImageSourcing } from "@forja/media";
import { MemoryStore } from "../src/store/memory.js";
import { createTestLlmService } from "../src/services/llm.js";
import type { RunEnvironmentFactory } from "../src/services/runs/environment.js";

export const ENGINE_KEY = "test-engine-key-0123456789abcdef";

// ── Sandbox ──────────────────────────────────────────────────────────────────

interface FakeProject {
  app: boolean;
  appRunning: boolean;
  db: boolean;
  dbRunning: boolean;
  network: boolean;
  env: Record<string, string>;
  passwords: ProvisionOptions["dbPasswords"];
}

export class FakeSandbox implements SandboxPort {
  readonly projects = new Map<string, FakeProject>();
  readonly calls: string[] = [];
  readonly execs: { container: string; argv: readonly string[] }[] = [];
  readonly attached = new Set<string>();
  ready = true;
  /** exit code per argv[0..2] joined, e.g. "npm ci" or "npm run" */
  execExit: Record<string, number> = {};
  /** Per-command answers (e.g. a failing gate): return undefined to fall back to `execExit`. */
  execHandler: ((container: string, argv: readonly string[]) => Partial<ExecResult> | undefined) | null = null;
  readonly verifies = new Map<string, string>();
  provisionError: Error | null = null;
  networks = new Set<string>(["forja-apps"]);

  private p(id: string): FakeProject {
    const p = this.projects.get(id);
    if (!p) throw new Error(`not provisioned: ${id}`);
    return p;
  }

  async provision(projectId: string, options: ProvisionOptions = {}): Promise<ProvisionResult> {
    this.calls.push(`provision:${projectId}`);
    if (this.provisionError) throw this.provisionError;
    const existing = this.projects.get(projectId);
    this.projects.set(projectId, {
      app: true,
      appRunning: true,
      db: true,
      dbRunning: true,
      network: true,
      env: { ...(options.env ?? {}) },
      passwords: options.dbPasswords ?? existing?.passwords,
    });
    this.networks.add(`forja-int-${projectId}`);
    const pw = options.dbPasswords ?? {};
    return {
      projectId,
      network: `forja-int-${projectId}`,
      appContainer: `forja-app-${projectId}`,
      previewUrl: `http://${projectId}.forja.localhost`,
      internalUrl: `http://forja-app-${projectId}:3000`,
      db: {
        container: `forja-db-${projectId}`,
        host: `forja-db-${projectId}`,
        port: 5432,
        database: "app",
        superuser: { user: "postgres", password: pw.superuser ?? "" },
        passwords: { superuser: pw.superuser ?? "", app_rw: pw.app_rw ?? "", cms_ro: pw.cms_ro ?? "", cms_rw: pw.cms_rw ?? "" },
        urls: { app: "", cmsRo: "", cmsRw: "" },
      },
    };
  }

  async restart(projectId: string): Promise<void> {
    this.calls.push(`restart:${projectId}`);
    const p = this.p(projectId);
    if (!p.dbRunning || !p.network) return this.unarchive(projectId);
    p.appRunning = true;
  }

  async unarchive(projectId: string): Promise<void> {
    this.calls.push(`unarchive:${projectId}`);
    const p = this.p(projectId);
    p.network = true;
    this.networks.add(`forja-int-${projectId}`);
    p.dbRunning = true;
    p.appRunning = true;
  }

  async archive(projectId: string): Promise<void> {
    this.calls.push(`archive:${projectId}`);
    const p = this.p(projectId);
    p.appRunning = false;
    p.dbRunning = false;
    p.network = false;
    this.networks.delete(`forja-int-${projectId}`);
  }

  async remove(projectId: string): Promise<void> {
    this.calls.push(`remove:${projectId}`);
    this.projects.delete(projectId);
    this.networks.delete(`forja-int-${projectId}`);
  }

  async status(projectId: string) {
    const p = this.projects.get(projectId);
    if (!p) return null;
    return p.appRunning ? ("Active" as const) : ("Archived" as const);
  }

  async exec(container: string, argv: readonly string[], _options?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ container, argv });
    this.calls.push(`exec:${container}:${argv.slice(0, 3).join(" ")}`);
    const custom = this.execHandler?.(container, argv);
    if (custom) return { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false, durationMs: 1, ...custom };
    const key = argv.slice(0, 2).join(" ");
    const exitCode = this.execExit[key] ?? 0;
    return { exitCode, stdout: "", stderr: exitCode ? "boom" : "", truncated: false, timedOut: false, durationMs: 1 };
  }

  async createVerify(projectId: string, runId: string, _options: VerifyOptions): Promise<VerifyResult> {
    this.calls.push(`createVerify:${projectId}:${runId}`);
    this.verifies.set(projectId, runId);
    return {
      container: `forja-verify-${projectId}`,
      database: `verify_${runId}`,
      databaseUrl: `postgres://app_rw:x@forja-db-${projectId}:5432/verify_${runId}`,
      internalUrl: `http://forja-verify-${projectId}:3000`,
    };
  }

  async destroyVerify(projectId: string, runId: string): Promise<void> {
    this.calls.push(`destroyVerify:${projectId}:${runId}`);
    this.verifies.delete(projectId);
  }

  async logs(container: string): Promise<string> {
    return `log line from ${container}\n`;
  }

  async waitHttpReady(): Promise<WaitHttpResult> {
    return { ready: this.ready, status: this.ready ? 200 : null, attempts: 1, elapsedMs: 1 };
  }

  async hostPathCheck() {
    return { status: "ok" as const };
  }

  readonly docker: SandboxPort["docker"] = {
    inspectNetwork: async (name: string) =>
      this.networks.has(name) ? { id: name, name, internal: name !== "forja-apps", labels: {}, options: {} } : null,
    createNetwork: async (spec) => {
      this.networks.add(spec.Name);
    },
    connectNetwork: async (network: string, container: string) => {
      if (!this.networks.has(network)) throw new Error(`no network ${network}`);
      this.attached.add(`${network}>${container}`);
    },
    disconnectNetwork: async (network: string, container: string) => this.attached.delete(`${network}>${container}`),
    inspectContainer: async (name: string) => {
      const m = /^forja-(app|db)-(.+)$/.exec(name);
      const p = m ? this.projects.get(m[2] as string) : undefined;
      if (!m || !p) return null;
      const running = m[1] === "app" ? p.appRunning : p.dbRunning;
      return {
        id: name,
        name,
        status: running ? "running" : "exited",
        running,
        exitCode: 0,
        health: null,
        labels: {},
        networks: [],
        image: "x",
        hostConfig: {},
      };
    },
    exec: async (container: string, argv: readonly string[]) => {
      this.execs.push({ container, argv });
      this.calls.push(`exec:${container}:${argv[0]}`);
      return { exitCode: 0, stdout: "-- dump\n", stderr: "", truncated: false, timedOut: false, durationMs: 1 };
    },
  };
}

// ── Repo (in memory) ─────────────────────────────────────────────────────────

interface Commit {
  sha: string;
  parent: string | null;
  files: Map<string, Buffer>;
  message: string;
  tag: string;
  at: string;
}

/** A tiny in-memory `RepoPort`: every write commits immediately (no coalescing). */
export class FakeRepo implements RepoPort {
  readonly root: string;
  commits: Commit[] = [];
  private work = new Map<string, Buffer>();

  constructor(root = "/fake") {
    this.root = root;
  }

  private commit(message: string): Commit {
    const parent = this.commits.at(-1) ?? null;
    const c: Commit = {
      sha: randomBytes(20).toString("hex"),
      parent: parent?.sha ?? null,
      files: new Map(this.work),
      message,
      tag: `v${this.commits.length + 1}`,
      at: new Date().toISOString(),
    };
    this.commits.push(c);
    return c;
  }

  private find(ref: string): Commit | undefined {
    return this.commits.find((c) => c.sha === ref || c.sha.startsWith(ref) || c.tag === ref);
  }

  async exists() {
    return this.commits.length > 0;
  }
  async initFromTemplate() {
    this.work.set("package.json", Buffer.from("{}"));
    this.work.set("package-lock.json", Buffer.from("{}"));
    this.work.set("src/app/page.tsx", Buffer.from("export default 1\n"));
    const c = this.commit("Create project from template");
    return { commitSha: c.sha, tag: c.tag };
  }
  async headSha() {
    return this.commits.at(-1)?.sha ?? null;
  }
  async resolve(ref: string) {
    return this.find(ref)?.sha ?? null;
  }
  async tree(): Promise<FileTree> {
    const entries = [...this.work.keys()].sort().map((p) => ({
      path: p,
      name: path.posix.basename(p),
      type: "file" as const,
      size: this.work.get(p)?.byteLength ?? 0,
      depth: p.split("/").length - 1,
    }));
    return { entries, totalEntries: entries.length, offset: 0, limit: 5000, hasMore: false, commitSha: await this.headSha(), filesCount: entries.length };
  }
  async readFile(p: string): Promise<FileContent> {
    const b = this.work.get(p);
    if (!b) throw new GitError("NOT_FOUND", "File not found.");
    return { path: p, name: path.posix.basename(p), size: b.byteLength, encoding: "utf8", content: b.toString("utf8"), commitSha: await this.headSha() };
  }
  async writeFile(p: string, bytes: Uint8Array, opts: WriteFileOptions): Promise<WriteFileResult> {
    if (p.startsWith(".env")) throw new GitError("FORBIDDEN_PATH", ".env files are managed as project secrets.");
    const head = await this.headSha();
    if (opts.baseCommitSha && opts.baseCommitSha !== head) throw new GitError("STALE_WRITE", "stale", { headSha: head });
    const created = !this.work.has(p);
    this.work.set(p, Buffer.from(bytes));
    const c = this.commit(`Edit ${p}`);
    return { path: p, bytesWritten: bytes.byteLength, created, commitSha: c.sha, rebuildRequired: isRebuildRequiredPath(p), committed: true, pending: false };
  }
  async flush() {
    return this.headSha();
  }
  async log() {
    const versions = [...this.commits].reverse().map((c) => ({
      commitSha: c.sha,
      parentSha: c.parent,
      parentShas: c.parent ? [c.parent] : [],
      tag: c.tag,
      version: Number(c.tag.slice(1)),
      message: c.message,
      body: "",
      createdAt: c.at,
      isMerge: false,
      runId: null,
      restoredFromSha: null,
    }));
    return { versions, totalCount: versions.length };
  }
  async diff(ref: string) {
    const c = this.find(ref);
    if (!c) throw new GitError("NOT_FOUND", "Unknown version");
    return { commitSha: c.sha, parentSha: c.parent, diff: `diff --git a/x b/x\n+${c.message}\n` };
  }
  async restore(ref: string) {
    const target = this.find(ref);
    if (!target) throw new GitError("NOT_FOUND", "Unknown version");
    this.work = new Map(target.files);
    const c = this.commit(`restore ${target.tag}`);
    return { commitSha: c.sha, tag: c.tag, version: this.commits.length, changed: true, restoredFromSha: target.sha };
  }
  async filesCount() {
    return this.work.size;
  }
  async archiveStream() {
    return { commitSha: (await this.headSha()) ?? "", stream: Readable.from([Buffer.from("PK\x05\x06")]) };
  }
  async lockfileChanged(from: string, to: string) {
    const a = this.find(from)?.files.get("package-lock.json");
    const b = this.find(to)?.files.get("package-lock.json");
    return !(a && b && a.equals(b));
  }
  // ── Runs: `run/` is a real temp folder (agents write files through LocalWorkspace) ──
  private runDir: { runId: string; dir: string; base: string } | null = null;

  private readRunDir(): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    if (!this.runDir) return out;
    const walk = (abs: string, rel: string) => {
      for (const name of readdirSync(abs)) {
        const a = path.join(abs, name);
        const r = rel ? `${rel}/${name}` : name;
        if (statSync(a).isDirectory()) walk(a, r);
        else out.set(r, readFileSync(a));
      }
    };
    walk(this.runDir.dir, "");
    return out;
  }

  async ensureRunCheckout(runId: string) {
    if (!this.runDir || this.runDir.runId !== runId) {
      const dir = mkdtempSync(path.join(tmpdir(), "forja-fakerun-"));
      for (const [p, b] of this.work) {
        mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
        writeFileSync(path.join(dir, p), b);
      }
      this.runDir = { runId, dir, base: (await this.headSha()) ?? "" };
    }
    return { runId, branch: `run/${runId}`, path: this.runDir.dir, headSha: this.runDir.base };
  }
  async removeRunCheckout() {
    if (this.runDir) rmSync(this.runDir.dir, { recursive: true, force: true });
    this.runDir = null;
  }
  runCommits: string[] = [];
  async commitRun(message: string) {
    this.runCommits.push(message);
    return randomBytes(20).toString("hex");
  }
  async mergeRun(runId: string) {
    const files = this.readRunDir();
    const changed = [...files].some(([p, b]) => !this.work.get(p)?.equals(b));
    if (!changed) return { commitSha: (await this.headSha()) ?? "", tag: null, version: null, merged: false };
    this.work = files;
    const c = this.commit(`Merge run ${runId}`);
    return { commitSha: c.sha, tag: c.tag, version: this.commits.length, merged: true };
  }
  async runDiff() {
    return "";
  }
  async logText() {
    return this.commits.map((c) => `${c.sha.slice(0, 7)} ${c.message}`).reverse().join("\n");
  }

  async changedFiles(from: string, to: string) {
    if (to.startsWith("run/")) {
      const base = this.find(from)?.files ?? new Map<string, Buffer>();
      const run = this.readRunDir();
      const keys = new Set([...base.keys(), ...run.keys()]);
      return [...keys].filter((k) => !(base.get(k) && run.get(k) && base.get(k)?.equals(run.get(k) as Buffer)));
    }
    const a = this.find(from)?.files ?? new Map<string, Buffer>();
    const b = this.find(to)?.files ?? new Map<string, Buffer>();
    const keys = new Set([...a.keys(), ...b.keys()]);
    return [...keys].filter((k) => !(a.get(k) && b.get(k) && a.get(k)?.equals(b.get(k) as Buffer)));
  }
}

// ── Queue ────────────────────────────────────────────────────────────────────

/** Records jobs; `drain()` runs them (and any they enqueue) in order. `auto` runs each soon after send. */
export class TestQueue implements QueuePort {
  readonly sent: { name: JobName; data: JobData }[] = [];
  private pending: { name: JobName; data: JobData }[] = [];
  ctx: EngineContext | null = null;
  auto = false;
  autoDelayMs = 5;

  async send(name: JobName, data: JobData): Promise<void> {
    this.sent.push({ name, data });
    if (this.auto && this.ctx) {
      const ctx = this.ctx;
      setTimeout(() => void JOB_HANDLERS[name](ctx, data), this.autoDelayMs);
      return;
    }
    this.pending.push({ name, data });
  }

  async drain(): Promise<string[]> {
    const ran: string[] = [];
    while (this.pending.length > 0 && this.ctx) {
      const job = this.pending.shift() as { name: JobName; data: JobData };
      ran.push(job.name);
      await JOB_HANDLERS[job.name](this.ctx, job.data);
    }
    return ran;
  }
}

// ── CMS ──────────────────────────────────────────────────────────────────────

export class FakeCms implements CmsPort {
  readonly calls: string[] = [];
  async tablesStructure(projectId: string) {
    this.calls.push(`structure:${projectId}`);
    return { tables: [{ _id: "t1", type: "note", label: "Note", properties: {} }] };
  }
  async query(projectId: string, tableName: string) {
    this.calls.push(`query:${projectId}:${tableName}`);
    return { results: [{ _id: "r1" }] };
  }
  async createRecord(_p: string, _t: string, data: Record<string, unknown>) {
    return { _id: "new", ...data };
  }
  async updateRecord(_p: string, _t: string, id: string, data: Record<string, unknown>) {
    return { _id: id, ...data };
  }
  async deleteRecord(_p: string, _t: string, id: string) {
    return { _id: id, deleted: true };
  }
  async link(_p: string, input: LinkInput) {
    this.calls.push(`link:${input.propertyId}`);
    return { linked: true };
  }
  async unlink(_p: string, input: LinkInput) {
    this.calls.push(`unlink:${input.propertyId}`);
    return { unlinked: true };
  }
  async release(projectId: string) {
    this.calls.push(`release:${projectId}`);
  }
  async close() {}
}

// ── Wiring ───────────────────────────────────────────────────────────────────

export function tinyTemplate(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "forja-tpl-"));
  mkdirSync(path.join(dir, "src/app"), { recursive: true });
  writeFileSync(path.join(dir, "package.json"), '{"name":"app"}\n');
  writeFileSync(path.join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(dir, "src/app/page.tsx"), "export default function Page() { return <main>Hello</main>; }\n");
  writeFileSync(path.join(dir, "template.json"), '{"name":"tiny","version":"9.9.9"}\n');
  writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n.env\n");
  return dir;
}

export interface TestEngine {
  ctx: EngineContext;
  store: MemoryStore;
  sandbox: FakeSandbox;
  queue: TestQueue;
  cms: FakeCms;
  app: ReturnType<typeof createApp>;
  config: Config;
  dataDir: string;
  /** app.request with the api-key. */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  json(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface TestEngineOptions {
  repo?: "git" | "fake";
  env?: Record<string, string>;
  /** The LLM the agents talk to (scripted/replay). Absent = no provider configured. */
  llm?: Provider;
  runEnvironments?: RunEnvironmentFactory;
}

export function makeTestEngine(opts: TestEngineOptions = {}): TestEngine {
  const dataDir = mkdtempSync(path.join(tmpdir(), "forja-data-"));
  const parsed = parseConfig({
    DATA_DIR: dataDir,
    DATA_DIR_HOST: dataDir,
    TEMPLATE_DIR: tinyTemplate(),
    SANDBOX_START_TIMEOUT_SEC: "10",
    WEB_PUBLIC_URL: "http://localhost:3000",
    ...opts.env,
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  const config = parsed.config;
  const masterKey = randomBytes(32).toString("base64");
  const store = new MemoryStore();
  const sandbox = new FakeSandbox();
  const queue = new TestQueue();
  const cms = new FakeCms();
  const fakeRepos = new Map<string, FakeRepo>();
  const logger = pino({ level: "silent" });
  const settings = new SettingsService(store, logger);
  const ctx: EngineContext = {
    config,
    store,
    logger,
    masterKey,
    secrets: new SecretsService(store, new SecretBox(masterKey)),
    sandbox,
    repo: (id) => {
      if (opts.repo === "fake") {
        let r = fakeRepos.get(id);
        if (!r) fakeRepos.set(id, (r = new FakeRepo(`/fake/${id}`)));
        return r;
      }
      return new GitProjectRepo(dataDir, id, logger);
    },
    queue,
    cms,
    settings,
    // No network in unit tests: no search providers, so `find` fails fast with not_found.
    imageSourcing: createImageSourcing({
      env: { ...config.rawProviderEnv, IMAGES_FROM_WEB_SEARCH: String(config.IMAGES_FROM_WEB_SEARCH) },
      settings,
      providers: [],
    }),
    llm: opts.llm
      ? createTestLlmService(opts.llm)
      : createTestLlmService({ id: "none", generate: () => { throw new Error("no LLM in this test"); } }, { unavailable: "no LLM provider is enabled (test engine): set LLM_<PROVIDER>=\"true|<key>\"." }),
    ...(opts.runEnvironments ? { runEnvironments: opts.runEnvironments } : {}),
    selfContainer: "forja-engine-test",
    readyIntervalMs: 1,
  };
  queue.ctx = ctx;
  const app = createApp({
    config,
    engineKey: ENGINE_KEY,
    masterKey,
    logger,
    ctx,
    probes: {
      db: async () => true,
      queue: async () => true,
      docker: async () => "unavailable",
      diskFreeGb: async () => 42.5,
      dataDirCheck: () => "ok",
    },
  });
  const call = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
    Promise.resolve(
      app.request(p, {
        method,
        headers: { "api-key": ENGINE_KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return {
    ctx,
    store,
    sandbox,
    queue,
    cms,
    app,
    config,
    dataDir,
    call,
    async json(method, p, body) {
      const res = await call(method, p, body);
      return { status: res.status, body: await res.json() };
    },
  };
}

/** Create a project through the API and run its provisioning to Active. */
export async function activeProject(e: TestEngine, id = "demo-app"): Promise<string> {
  const res = await e.json("POST", "/v1/projects", { projectId: id, description: "d" });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await e.queue.drain();
  return res.body.data.projectId as string;
}
