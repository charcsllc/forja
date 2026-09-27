/**
 * Infrastructure tables live in the `internal` schema so the builder's database tab (which
 * shows `public`) never lists them. Business tables belong in `public`.
 */
import { integer, pgSchema, text, timestamp } from "drizzle-orm/pg-core";
import { id, timestamps } from "./columns";

export const internal = pgSchema("internal");

/** Fixed-window counters for `lib/rate-limit.ts`. One row per key. */
export const rateLimit = internal.table("rate_limit", {
  id: id(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps(),
});
