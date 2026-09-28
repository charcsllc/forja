/**
 * Database tools on the run's verification database `verify_<runId>`
 * (11-tool-registry.md "Base de datos").
 *
 * What this protects: queries are read-only (the engine's `DbPort` runs them in a
 * READ ONLY transaction with the `cms_ro` role and a 10 s statement timeout) and bounded
 * to 200 rows; the user's development database is never touched by a task.
 */
import { z } from "zod";
import { defineTool, fail, ok } from "./types.js";
import { truncateBytes } from "./text.js";

export const DB_MAX_ROWS = 200;
export const DB_TIMEOUT_SEC = 10;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\t/g, " ").replace(/\n/g, "\\n").slice(0, 200);
}

export const dbQueryTool = defineTool({
  name: "db_query",
  kind: "db",
  description: `Run one read-only SQL query against this run's verification database (migrated by you with npm run db:migrate). At most ${DB_MAX_ROWS} rows, ${DB_TIMEOUT_SEC}s. Writes are rejected: change data through migrations or the seed.`,
  input: z.object({ sql: z.string().min(1).max(20_000) }),
  summarize: (a) => a.sql.replace(/\s+/g, " ").slice(0, 160),
  async execute(args, ctx) {
    if (!ctx.db) return fail("UNAVAILABLE: the verification database is not available in this task.");
    try {
      const r = await ctx.db.query(args.sql, { maxRows: DB_MAX_ROWS, timeoutSec: DB_TIMEOUT_SEC });
      if (r.columns.length === 0) return ok("(statement returned no rows)", "0 rows");
      const lines = [r.columns.join("\t"), ...r.rows.map((row) => row.map(cell).join("\t"))];
      const text = truncateBytes(lines.join("\n"), 16 * 1024).text;
      return ok(`${text}${r.truncated ? `\n[more than ${DB_MAX_ROWS} rows; add LIMIT or a WHERE clause]` : ""}`, `${r.rows.length}${r.truncated ? "+" : ""} rows`);
    } catch (err) {
      return fail(`QUERY_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export const dbIntrospectTool = defineTool({
  name: "db_introspect",
  kind: "db",
  description: "Describe the verification database: tables, columns with types and nullability, primary and foreign keys, indexes.",
  input: z.object({}),
  summarize: () => "",
  async execute(_args, ctx) {
    if (!ctx.db) return fail("UNAVAILABLE: the verification database is not available in this task.");
    try {
      const text = await ctx.db.introspect();
      return ok(truncateBytes(text || "(no tables)", 24 * 1024).text, "schema");
    } catch (err) {
      return fail(`INTROSPECT_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
