/**
 * Typed errors of `@forja/db-cms`.
 *
 * Protects: every refusal of the CMS reaches the engine as one of five stable codes, never
 * as a raw Postgres error. `mapPgError` is the only place that reads SQLSTATE codes; the
 * engine maps `CmsError.status` onto the v1 envelope (`TABLE_NOT_FOUND` is already in
 * `UPSTREAM_CODE_MAP`, the rest fall back on the HTTP status).
 *
 * A stale structure (the app migrated after `introspect`) surfaces as TABLE_NOT_FOUND or
 * PROPERTY_NOT_FOUND; the caller should re-introspect and retry once.
 */

export const CMS_ERROR_CODES = [
  "TABLE_NOT_FOUND",
  "PROPERTY_NOT_FOUND",
  "VALIDATION",
  "RECORD_NOT_FOUND",
  "QUERY_TIMEOUT",
] as const;
export type CmsErrorCode = (typeof CMS_ERROR_CODES)[number];

/** HTTP status the engine should answer with for each code. */
export const CMS_ERROR_STATUS: Readonly<Record<CmsErrorCode, number>> = {
  TABLE_NOT_FOUND: 404,
  PROPERTY_NOT_FOUND: 400,
  VALIDATION: 400,
  RECORD_NOT_FOUND: 404,
  QUERY_TIMEOUT: 408,
};

export interface CmsErrorDetails {
  table?: string;
  property?: string;
  recordId?: string;
  /** SQLSTATE of the Postgres error this was mapped from. */
  sqlState?: string;
  /** Constraint or column Postgres named, when it did. */
  constraint?: string;
  column?: string;
}

export class CmsError extends Error {
  override readonly name = "CmsError";
  readonly code: CmsErrorCode;
  readonly status: number;
  readonly details: CmsErrorDetails;

  constructor(code: CmsErrorCode, message: string, details: CmsErrorDetails = {}, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.status = CMS_ERROR_STATUS[code];
    this.details = details;
  }
}

export function isCmsError(value: unknown, code?: CmsErrorCode): value is CmsError {
  return value instanceof CmsError && (code === undefined || value.code === code);
}

interface PgErrorLike {
  code?: unknown;
  message?: unknown;
  column_name?: unknown;
  constraint_name?: unknown;
  table_name?: unknown;
}

function pgFields(error: unknown): PgErrorLike | null {
  if (typeof error !== "object" || error === null) return null;
  return error as PgErrorLike;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Turn a Postgres error into a `CmsError` when it is one the CMS owns (timeouts, bad
 * values, constraint violations, a vanished table or column). Anything else, including
 * connection failures and permission errors, is returned unchanged: that is an engine
 * problem, not a user mistake.
 */
export function mapPgError(error: unknown): unknown {
  if (error instanceof CmsError) return error;
  const pg = pgFields(error);
  const sqlState = str(pg?.code);
  if (!pg || !sqlState || !/^[0-9A-Z]{5}$/.test(sqlState)) return error;

  const column = str(pg.column_name);
  const constraint = str(pg.constraint_name);
  const table = str(pg.table_name);
  const details: CmsErrorDetails = { sqlState };
  if (column) details.column = column;
  if (constraint) details.constraint = constraint;
  if (table) details.table = table;
  const cause = { cause: error };

  switch (sqlState) {
    case "57014":
      return new CmsError("QUERY_TIMEOUT", "The query took too long and was cancelled", details, cause);
    case "42P01":
      return new CmsError("TABLE_NOT_FOUND", "The table no longer exists; reload the structure", details, cause);
    case "42703":
      return new CmsError("PROPERTY_NOT_FOUND", "A column no longer exists; reload the structure", details, cause);
    case "23505":
      return new CmsError("VALIDATION", "Another record already has this value", details, cause);
    case "23502":
      return new CmsError("VALIDATION", `A value is required${column ? ` for ${column}` : ""}`, details, cause);
    case "23503":
      return new CmsError(
        "VALIDATION",
        "The record is linked to a record that does not exist, or other records still point at it",
        details,
        cause,
      );
    case "23514":
      return new CmsError("VALIDATION", "The value breaks a rule of the table", details, cause);
    case "2201B":
      return new CmsError("VALIDATION", "Invalid regular expression", details, cause);
    default:
      if (sqlState.startsWith("22")) {
        return new CmsError("VALIDATION", `Invalid value: ${str(pg.message) ?? sqlState}`, details, cause);
      }
      return error;
  }
}
