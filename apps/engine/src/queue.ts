/**
 * Job queue: pg-boss on the engine database, schema `pgboss` (05 §1).
 *
 * Phase 1 jobs (`sandbox.*`, `version.restore`) are registered by `src/jobs.ts`. They are
 * created with `retryLimit: 0`: every job belongs to an operation slot and is idempotent
 * per token, and the boot sequence re-queues what an engine restart interrupted, so a
 * blind pg-boss retry could only duplicate work.
 */
import { PgBoss, type Job } from "pg-boss";
import type { Logger } from "./logger.js";

export const QUEUE_SCHEMA = "pgboss";

let boss: PgBoss | null = null;

export async function startQueue(databaseUrl: string, logger: Logger): Promise<PgBoss> {
  if (boss) return boss;
  const instance = new PgBoss({ connectionString: databaseUrl, schema: QUEUE_SCHEMA });
  instance.on("error", (err) => logger.error({ err }, "queue error"));
  await instance.start();
  boss = instance;
  logger.info({ schema: QUEUE_SCHEMA }, "queue started");
  return instance;
}

export async function stopQueue(timeoutMs = 20_000): Promise<void> {
  if (!boss) return;
  const b = boss;
  boss = null;
  await b.stop({ graceful: true, timeout: timeoutMs });
}

export function getQueue(): PgBoss {
  if (!boss) throw new Error("queue not started");
  return boss;
}

/** Health probe: started and its schema is installed. */
export async function pingQueue(): Promise<boolean> {
  if (!boss) return false;
  try {
    return await boss.isInstalled();
  } catch {
    return false;
  }
}

export type JobHandler<T> = (job: Job<T>) => Promise<unknown>;

/**
 * Create the queue if needed and start a worker. pg-boss hands batches to `work`; this
 * helper calls `handler` once per job so handlers stay simple.
 */
export interface RegisterOptions {
  /** Parallel workers for this queue in this process (default 4: several projects at once). */
  localConcurrency?: number;
  /** A job older than this is failed by pg-boss (default 30 min). */
  expireInSeconds?: number;
}

export async function registerJob<T extends object = object>(
  name: string,
  handler: JobHandler<T>,
  { localConcurrency = 4, expireInSeconds = 1800 }: RegisterOptions = {},
): Promise<string> {
  const b = getQueue();
  await b.createQueue(name, { retryLimit: 0, expireInSeconds });
  return b.work<T>(name, { localConcurrency, batchSize: 1, pollingIntervalSeconds: 1 }, async (jobs) => {
    const results: unknown[] = [];
    for (const job of jobs) results.push(await handler(job));
    return results;
  });
}

/**
 * `singletonKey` makes a re-send of the same job (same operation token) a no-op while the
 * first one is queued or active, so boot-time resumption can never run a job twice.
 */
export async function sendJob(name: string, data: object, singletonKey?: string, expireInSeconds = 1800): Promise<void> {
  await getQueue().send(name, data, { retryLimit: 0, expireInSeconds, ...(singletonKey ? { singletonKey } : {}) });
}
