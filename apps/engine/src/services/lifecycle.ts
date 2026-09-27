/**
 * Sandbox lifecycle (04 §3, §5, §6): provision, wake, restart, rebuild, restore, archive,
 * remove. Each has a synchronous half (called by a route, BEFORE it answers) and a job half
 * (pg-boss worker).
 *
 * ⭐ THE SYNCHRONOUS HALF IS THE CONTRACT (research/02 §3, packages/contract-tests). The UI
 * polls immediately after every action, so the state it watches flips before the route
 * answers:
 *   restart  → agentServerStatus leaves `Active` (`Starting`, or `Unarchiving` when asleep)
 *   rebuild  → rebuild/status = `rebuilding` (a no-op rebuild reads `rebuilding` once, then `success`)
 *   recover  → project.versionRecovery = {status:"recovering", …}
 *   wake     → 409 SERVER_NOT_READY with the status already `Unarchiving`
 *
 * Other invariants:
 * - One heavy operation per project (operation slot); every job re-checks it still holds
 *   the slot's token before doing anything, and releases only its own token.
 * - A failed job never leaves a fake `Active`: provision/wake/restart failures keep the
 *   transitional status and set `serverError` (shown as `serverErrorMessage`); a rebuild
 *   failure is `rebuild/status = error` with `errorMessage`; a restore failure is
 *   `versionRecovery.status = error`.
 * - The engine attaches its own container to `forja-int-<id>` whenever the project's DB is
 *   up (the CMS talks to `forja-db-<id>` there) and detaches before the network is removed.
 * - Database passwords and BETTER_AUTH_SECRET are system secrets, generated once and reused
 *   by every re-provision, so a recreated app container always matches the database roles.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isRebuildRequiredPath } from "@forja/git";
import { APP_DATABASE, DB_SUPERUSER, names } from "@forja/sandbox";
import { EngineError, engineError, serverNotReady } from "../http/errors.js";
import type { ProjectRow } from "../store/types.js";
import type { EngineContext, JobData } from "./context.js";
import { OPERATION_TTL_MS, acquire, holds, tryAcquire } from "./operations.js";
import { projectRoot } from "./repo.js";
import { SYSTEM_SECRETS, envHash, generateSecretValue } from "./secrets.js";

/** Statuses from which a sandbox endpoint must wait. */
const TRANSITIONAL = ["Creating", "Starting", "Unarchiving", "Archiving"] as const;

const NPM_CI = ["npm", "ci", "--prefer-offline", "--no-audit", "--no-fund"] as const;
const DB_MIGRATE = ["npm", "run", "--silent", "db:migrate"] as const;
const DB_SEED = ["npm", "run", "--silent", "db:seed"] as const;

function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 1000 ? `${msg.slice(0, 1000)}…` : msg;
}

function tail(text: string, lines = 30): string {
  return text.split("\n").slice(-lines).join("\n").trim();
}

// ── Environment ──────────────────────────────────────────────────────────────

export interface DbPasswordsOut {
  superuser: string;
  app_rw: string;
  cms_ro: string;
  cms_rw: string;
}

export async function dbPasswords(ctx: EngineContext, projectId: string): Promise<DbPasswordsOut> {
  return {
    superuser: await ctx.secrets.ensureSystem(projectId, SYSTEM_SECRETS.dbSuperuser),
    app_rw: await ctx.secrets.ensureSystem(projectId, SYSTEM_SECRETS.dbAppRw),
    cms_ro: await ctx.secrets.ensureSystem(projectId, SYSTEM_SECRETS.dbCmsRo),
    cms_rw: await ctx.secrets.ensureSystem(projectId, SYSTEM_SECRETS.dbCmsRw),
  };
}

/**
 * The dev container's extra env: user secrets (development|both) + what the template
 * requires from the platform (BETTER_AUTH_SECRET) + the UI origin allowed to frame the
 * preview. DATABASE_URL, NEXT_PUBLIC_APP_URL and INTERNAL_APP_URL are set by the sandbox.
 */
