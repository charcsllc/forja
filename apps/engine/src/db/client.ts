import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema/index.js";

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  sql: Sql;
  db: Db;
  /** `select 1` with a short timeout; used by /v2/system/health. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createDb(databaseUrl: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(databaseUrl, {
    max: opts.max ?? 10,
    onnotice: () => {},
    connection: { application_name: "forja-engine" },
  });
  const db = drizzle(sql, { schema });
  return {
    sql,
    db,
    async ping() {
      try {
        await Promise.race([
          sql`select 1`,
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000).unref()),
        ]);
        return true;
      } catch {
        return false;
      }
    },
    close: () => sql.end({ timeout: 5 }),
  };
}
