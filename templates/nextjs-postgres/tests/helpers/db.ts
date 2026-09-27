/**
 * An isolated database per test file, built from DATABASE_URL_TEST.
 *
 *   const testDb = useTestDatabase();          // at the top of the file
 *   it("...", async () => { const { db } = testDb(); ... });
 *
 * `DATABASE_URL_TEST` points at a server and a database the tests may use. When its role
 * may CREATE DATABASE, each file gets a fresh `test_<random>` database (migrated, dropped
 * afterwards). Otherwise the database itself is migrated and every table in `public` and
 * `internal` is truncated after the file. Without DATABASE_URL_TEST, integration tests skip
 * themselves (`describe.skipIf(!hasTestDatabase)`).
 */
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";
import { resetEnvCache } from "@/env";
import { closeDb, getDb, type Database } from "@/db/client";

export const hasTestDatabase = Boolean(process.env.DATABASE_URL_TEST);

type TestDatabase = { db: Database; url: string };

async function createDatabase(baseUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = postgres(baseUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${name}"`);
  } catch (error) {
    await admin.end();
    if ((error as { code?: string }).code !== "42501") throw error; // not "insufficient privilege"
    return {
      url: baseUrl,
      drop: async () => {
        const sql = postgres(baseUrl, { max: 1, onnotice: () => {} });
        const tables = await sql<{ name: string }[]>`
          select format('%I.%I', schemaname, tablename) as name from pg_tables
          where schemaname in ('public', 'internal')`;
        if (tables.length > 0) await sql.unsafe(`truncate ${tables.map((t) => t.name).join(", ")} cascade`);
        await sql.end();
      },
    };
  }
  await admin.end();
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    drop: async () => {
      const sql = postgres(baseUrl, { max: 1, onnotice: () => {} });
      await sql.unsafe(`drop database if exists "${name}" with (force)`);
      await sql.end();
    },
  };
}

export function useTestDatabase(): () => TestDatabase {
  let current: TestDatabase | undefined;
  let drop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const base = process.env.DATABASE_URL_TEST;
    if (!base) throw new Error("DATABASE_URL_TEST is not set");
    const created = await createDatabase(base);
    drop = created.drop;

    const sql = postgres(created.url, { max: 1, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: path.resolve("drizzle/migrations") });
    await sql.end();

    // Point the app's lazy env + db client at the new database for this file.
    process.env.DATABASE_URL = created.url;
    resetEnvCache();
    await closeDb();
    current = { db: getDb(), url: created.url };
  });

  afterAll(async () => {
    await closeDb();
    await drop?.();
  });

  return () => {
    if (!current) throw new Error("The test database is not ready (call inside a test)");
    return current;
  };
}
