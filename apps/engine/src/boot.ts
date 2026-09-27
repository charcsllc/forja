/**
 * Boot-time checks and recovery (04 §1, §3).
 *
 * 1. `hostPathCheck`: DATA_DIR (engine view) and DATA_DIR_HOST (daemon view) must be the same
 *    folder, or every bind mount of every sandbox is wrong. Mismatch = refuse to boot, unless
 *    `SANDBOX_DRIVER=process` (developing Forja itself without Docker).
 * 2. `forja-apps` must exist (Traefik routes previews on it); created when missing.
 * 3. Operation slots left by a previous process: a live slot's job is re-queued (jobs are
 *    idempotent and de-duplicated by token); an expired slot is freed and the state it was
 *    driving is marked failed, so nothing stays "in progress" forever.
 * 4. Active projects: the engine re-attaches to their internal networks (a recreated engine
 *    container lost them), so the Database tab works without a restart of each project.
 */
import { APPS_NETWORK, names } from "@forja/sandbox";
import type { EngineContext, JobName } from "./services/context.js";
import { attachEngine } from "./services/lifecycle.js";
import type { OperationKind, OperationRow } from "./store/types.js";

export const JOB_FOR_KIND: Readonly<Record<OperationKind, JobName>> = {
  provision: "sandbox.provision",
  wake: "sandbox.wake",
  restartServer: "sandbox.restart",
  rebuild: "sandbox.rebuild",
  restoreVersion: "version.restore",
  archive: "sandbox.archive",
  remove: "sandbox.remove",
};

export async function checkHostPath(ctx: EngineContext): Promise<"ok" | "skipped"> {
  if (ctx.config.SANDBOX_DRIVER === "process") {
    ctx.logger.warn("SANDBOX_DRIVER=process: host-path check skipped; sandboxes will not work without Docker");
    return "skipped";
  }
  const result = await ctx.sandbox.hostPathCheck();
  if (result.status !== "ok") {
    throw new Error(
      `DATA_DIR and DATA_DIR_HOST are not the same folder (${result.reason ?? "mismatch"}). ` +
        "Every sandbox bind mount depends on it; see infra/README.md.",
    );
  }
  return "ok";
}

export async function ensureAppsNetwork(ctx: EngineContext): Promise<void> {
  if (ctx.config.SANDBOX_DRIVER === "process") return;
  if (await ctx.sandbox.docker.inspectNetwork(APPS_NETWORK)) return;
  ctx.logger.warn({ network: APPS_NETWORK }, "creating the apps network (normally created by infra/compose.yaml)");
  await ctx.sandbox.docker.createNetwork({
    Name: APPS_NETWORK,
    Driver: "bridge",
    Internal: false,
    Labels: { "forja.role": "apps" },
    Options: { "com.docker.network.bridge.name": "fj-apps" },
  });
}

async function failInterrupted(ctx: EngineContext, op: OperationRow): Promise<void> {
  const msg = `The ${op.kind} operation was interrupted (engine restart or timeout).`;
  switch (op.kind) {
    case "rebuild":
      await ctx.store.updateProject(op.projectId, { rebuildStatus: "error", rebuildError: msg, rebuildNoop: false });
      break;
    case "restoreVersion": {
      const payload = op.payload as { versionId?: string };
      await ctx.store.updateProject(op.projectId, {
        versionRecovery: { status: "error", versionId: payload.versionId ?? "", startedAt: op.startedAt.toISOString(), errorMessage: msg },
      });
      break;
    }
    case "remove":
      break;
    default:
      await ctx.store.updateProject(op.projectId, { serverError: msg });
  }
}

/** Re-queues live slots, frees and fails expired ones. Returns what it did (for the log and tests). */
export async function resumeOperations(ctx: EngineContext, now = Date.now()): Promise<{ resumed: string[]; failed: string[] }> {
  const resumed: string[] = [];
  const failed: string[] = [];
  for (const op of await ctx.store.listOperations()) {
    const token = (op.payload as { token?: string }).token ?? "";
    const kind = op.kind as OperationKind;
    const job = JOB_FOR_KIND[kind];
    if (op.expiresAt.getTime() < now || !job) {
      await ctx.store.releaseOperation(op.projectId, token);
      await failInterrupted(ctx, op);
      failed.push(`${op.projectId}:${op.kind}`);
      continue;
    }
    const payload = op.payload as Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    if (kind === "rebuild") {
      // The plan was lost with the process: redo the full thing (re-create + reinstall).
      extra.envChanged = true;
      extra.lockfileChanged = true;
    }
    if (kind === "restoreVersion" && typeof payload.versionId === "string") {
      extra.versionId = payload.versionId;
      extra.sha = (await ctx.repo(op.projectId).resolve(payload.versionId)) ?? payload.versionId;
    }
    await ctx.queue.send(job, { projectId: op.projectId, token, ...extra });
    resumed.push(`${op.projectId}:${op.kind}`);
  }
  // Transitional statuses without a slot were left by a crash between two writes: flag them,
  // so the next request (requireLive) retries instead of waiting forever.
  const held = new Set((await ctx.store.listOperations()).map((o) => o.projectId));
  for (const p of await ctx.store.listProjects()) {
    if (held.has(p.id)) continue;
    if (["Creating", "Starting", "Unarchiving", "Archiving"].includes(p.serverStatus) && !p.serverError) {
      await ctx.store.updateProject(p.id, { serverError: "Interrupted by an engine restart." });
      failed.push(`${p.id}:${p.serverStatus}`);
    }
  }
  return { resumed, failed };
}

export async function reattachActive(ctx: EngineContext): Promise<void> {
  if (!ctx.selfContainer) return;
  for (const p of await ctx.store.listProjects()) {
    if (p.serverStatus !== "Active") continue;
    if (!(await ctx.sandbox.docker.inspectNetwork(names.internalNetwork(p.id)).catch(() => null))) continue;
    await attachEngine(ctx, p.id);
  }
}
