/**
 * The database connection. Lazy: nothing connects until the first query, so `next build` and
 * modules that only import types never need a database.
 *
 * `db` is the Drizzle instance for application code; `getSql()` is the raw `postgres` client
 * for the rare statement Drizzle cannot express. Scripts and tests call `closeDb()`.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

type State = { sql: postgres.Sql; db: Database };

// Survive Next.js dev hot reloads without opening a new pool each time.
const globalForDb = globalThis as unknown as { __appDb?: State };

function connect(): State {
  if (globalForDb.__appDb) return globalForDb.__appDb;
  const sql = postgres(env.DATABASE_URL, {
    max: env.NODE_ENV === "production" ? 10 : 5,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  const state: State = { sql, db: drizzle(sql, { schema }) };
  globalForDb.__appDb = state;
  return state;
}

export function getDb(): Database {
  return connect().db;
}

export function getSql(): postgres.Sql {
  return connect().sql;
}

/** Drizzle instance; connects on first use. */
export const db: Database = new Proxy({} as Database, {
  get(_target, key) {
    const real = getDb();
    const value = Reflect.get(real, key, real) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(real) : value;
  },
});

export async function closeDb(): Promise<void> {
  const state = globalForDb.__appDb;
  globalForDb.__appDb = undefined;
  await state?.sql.end({ timeout: 5 });
}
