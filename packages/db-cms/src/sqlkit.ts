/**
 * Small helpers over postgres.js fragments.
 *
 * Protects the two SQL rules of the CMS: (1) identifiers enter SQL only through
 * `sql(identifier)` and only after the model knows them; (2) every value is a parameter,
 * and every parameter is sent as TEXT (`$n::text`) and converted by Postgres. Typing
 * parameters as text keeps postgres.js from re-serializing them by the described type
 * (a string sent to a `boolean` parameter becomes `f`, one sent to `jsonb` gets quoted
 * twice), so the SQL means the same whatever types the connection was configured with.
 *
 * ⚠️ Fragments are lazy promises: returning one from an `async` function RUNS it. Build
 * fragments in synchronous code only.
 */
import type postgres from "postgres";

export type SqlTag = postgres.Sql | postgres.TransactionSql;
export type Frag = postgres.PendingQuery<postgres.Row[]>;

/** A text parameter: `$n::text`. */
export function txt(sql: SqlTag, value: string): Frag {
  return sql`${value}::text`;
}

/** `"schema"."table"`. */
export function tableRef(sql: SqlTag, schema: string, table: string): Frag {
  return sql`${sql(schema)}.${sql(table)}`;
}

/** `"alias"."column"`. */
export function colRef(sql: SqlTag, alias: string, column: string): Frag {
  return sql`${sql(alias)}.${sql(column)}`;
}

/** Join fragments with a separator fragment; `empty` when there are none. */
export function join(sql: SqlTag, parts: readonly Frag[], separator: Frag, empty?: Frag): Frag {
  const [first, ...rest] = parts;
  if (!first) return empty ?? sql``;
  return rest.reduce((acc, part) => sql`${acc}${separator}${part}`, first);
}

export function and(sql: SqlTag, parts: readonly Frag[]): Frag {
  if (parts.length === 1 && parts[0]) return parts[0];
  return parts.length === 0 ? sql`TRUE` : sql`(${join(sql, parts, sql` AND `)})`;
}

export function or(sql: SqlTag, parts: readonly Frag[]): Frag {
  if (parts.length === 1 && parts[0]) return parts[0];
  return parts.length === 0 ? sql`FALSE` : sql`(${join(sql, parts, sql` OR `)})`;
}

/**
 * A Postgres array literal (`{"a","b\"c",NULL}`) for values we formatted ourselves. Sent
 * as one text parameter and cast (`$1::text::numeric[]`), so no array typing is inferred.
 */
export function arrayLiteral(values: readonly (string | null)[]): string {
  const items = values.map((value) =>
    value === null ? "NULL" : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`,
  );
  return `{${items.join(",")}}`;
}
