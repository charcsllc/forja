import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/** True when the database answers a trivial query within `timeoutMs`. */
export async function isDatabaseReachable(timeoutMs = 2000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("database timeout")), timeoutMs);
    });
    await Promise.race([db.execute(sql`select 1`), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
