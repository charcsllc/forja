/**
 * Job queue: pg-boss on the engine database, schema `pgboss` (05 §1).
 * Phase 0 registers no jobs; phases 1+ call `registerJob` before or after `startQueue`.
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
export async function registerJob<T extends object = object>(
  name: string,
  handler: JobHandler<T>,
): Promise<string> {
  const b = getQueue();
  await b.createQueue(name);
  return b.work<T>(name, async (jobs) => {
    const results: unknown[] = [];
    for (const job of jobs) results.push(await handler(job));
    return results;
  });
}
