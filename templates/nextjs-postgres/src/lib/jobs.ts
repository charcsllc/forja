/**
 * Background jobs on Postgres with pg-boss (its own `pgboss` schema; no Redis).
 *
 *   await enqueue("email.welcome", { userId }, { key: `welcome:${userId}` });
 *   await schedule("rate-limit.prune", "0 * * * *");
 *
 * Handlers are registered in `src/jobs/index.ts` and run in the web process
 * (`JOBS_MODE=inline`, default) via `src/instrumentation.ts`, or in a separate worker if
 * the project adds one. Handlers must be idempotent: a job can run more than once.
 */
import { PgBoss, type Job, type SendOptions } from "pg-boss";
import { env } from "@/env";
import { logger } from "@/lib/logger";

type State = { boss: PgBoss; ready: Promise<PgBoss>; queues: Set<string> };
const globalForJobs = globalThis as unknown as { __appJobs?: State };

function state(): State {
  if (globalForJobs.__appJobs) return globalForJobs.__appJobs;
  const boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: "pgboss" });
  boss.on("error", (error: unknown) => logger.error({ err: error }, "pg-boss error"));
  const created: State = { boss, ready: boss.start(), queues: new Set() };
  globalForJobs.__appJobs = created;
  return created;
}

async function queue(name: string): Promise<PgBoss> {
  const current = state();
  const boss = await current.ready;
  if (!current.queues.has(name)) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name);
    current.queues.add(name);
  }
  return boss;
}

export type EnqueueOptions = Omit<SendOptions, "singletonKey"> & {
  /** Idempotency key: a second job with the same key is not created while one is pending. */
  key?: string;
};

/** Queue a job. Returns the job id, or `null` when a job with the same key already exists. */
export async function enqueue<T extends object>(
  name: string,
  payload: T,
  options: EnqueueOptions = {},
): Promise<string | null> {
  const { key, ...rest } = options;
  const boss = await queue(name);
  return boss.send(name, payload, { ...rest, ...(key ? { singletonKey: key } : {}) });
}

/** Run `name` on a cron schedule (UTC unless `tz` is given). Idempotent: re-scheduling replaces it. */
export async function schedule<T extends object>(
  name: string,
  cron: string,
  payload?: T,
  options: { tz?: string } = {},
): Promise<void> {
  const boss = await queue(name);
  await boss.schedule(name, cron, payload ?? null, options);
}

export type JobHandler<T> = (job: Job<T>) => Promise<void>;

/** Start processing `name` with `handler`, one job at a time per worker. */
export async function work<T extends object>(name: string, handler: JobHandler<T>): Promise<string> {
  const boss = await queue(name);
  return boss.work<T>(name, async (jobs) => {
    for (const job of jobs) {
      await handler(job);
    }
  });
}

/** Stop workers and close the pool (scripts, tests, graceful shutdown). */
export async function stopJobs(): Promise<void> {
  const current = globalForJobs.__appJobs;
  globalForJobs.__appJobs = undefined;
  if (current) await (await current.ready).stop({ graceful: true, close: true, timeout: 30_000 });
}
