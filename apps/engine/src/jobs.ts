/**
 * Wires the lifecycle job bodies (`services/lifecycle.ts`) to pg-boss, and provides the
 * `QueuePort` the services use to enqueue them.
 */
import type { EngineContext, JobData, JobName, QueuePort } from "./services/context.js";
import {
  archiveJob,
  provisionJob,
  rebuildJob,
  removeJob,
  restartJob,
  restoreJob,
  wakeJob,
} from "./services/lifecycle.js";
import { registerJob, sendJob, type RegisterOptions } from "./queue.js";
import { executeRun } from "./services/runs/orchestrator.js";

/** Runs outlive the 30 min default: the orchestrator bounds itself (turns, budget, gates). */
const RUN_JOB_EXPIRE_SECONDS = 8 * 60 * 60;

export const JOB_HANDLERS: Readonly<Record<JobName, (ctx: EngineContext, job: JobData) => Promise<void>>> = {
  "sandbox.provision": provisionJob,
  "sandbox.wake": wakeJob,
  "sandbox.restart": restartJob,
  "sandbox.rebuild": rebuildJob,
  "sandbox.archive": archiveJob,
  "sandbox.remove": removeJob,
  "version.restore": restoreJob,
  "run.execute": (ctx, job) => executeRun(ctx, typeof job.runId === "string" ? job.runId : job.token),
};

function registerOptions(ctx: EngineContext, name: JobName): RegisterOptions {
  if (name === "run.execute") return { localConcurrency: ctx.config.ENGINE_MAX_CONCURRENT_RUNS, expireInSeconds: RUN_JOB_EXPIRE_SECONDS };
  return {};
}

export const pgBossQueue: QueuePort = {
  send: (name, data) => sendJob(name, data, `${name}:${data.token}`, name === "run.execute" ? RUN_JOB_EXPIRE_SECONDS : undefined),
};

export async function registerJobs(ctx: EngineContext): Promise<void> {
  for (const [name, handler] of Object.entries(JOB_HANDLERS) as [JobName, (typeof JOB_HANDLERS)[JobName]][]) {
    await registerJob<JobData>(name, async (job) => {
      try {
        await handler(ctx, job.data);
      } catch (err) {
        // Job bodies record their own failures; this only catches bugs in the plumbing.
        ctx.logger.error({ err, job: name, projectId: job.data.projectId }, "job crashed");
      }
    }, registerOptions(ctx, name));
  }
}
