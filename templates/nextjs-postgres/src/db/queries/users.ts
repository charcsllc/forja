import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { user, type UserRole } from "@/db/schema";

export type UserSummary = { id: string; name: string; email: string; role: UserRole };

/** Served by the unique index on `user.email`. */
export async function findUserByEmail(email: string): Promise<UserSummary | null> {
  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email, role: user.role })
    .from(user)
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}
