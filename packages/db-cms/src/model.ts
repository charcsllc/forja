/**
 * The CMS model: what `introspect` learns about a project database, beyond the wire shape.
 *
 * Protects: every identifier the compiler puts into SQL comes from here (table, column,
 * bridge names read from `pg_catalog`), never from a request. A request names
 * PROPERTIES; `CmsTableModel` resolves them to columns or relations, and anything it does
 * not know is refused. The model is plain JSON so the engine can cache it next to the
 * `{tables}` it serves.
 */
import type { DbTable } from "@forja/contracts/v1";

/**
 * How a column behaves in filters, sorting, reads and writes.
 * - `text`: text, varchar, char, citext, uuid, and anything compared as text.
 * - `number`: smallint, integer, bigint, numeric, real, double precision (`integer` = true
 *   for the first three).
 * - `date` (no time) and `timestamp` (with or without time zone).
 * - `enum` / `enumArray`: Postgres enums, exposed as `options`.
 * - `array`: any other array (exposed as `array`, edited as JSON).
 * - `file`: jsonb named `*_file` / `*_image` holding `{name, url?}` or an array of them.
 * - `json`: any other json/jsonb.
 * - `other`: types with no better mapping (inet, interval, time, bytea…), read and
 *   compared as text, written as text for Postgres to parse.
 */
export type ColumnKind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "timestamp"
  | "enum"
  | "enumArray"
  | "array"
  | "file"
  | "json"
  | "other";

export interface CmsColumn {
  /** Property name (camelCase) the UI uses. */
  name: string;
  /** SQL column name. */
  column: string;
  kind: ColumnKind;
  /** `format_type()` of the column, for messages only. */
  sqlType: string;
  /** Whole numbers only (smallint, integer, bigint). */
  integer?: boolean;
  /** `json` or `jsonb` for `file`/`json` kinds. */
  jsonType?: "json" | "jsonb";
  /** Allowed values of `enum` / `enumArray`, in declaration order. */
  enumValues?: string[];
  /** `file` kind: the column holds an array of files. */
  multiple?: boolean;
  notNull: boolean;
  hasDefault: boolean;
  /** GENERATED ALWAYS … STORED: read-only. */
  generated: boolean;
}

/** `this.column` references `target.targetColumn` (single-column FK). */
export interface ManyToOneRelation {
  kind: "manyToOne";
  /** Same as the FK column's property name. */
  name: string;
  id: string;
  column: string;
  target: string;
  targetColumn: string;
}

/** Rows of `child` whose `childColumn` references this table's `localColumn`. */
export interface OneToManyRelation {
  kind: "oneToMany";
  name: string;
  id: string;
  child: string;
  childColumn: string;
  localColumn: string;
}

/** Linked through `bridge(selfColumn → this.localColumn, otherColumn → target.targetColumn)`. */
export interface ManyToManyRelation {
  kind: "manyToMany";
  name: string;
  id: string;
  bridge: string;
  selfColumn: string;
  otherColumn: string;
  localColumn: string;
  target: string;
  targetColumn: string;
  /** The bridge has a `created_at` column (used to order links). */
  bridgeCreatedAt?: string;
}

export type CmsRelation = ManyToOneRelation | OneToManyRelation | ManyToManyRelation;

export interface CmsTableModel {
  /** SQL table name; also `DbTable.type` and `DbTable._id`. */
  name: string;
  /** Primary key column, exposed as `_id`. */
  pk: CmsColumn;
  /** `created_at` / `updated_at` columns when present, exposed as `createdAt` / `updatedAt`. */
  createdAt?: CmsColumn;
  updatedAt?: CmsColumn;
  /** Every other column, in table order (FK columns included). */
  columns: CmsColumn[];
  relations: CmsRelation[];
}

export interface SkippedTable {
  table: string;
  reason: "excluded" | "no-primary-key" | "composite-primary-key" | "unsafe-identifier" | "bridge";
}

export interface CmsModel {
  schema: string;
  tables: Record<string, CmsTableModel>;
  /** Tables not exposed and why (bridges are listed here too). */
  skipped: SkippedTable[];
}

/** What `introspect` returns: the wire `{tables}` plus the model the compiler needs. */
export interface CmsStructure {
  tables: DbTable[];
  model: CmsModel;
}

/** A field reference resolved from a property name. */
export type ResolvedField =
  | { type: "column"; column: CmsColumn; relation?: ManyToOneRelation }
  | { type: "relation"; relation: OneToManyRelation | ManyToManyRelation };

/** Property names every row carries that map to system columns. */
export const SYSTEM_PROPERTY_NAMES = ["_id", "createdAt", "updatedAt", "createdBy", "lastUpdatedBy", "metadata"] as const;