export async function renderAppEnv(ctx: EngineContext, projectId: string): Promise<Record<string, string>> {
  const user = await ctx.secrets.renderUser(projectId, "development");
  const webOrigin = new URL(ctx.config.WEB_PUBLIC_URL).origin;
  return {
    ...user,
    BETTER_AUTH_SECRET: await ctx.secrets.ensureSystem(projectId, SYSTEM_SECRETS.betterAuth, () => generateSecretValue(32)),
    ALLOWED_FRAME_ANCESTORS: webOrigin,
  };
}

// ── Engine ↔ project network ─────────────────────────────────────────────────

export async function attachEngine(ctx: EngineContext, projectId: string): Promise<void> {
  if (!ctx.selfContainer) return;
  try {
    await ctx.sandbox.docker.connectNetwork(names.internalNetwork(projectId), ctx.selfContainer);
  } catch (err) {
    ctx.logger.warn({ err, projectId }, "could not attach the engine to the project network (Database tab unavailable)");
  }
}

export async function detachEngine(ctx: EngineContext, projectId: string): Promise<void> {
  await ctx.cms.release(projectId).catch(() => undefined);
  if (!ctx.selfContainer) return;
  await ctx.sandbox.docker.disconnectNetwork(names.internalNetwork(projectId), ctx.selfContainer).catch(() => false);
}

// ── Readiness, migrations, dumps ─────────────────────────────────────────────

async function waitReady(ctx: EngineContext, projectId: string): Promise<void> {
  const timeout = ctx.config.SANDBOX_START_TIMEOUT_SEC;
  const result = await ctx.sandbox.waitHttpReady(names.appContainer(projectId), "/", timeout, {
    probe: ctx.probe,
    intervalMs: ctx.readyIntervalMs ?? 1500,
  });
  if (!result.ready) {
    const logs = await ctx.sandbox.logs(names.appContainer(projectId), { tail: 40 }).catch(() => "");
    throw new Error(
      `The app did not answer on port 3000 within ${timeout}s (last status ${result.status ?? "none"}).${logs ? `\n${tail(logs, 20)}` : ""}`,
    );
  }
}

/** `npm run db:migrate` inside the app container (forward-only, idempotent). */
export async function migrate(ctx: EngineContext, projectId: string): Promise<void> {
  const r = await ctx.sandbox.exec(names.appContainer(projectId), [...DB_MIGRATE], { timeoutSec: 300, maxOutputBytes: 256 * 1024 });
  if (r.exitCode !== 0) throw new Error(`Database migrations failed (exit ${r.exitCode}): ${tail(`${r.stdout}\n${r.stderr}`)}`);
}

/**
 * `npm run db:seed` inside the app container. The template's seed is idempotent (upserts by
 * natural key) and creates the `user`/`admin`/`other` development accounts the database tab
 * and the security agent rely on. A failure never blocks provisioning: the app still runs
 * without sample data, so it is logged, not thrown.
 */
async function seed(ctx: EngineContext, projectId: string): Promise<void> {
  const r = await ctx.sandbox.exec(names.appContainer(projectId), [...DB_SEED], { timeoutSec: 300, maxOutputBytes: 256 * 1024 });
  if (r.exitCode !== 0) {
    ctx.logger.warn({ projectId, exitCode: r.exitCode, output: tail(`${r.stdout}\n${r.stderr}`, 10) }, "database seed failed; continuing without sample data");
  }
}

async function npmCi(ctx: EngineContext, projectId: string): Promise<void> {
  const r = await ctx.sandbox.exec(names.appContainer(projectId), [...NPM_CI], { timeoutSec: 900, maxOutputBytes: 512 * 1024 });
  if (r.exitCode !== 0) throw new Error(`npm ci failed (exit ${r.exitCode}): ${tail(`${r.stdout}\n${r.stderr}`)}`);
}

