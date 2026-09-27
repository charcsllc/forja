import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hasTestDatabase, useTestDatabase } from "../helpers/db";

describe.skipIf(!hasTestDatabase)("rateLimit (Postgres)", () => {
  const testDb = useTestDatabase();

  it("allows up to the limit, then refuses, per key", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rateLimit("test:a", { limit: 3, window: 60 }));
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(results[2]?.remaining).toBe(0);
    expect((await rateLimit("test:b", { limit: 3, window: 60 })).ok).toBe(true);
  });

  it("starts a new window once the old one has passed", async () => {
    const { rateLimit } = await import("@/lib/rate-limit");
    await rateLimit("test:c", { limit: 1, window: 60 });
    expect((await rateLimit("test:c", { limit: 1, window: 60 })).ok).toBe(false);
    await testDb().db.execute(
      sql`update internal.rate_limit set window_started_at = now() - interval '2 minutes' where key = 'test:c'`,
    );
    expect((await rateLimit("test:c", { limit: 1, window: 60 })).ok).toBe(true);
  });

  it("stores users with UUID v7 ids and timestamps", async () => {
    const { user } = await import("@/db/schema");
    const [row] = await testDb().db.insert(user).values({ name: "T", email: "t@example.com" }).returning();
    expect(row?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row?.role).toBe("user");
    expect(row?.createdAt).toBeInstanceOf(Date);
  });
});
