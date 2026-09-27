/**
 * Fixed-window rate limiting stored in Postgres (`internal.rate_limit`), so it holds across
 * processes and restarts without Redis. One atomic upsert per call.
 *
 *   const limit = await rateLimit(`sign-in:${ip}`, { limit: 5, window: 60 });
 *   if (!limit.ok) return err(new RateLimitedError());
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { defaultRandom } from "@/db/schema/columns";

export type RateLimitOptions = {
  /** Maximum number of hits allowed per window. */
  limit: number;
  /** Window length in seconds. */
  window: number;
};

export type RateLimitResult = {
  ok: boolean;
  /** Hits left in the current window (0 when refused). */
  remaining: number;
  /** When the current window ends. */
  resetAt: Date;
};

export async function rateLimit(key: string, { limit, window }: RateLimitOptions): Promise<RateLimitResult> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("rateLimit: limit must be a positive integer");
  if (!Number.isFinite(window) || window <= 0)
    throw new Error("rateLimit: window must be a positive number of seconds");

  const interval = `${window} seconds`;
  const rows = await db.execute<{ count: number; window_started_at: string | Date }>(sql`
    insert into internal.rate_limit (id, key, count, window_started_at)
    values (${defaultRandom()}, ${key}, 1, now())
    on conflict (key) do update set
      count = case
        when internal.rate_limit.window_started_at <= now() - ${interval}::interval then 1
        else internal.rate_limit.count + 1
      end,
      window_started_at = case
        when internal.rate_limit.window_started_at <= now() - ${interval}::interval then now()
        else internal.rate_limit.window_started_at
      end,
      updated_at = now()
    returning count, window_started_at
  `);

  const row = rows[0];
  if (!row) throw new Error("rateLimit: upsert returned no row");
  const count = Number(row.count);
  const resetAt = new Date(new Date(row.window_started_at).getTime() + window * 1000);
  return { ok: count <= limit, remaining: Math.max(0, limit - count), resetAt };
}

/** Delete counters whose window ended long ago. Schedule it (see `lib/jobs.ts`) if keys are unbounded. */
export async function pruneRateLimits(olderThanSeconds = 86_400): Promise<void> {
  await db.execute(
    sql`delete from internal.rate_limit where window_started_at < now() - ${`${olderThanSeconds} seconds`}::interval`,
  );
}