/** Plain-SQL `pg_dump` of the `app` database into `backups/`. Returns the file path. */
export async function dumpAppDatabase(ctx: EngineContext, projectId: string, label: string): Promise<string> {
  const r = await ctx.sandbox.docker.exec(
    names.dbContainer(projectId),
    ["pg_dump", "-U", DB_SUPERUSER, "-d", APP_DATABASE, "--no-owner", "--no-privileges"],
    { user: "postgres", timeoutSec: 300, maxOutputBytes: 512 * 1024 * 1024 },
  );
  if (r.exitCode !== 0) throw new Error(`pg_dump failed (exit ${r.exitCode}): ${tail(r.stderr, 5)}`);
  if (r.truncated) throw new Error("pg_dump output exceeded 512 MB; the backup was not written");
  const dir = path.join(projectRoot(ctx.config.DATA_DIR, projectId), "backups");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.sql`);
  await writeFile(file, r.stdout, { mode: 0o600 });
  return file;
}

async function templateVersion(dir: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(dir, "template.json"), "utf8")) as { version?: unknown };
    return typeof raw.version === "string" ? raw.version : null;
  } catch {
    return null;
  }
}

// ── Wake semantics (05 §2.2) ─────────────────────────────────────────────────

/**
 * Guard of every endpoint that needs the sandbox (or its DB). Active → returns. Asleep →
 * starts the wake (status `Unarchiving` before answering) and throws 409 SERVER_NOT_READY.
 * Any transitional status → 409 SERVER_NOT_READY; a transitional status left behind by a
 * failed job (error set, no operation running) is retried here.
 */
export async function requireLive(ctx: EngineContext, p: ProjectRow): Promise<void> {
  if (p.serverStatus === "Active") return;
  if (p.serverStatus === "Archived") {
    await startWake(ctx, p);
    throw serverNotReady("The project's server was asleep and is starting; try again in a moment.");
  }
  if ((TRANSITIONAL as readonly string[]).includes(p.serverStatus) && p.serverError && !(await ctx.store.getOperation(p.id))) {
    if (p.serverStatus === "Creating") await startProvision(ctx, p.id);
    else await startRestart(ctx, p, { quiet: true });
  }
  throw serverNotReady();
}

export async function startWake(ctx: EngineContext, p: ProjectRow): Promise<boolean> {
  const slot = await tryAcquire(ctx.store, p.id, "wake");
  if (!slot.ok) return false;
  const moved = await ctx.store.updateProjectIfStatus(p.id, ["Archived"], { serverStatus: "Unarchiving", serverError: null });
  if (!moved) {
    await ctx.store.releaseOperation(p.id, slot.token);
    return false;
  }
  await ctx.queue.send("sandbox.wake", { projectId: p.id, token: slot.token });
  return true;
}

// ── Provision ────────────────────────────────────────────────────────────────

/** Takes the provision slot and queues `sandbox.provision`. False when an operation already runs. */
export async function startProvision(ctx: EngineContext, projectId: string): Promise<boolean> {
  const slot = await tryAcquire(ctx.store, projectId, "provision");
  if (!slot.ok) return false;
  await ctx.store.updateProject(projectId, { serverStatus: "Creating", serverError: null });
  await ctx.queue.send("sandbox.provision", { projectId, token: slot.token });
  return true;
}

/** Brings containers to the state of the template/repo; used by provision and full re-creation. */
async function provisionSandbox(ctx: EngineContext, p: ProjectRow): Promise<void> {
  const env = await renderAppEnv(ctx, p.id);
  const passwords = await dbPasswords(ctx, p.id);
  await ctx.store.updateProject(p.id, { serverStatus: "Creating" });
  const res = await ctx.sandbox.provision(p.id, { dbPasswords: passwords, env });
  if (!(await ctx.store.getProject(p.id))) {
    // Deleted while the containers were being created: do not leave them behind.
    await detachEngine(ctx, p.id);
    await ctx.sandbox.remove(p.id);
    throw new Error("The project was deleted while it was being provisioned.");
  }
  await ctx.cms.release(p.id);
  await attachEngine(ctx, p.id);
  await ctx.store.updateProject(p.id, { serverStatus: "Starting", devUrl: res.previewUrl, internalDevUrl: res.internalUrl });
  await waitReady(ctx, p.id);
  await migrate(ctx, p.id);
  await seed(ctx, p.id);
  const head = await ctx.repo(p.id).headSha();
  await ctx.store.updateProject(p.id, {
    serverStatus: "Active",
    serverError: null,
    archivedAt: null,
    rebuildSha: head,
    rebuildEnvHash: envHash(env),
    lastActivityAt: new Date(),
  });
}

export async function provisionJob(ctx: EngineContext, job: JobData): Promise<void> {
  await runSlotJob(ctx, job, "provision", async (p) => {
    const repo = ctx.repo(p.id);
    if (!(await repo.exists())) {
      // A previous attempt may have died between `git init` and the first commit: start the
      // repository over (nothing in it was ever committed or shown to the user).
      await rm(path.join(repo.root, "repo.git"), { recursive: true, force: true });
      await rm(path.join(repo.root, "work"), { recursive: true, force: true });
      await repo.initFromTemplate(ctx.config.TEMPLATE_DIR);
    }
    const version = await templateVersion(ctx.config.TEMPLATE_DIR);
    if (version && !p.templateVersion) await ctx.store.updateProject(p.id, { templateVersion: version });
    await provisionSandbox(ctx, p);
  });
}

// ── Wake / restart ───────────────────────────────────────────────────────────

/**
 * `agent/server/start-or-restart`. Leaves `Active` synchronously. When a wake or provision
 * already runs it answers without starting another (the status is already not Active).
 */
export async function startRestart(ctx: EngineContext, p: ProjectRow, { quiet = false }: { quiet?: boolean } = {}): Promise<void> {
  const current = await ctx.store.getOperation(p.id);
  if (current && current.expiresAt.getTime() > Date.now() && ["wake", "provision", "restartServer"].includes(current.kind)) return;
  if (p.serverStatus === "Creating" && !p.serverError) return;
  const token = quiet
    ? await tryAcquire(ctx.store, p.id, "restartServer").then((r) => (r.ok ? r.token : null))
    : await acquire(ctx.store, p.id, "restartServer");
  if (!token) return;
  const asleep = p.serverStatus === "Archived" || p.serverStatus === "Archiving";
  await ctx.store.updateProject(p.id, { serverStatus: asleep ? "Unarchiving" : "Starting", serverError: null });
  await ctx.queue.send("sandbox.restart", { projectId: p.id, token });
}

/** Wake and restart share one job body: bring everything up, restarting the app if it ran. */
async function bringUp(ctx: EngineContext, p: ProjectRow, restartApp: boolean): Promise<void> {
  const app = await ctx.sandbox.docker.inspectContainer(names.appContainer(p.id));
  const db = await ctx.sandbox.docker.inspectContainer(names.dbContainer(p.id));
  if (!app || !db) {
    // Containers are gone (deleted then undeleted, or removed by hand): re-create them.
    await provisionSandbox(ctx, p);
    return;
  }
  const network = await ctx.sandbox.docker.inspectNetwork(names.internalNetwork(p.id));
  if (app.running && db.running && network && restartApp) {
    await ctx.sandbox.restart(p.id);
  } else if (!(app.running && db.running && network)) {
    await ctx.sandbox.unarchive(p.id);
  }
  await attachEngine(ctx, p.id);
  await ctx.store.updateProject(p.id, { serverStatus: "Starting" });
  await waitReady(ctx, p.id);
  await ctx.store.updateProject(p.id, { serverStatus: "Active", serverError: null, archivedAt: null, lastActivityAt: new Date() });
}

export async function wakeJob(ctx: EngineContext, job: JobData): Promise<void> {
  await runSlotJob(ctx, job, "wake", (p) => bringUp(ctx, p, false));
}

export async function restartJob(ctx: EngineContext, job: JobData): Promise<void> {
  await runSlotJob(ctx, job, "restartServer", (p) => bringUp(ctx, p, true));
}

// ── Rebuild ──────────────────────────────────────────────────────────────────

export interface RebuildPlan {
  noop: boolean;
  head: string | null;
  configChanged: boolean;
  lockfileChanged: boolean;
  envChanged: boolean;
}

export async function planRebuild(ctx: EngineContext, p: ProjectRow): Promise<RebuildPlan & { env: Record<string, string> }> {
  const repo = ctx.repo(p.id);
  const head = await repo.flush();
  const env = await renderAppEnv(ctx, p.id);
  const envChanged = envHash(env) !== p.rebuildEnvHash;
  let configChanged = false;
  let lockfileChanged = false;
  if (!p.rebuildSha || !head) {
    configChanged = true;
    lockfileChanged = true;
  } else if (p.rebuildSha !== head) {
    const changed = await repo.changedFiles(p.rebuildSha, head);
    configChanged = changed.some((f) => isRebuildRequiredPath(f));
    lockfileChanged = await repo.lockfileChanged(p.rebuildSha, head);
  }
  return { noop: !configChanged && !envChanged, head, configChanged, lockfileChanged, envChanged, env };
}

/** `POST rebuild`: `rebuilding` before answering; a no-op resolves on the next status read. */
export async function startRebuild(ctx: EngineContext, p: ProjectRow): Promise<{ status: "rebuilding"; startedAt: string }> {
  const token = await acquire(ctx.store, p.id, "rebuild");
  const startedAt = new Date();
  try {
    const plan = await planRebuild(ctx, p);
    await ctx.store.updateProject(p.id, {
      rebuildStatus: "rebuilding",
      rebuildStartedAt: startedAt,
      rebuildError: null,
      rebuildNoop: plan.noop,
    });
    if (plan.noop) {
      await ctx.store.releaseOperation(p.id, token);
    } else {
      await ctx.queue.send("sandbox.rebuild", {
        projectId: p.id,
        token,
        head: plan.head,
        lockfileChanged: plan.lockfileChanged,
        envChanged: plan.envChanged,
      });
    }
  } catch (err) {
    await ctx.store.releaseOperation(p.id, token);
    throw err;
  }
  return { status: "rebuilding", startedAt: startedAt.toISOString() };
}

/** `GET rebuild/status`. */
export async function readRebuildStatus(ctx: EngineContext, p: ProjectRow): Promise<{ status: string; errorMessage?: string }> {
  if (p.rebuildStatus === "rebuilding" && p.rebuildNoop) {
    // The first read after a no-op rebuild still says `rebuilding` (the UI's first poll must);
    // the next one says `success`.
    const head = await ctx.repo(p.id).headSha();
    await ctx.store.updateProject(p.id, { rebuildStatus: "success", rebuildNoop: false, rebuildSha: head ?? p.rebuildSha });
    return { status: "rebuilding" };
  }
  if (p.rebuildStatus === "rebuilding") {
    const op = await ctx.store.getOperation(p.id);
    if (!op || op.kind !== "rebuild" || op.expiresAt.getTime() < Date.now()) {
      const msg = "The rebuild was interrupted (engine restart or timeout). Start it again.";
      await ctx.store.updateProject(p.id, { rebuildStatus: "error", rebuildError: msg });
      return { status: "error", errorMessage: msg };
    }
  }
  if (p.rebuildStatus === "error") return { status: "error", errorMessage: p.rebuildError ?? "The rebuild failed." };
  return { status: p.rebuildStatus };
}

export async function rebuildJob(ctx: EngineContext, job: JobData): Promise<void> {
  const envChanged = job.envChanged === true;
  const lockChanged = job.lockfileChanged === true;
  await runSlotJob(
    ctx,
    job,
    "rebuild",
    async (p) => {
      const env = await renderAppEnv(ctx, p.id);
      if (envChanged) {
        // New env only reaches a container through re-creation (provision is idempotent and
        // keeps the database, its volume and the passwords).
        const passwords = await dbPasswords(ctx, p.id);
        await ctx.store.updateProject(p.id, { serverStatus: "Starting" });
        await ctx.sandbox.provision(p.id, { dbPasswords: passwords, env });
        await attachEngine(ctx, p.id);
        await waitReady(ctx, p.id);
      } else {
        if (lockChanged) await npmCi(ctx, p.id);
        await ctx.store.updateProject(p.id, { serverStatus: "Starting" });
        await ctx.sandbox.restart(p.id);
        await attachEngine(ctx, p.id);
        await waitReady(ctx, p.id);
      }
      await migrate(ctx, p.id);
      const head = await ctx.repo(p.id).headSha();
      await ctx.store.updateProject(p.id, {
        serverStatus: "Active",
        serverError: null,
        rebuildStatus: "success",
        rebuildError: null,
        rebuildSha: head,
        rebuildEnvHash: envHash(env),
        lastActivityAt: new Date(),
      });
    },
    async (p, err) => {
      await ctx.store.updateProject(p.id, { rebuildStatus: "error", rebuildError: errorMessage(err) });
      // The server may be half-restarted: Active only if it still runs, else say why.
      const running = await ctx.sandbox.docker.inspectContainer(names.appContainer(p.id)).catch(() => null);
      await ctx.store.updateProject(
        p.id,
        running?.running ? { serverStatus: "Active" } : { serverStatus: "Starting", serverError: errorMessage(err) },
      );
    },
  );
}

// ── Restore ──────────────────────────────────────────────────────────────────

/** `POST versions/:id/recover`: `versionRecovery` is set before answering. */
export async function startRestore(ctx: EngineContext, p: ProjectRow, versionId: string): Promise<void> {
  const sha = await ctx.repo(p.id).resolve(versionId);
  if (!sha) throw engineError("VERSION_NOT_FOUND", `Unknown version: ${versionId}`);
  const token = await acquire(ctx.store, p.id, "restoreVersion", { versionId });
  await ctx.store.updateProject(p.id, {
    versionRecovery: { status: "recovering", versionId, startedAt: new Date().toISOString() },
  });
  await ctx.queue.send("version.restore", { projectId: p.id, token, versionId, sha });
}

export async function restoreJob(ctx: EngineContext, job: JobData): Promise<void> {
  const sha = String(job.sha);
  const versionId = String(job.versionId);
  await runSlotJob(
    ctx,
    job,
    "restoreVersion",
    async (p) => {
      const repo = ctx.repo(p.id);
      const before = await repo.flush();
      // The schema only moves forward (04 §6): keep a dump of `app` from before the restore.
      await dumpAppDatabase(ctx, p.id, `before-restore-${sha.slice(0, 7)}`);
      const result = await repo.restore(sha);
      if (result.changed && before) {
        const changed = await repo.changedFiles(before, result.commitSha);
        if (changed.some((f) => isRebuildRequiredPath(f))) {
          if (await repo.lockfileChanged(before, result.commitSha)) await npmCi(ctx, p.id);
          await ctx.store.updateProject(p.id, { serverStatus: "Starting" });
          await ctx.sandbox.restart(p.id);
          await attachEngine(ctx, p.id);
          await waitReady(ctx, p.id);
          await migrate(ctx, p.id);
          await ctx.store.updateProject(p.id, { serverStatus: "Active", rebuildSha: result.commitSha });
        }
      }
      await ctx.store.updateProject(p.id, { versionRecovery: null, lastActivityAt: new Date() });
    },
    async (p, err) => {
      await ctx.store.updateProject(p.id, {
        versionRecovery: { status: "error", versionId, startedAt: new Date().toISOString(), errorMessage: errorMessage(err) },
      });
      const running = await ctx.sandbox.docker.inspectContainer(names.appContainer(p.id)).catch(() => null);
      if (running?.running && p.serverStatus !== "Active") await ctx.store.updateProject(p.id, { serverStatus: "Active" });
    },
  );
}

/** `DELETE versions/recovery`: clears a failed (or abandoned) recovery marker. */
export async function clearRecovery(ctx: EngineContext, p: ProjectRow): Promise<void> {
  const rec = p.versionRecovery as { status?: string } | null;
  if (!rec) return;
  const op = await ctx.store.getOperation(p.id);
  if (rec.status === "recovering" && op?.kind === "restoreVersion" && op.expiresAt.getTime() > Date.now()) {
    throw engineError("OPERATION_IN_PROGRESS", "The restore is still running.", { operation: "restoreVersion" });
  }
  await ctx.store.updateProject(p.id, { versionRecovery: null });
}

// ── Archive / remove ─────────────────────────────────────────────────────────

/** Engine-only (v2): put an Active project to sleep now (phase 4 adds the idle timer). */
export async function startArchive(ctx: EngineContext, p: ProjectRow): Promise<void> {
  if (p.serverStatus === "Archived") return;
  if (p.serverStatus !== "Active") throw serverNotReady("Only an active project can be archived.");
  const token = await acquire(ctx.store, p.id, "archive");
  await ctx.store.updateProject(p.id, { serverStatus: "Archiving" });
  await ctx.queue.send("sandbox.archive", { projectId: p.id, token });
}

export async function archiveJob(ctx: EngineContext, job: JobData): Promise<void> {
  await runSlotJob(ctx, job, "archive", async (p) => {
    await ctx.repo(p.id).flush();
    await dumpAppDatabase(ctx, p.id, "archive").catch((err: unknown) =>
      ctx.logger.warn({ err, projectId: p.id }, "pg_dump before archive failed; archiving anyway"),
    );
    await detachEngine(ctx, p.id);
    await ctx.sandbox.archive(p.id);
    await ctx.store.updateProject(p.id, { serverStatus: "Archived", archivedAt: new Date() });
  });
}

export async function removeJob(ctx: EngineContext, job: JobData): Promise<void> {
  const p = await ctx.store.getProject(job.projectId, { includeDeleted: true });
  if (!p) return;
  try {
    await ctx.repo(p.id).flush().catch(() => null);
    await detachEngine(ctx, p.id);
    await ctx.sandbox.remove(p.id);
  } catch (err) {
    ctx.logger.error({ err, projectId: p.id }, "sandbox removal failed");
  } finally {
    await ctx.store.releaseOperation(p.id, job.token);
  }
}

/** Soft delete: `deleted_at` + `purge_after` now; containers and the network go in a job. */
export async function deleteProject(ctx: EngineContext, p: ProjectRow): Promise<void> {
  const now = new Date();
  // A delete wins over whatever runs: drop the slot so the removal job can take it.
  const op = await ctx.store.getOperation(p.id);
  if (op) await ctx.store.releaseOperation(p.id, (op.payload as { token: string }).token);
  await ctx.store.updateProject(p.id, {
    deletedAt: now,
    purgeAfter: new Date(now.getTime() + ctx.config.PROJECT_PURGE_AFTER_DAYS * 86_400_000),
    serverStatus: "Archived",
    versionRecovery: null,
    rebuildStatus: "idle",
    rebuildNoop: false,
  });
  const slot = await tryAcquire(ctx.store, p.id, "remove");
  await ctx.queue.send("sandbox.remove", { projectId: p.id, token: slot.ok ? slot.token : "none" });
}

export async function undeleteProject(ctx: EngineContext, projectId: string): Promise<ProjectRow> {
  const p = await ctx.store.getProject(projectId, { includeDeleted: true });
  if (!p) throw new EngineError(404, "PROJECT_NOT_FOUND", "Project not found");
  if (!p.deletedAt) return p;
  if (p.purgeAfter && p.purgeAfter.getTime() < Date.now()) {
    throw new EngineError(404, "PROJECT_NOT_FOUND", "The project was already purged.");
  }
  const restored = await ctx.store.updateProject(projectId, { deletedAt: null, purgeAfter: null, serverStatus: "Creating" });
  await startProvision(ctx, projectId);
  return restored ?? p;
}

// ── Job plumbing ─────────────────────────────────────────────────────────────

/**
 * Runs a job body while holding the operation slot: skips when the slot moved on (a newer
 * operation or a delete), records failures, always releases its own token.
 */
async function runSlotJob(
  ctx: EngineContext,
  job: JobData,
  kind: string,
  body: (p: ProjectRow) => Promise<void>,
  onError?: (p: ProjectRow, err: unknown) => Promise<void>,
): Promise<void> {
  const { projectId, token } = job;
  if (!(await holds(ctx.store, projectId, token))) {
    ctx.logger.info({ projectId, kind }, "job skipped: its operation slot is gone");
    return;
  }
  const p = await ctx.store.getProject(projectId);
  if (!p) {
    await ctx.store.releaseOperation(projectId, token);
    return;
  }
  const keepAlive = setInterval(() => {
    void ctx.store.extendOperation(projectId, token, OPERATION_TTL_MS.provision).catch(() => undefined);
  }, 60_000);
  keepAlive.unref();
  const started = Date.now();
  try {
    await body(p);
    ctx.logger.info({ projectId, kind, ms: Date.now() - started }, "job finished");
  } catch (err) {
    ctx.logger.error({ err, projectId, kind }, "job failed");
    try {
      if (onError) await onError(p, err);
      else await ctx.store.updateProject(projectId, { serverError: errorMessage(err) });
    } catch (inner) {
      ctx.logger.error({ err: inner, projectId, kind }, "could not record the job failure");
    }
  } finally {
    clearInterval(keepAlive);
    await ctx.store.releaseOperation(projectId, token);
  }
}
