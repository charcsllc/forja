import { env } from "@/env";
import { schedule, work } from "@/lib/jobs";
import { logger } from "@/lib/logger";
import { handlers, schedules } from "./index";

/** Start every registered handler and schedule. No-op when nothing is registered. */
export async function startJobs(): Promise<void> {
  if (env.JOBS_MODE === "off") return;
  const names = Object.keys(handlers);
  if (names.length === 0 && schedules.length === 0) return;
  for (const name of names) {
    const handler = handlers[name];
    if (handler) await work(name, handler);
  }
  for (const entry of schedules) await schedule(entry.name, entry.cron, entry.payload);
  logger.info({ queues: names, schedules: schedules.map((entry) => entry.name) }, "jobs started");
}
