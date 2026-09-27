/**
 * One CMS call = one transaction with a local `statement_timeout`.
 *
 * Protects: no CMS statement outlives `timeoutMs` (default 10 s, 05 §6.3) and the setting
 * never leaks to other users of the pool (`set_config(…, true)` is transaction-local).
 * Reads run `READ ONLY`, so even a `cms_rw` connection cannot write through a query.
 * Postgres errors leave through `mapPgError` as `CmsError`s.
 *
 * The `sql` handed in must not use postgres.js column transforms: the CMS does its own
 * snake_case ↔ camelCase mapping and needs `sql(identifier)` untouched.
 */
import type postgres from "postgres";
import { CmsError, mapPgError } from "./errors.js";

export const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;

export interface CmsCallOptions {
  /** Per-statement timeout in milliseconds. Default 10 000. */
  timeoutMs?: number;
}

function assertPlainSql(sql: postgres.Sql): void {
  const transform = (sql.options as { transform?: { column?: { to?: unknown } } }).transform;
  if (transform?.column?.to) {
    throw new CmsError("VALIDATION", "The CMS needs a postgres.js instance without column transforms");
  }
}

export async function withCmsTransaction<T>(
  sql: postgres.Sql,
  options: CmsCallOptions & { readOnly?: boolean },
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  assertPlainSql(sql);
  const timeout = Math.max(1, Math.floor(options.timeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS));
  try {
    const result = await sql.begin(options.readOnly ? "read only" : "read write", async (tx) => {
      await tx`SELECT set_config('statement_timeout', ${`${timeout}ms`}, true)`;
      // Wrapped so a returned value is never mistaken for a query to run.
      return { value: await fn(tx) };
    });
    return (result as { value: T }).value;
  } catch (error) {
    throw mapPgError(error);
  }
}
