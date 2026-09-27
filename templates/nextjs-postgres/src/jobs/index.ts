/**
 * Background job handlers, keyed by queue name. Each handler must be idempotent.
 *
 *   export const handlers: JobHandlers = {
 *     "email.welcome": async (job) => { ... },
 *   };
 *   export const schedules: JobSchedules = [{ name: "rate-limit.prune", cron: "0 * * * *" }];
 */
import type { JobHandler } from "@/lib/jobs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each handler narrows its own payload
export type JobHandlers = Record<string, JobHandler<any>>;
export type JobSchedules = { name: string; cron: string; payload?: object }[];

export const handlers: JobHandlers = {};
export const schedules: JobSchedules = [];
