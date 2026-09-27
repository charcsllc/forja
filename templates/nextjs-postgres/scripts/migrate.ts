/**
 * Applies pending migrations from drizzle/migrations, forward-only.
 *
 * - Development: `npm run db:migrate` (tsx).
 * - Production: bundled by `npm run build:migrator` into dist/migrate.mjs (no node_modules
 *   needed) and run as a one-shot step BEFORE the app starts: `node migrate.mjs`.
 *
 * A Postgres advisory lock makes concurrent runs safe: the second waits, then finds nothing
 * to do. Needs only DATABASE_URL (MIGRATIONS_DIR overrides the folder).
 */
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const LOCK_ID = 7_261_390_417; // arbitrary, constant per app

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const migrationsFolder = path.resolve(process.env.MIGRATIONS_DIR ?? "drizzle/migrations");

  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 30 });
  const started = Date.now();
  try {
    await sql`select pg_advisory_lock(${LOCK_ID})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder });
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_ID})`;
    }
    console.log(
      JSON.stringify({ level: "info", msg: "migrations applied", folder: migrationsFolder, ms: Date.now() - started }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "migration failed",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
