/**
 * Development seed: idempotent (run it as often as you like), never in production.
 *
 * Accounts (documented in README.md):
 *   user@example.com  / user-password   role user
 *   admin@example.com / admin-password  role admin
 *   other@example.com / other-password  role user (a second user, for ownership tests)
 *
 * Add every entity's data below the users, upserting by natural key.
 */
import { eq } from "drizzle-orm";
import { env } from "@/env";
import { closeDb, db } from "@/db/client";
import { user, type UserRole } from "@/db/schema";
import { getAuth } from "@/modules/auth/infrastructure/auth";

export const SEED_USERS: { email: string; name: string; password: string; role: UserRole }[] = [
  { email: "user@example.com", name: "Uma User", password: "user-password", role: "user" },
  { email: "admin@example.com", name: "Ada Admin", password: "admin-password", role: "admin" },
  { email: "other@example.com", name: "Otto Other", password: "other-password", role: "user" },
];

async function seedUsers(): Promise<void> {
  const auth = getAuth();
  for (const account of SEED_USERS) {
    const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, account.email)).limit(1);
    if (existing.length === 0) {
      await auth.api.signUpEmail({ body: { email: account.email, password: account.password, name: account.name } });
    }
    await db
      .update(user)
      .set({ role: account.role, emailVerified: true, name: account.name })
      .where(eq(user.email, account.email));
  }
}

export async function seed(): Promise<void> {
  if (env.NODE_ENV === "production") throw new Error("Refusing to seed a production database");
  await seedUsers();
}

// Run when executed directly (`npm run db:seed`), not when imported by tests.
if (process.argv[1] && /seed\.[cm]?[jt]s$/.test(process.argv[1])) {
  seed()
    .then(() => console.log(JSON.stringify({ level: "info", msg: "seed complete", users: SEED_USERS.length })))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
