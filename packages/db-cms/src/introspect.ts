/**
 * Introspection: a project database's `public` schema → Totalum's `tables-structure`
 * (docs/architecture/05 §6.2) plus the `CmsModel` the compiler resolves names against.
 *
 * Protects the conventions of templates/nextjs-postgres (05 §6.1):
 * - Only `public` is read; `internal.*` and `drizzle.*` are never listed. BetterAuth's
 *   `session`, `account`, `verification` and drizzle's `__drizzle_migrations` are
 *   excluded even when they sit in `public`; `user` stays visible.
 * - `_id` is the single-column primary key; tables with no or a composite primary key
 *   are skipped (a composite one is only accepted as a bridge).
 * - Bridge = exactly two single-column FKs to two different exposed tables, the primary
 *   key made of exactly those two columns, and no other columns than `created_at` /
 *   `updated_at`. A bridge is not listed; both ends get a `manyToMany` property with the
 *   SAME `DbProperty.id` (derived from the bridge name). An FK gives `manyToOne` on its
 *   table and `oneToMany` on the target, again with one shared id (derived from the FK).
 * - `file.multiple` (decision): a `*_file` / `*_image` jsonb column holds an array when
 *   (1) its default is a JSON array (`'[]'::jsonb`, what `filesColumn` should declare),
 *   (2) a CHECK on it asserts `jsonb_typeof(col) = 'array'`, (3) its comment contains
 *   `forja:multiple`, or (4) any of its first 20 non-null values is an array. A comment
 *   with `forja:single` forces single and skips sampling.
 * - `text` → `long-string` unless the column looks short (decision, refining 05 §6.2):
 *   a CHECK on its length, a single-column UNIQUE, an FK, or a conventional short name
 *   (`name`, `title`, `email`, `slug`, `*_name`, `*_url`…). `varchar`, `char`, `uuid`
 *   and `citext` are `string`.
 */
import type postgres from "postgres";
import type { DbProperty, DbTable } from "@forja/contracts/v1";
import { withCmsTransaction, type CmsCallOptions } from "./tx.js";
import {
  SYSTEM_PROPERTY_NAMES,
  type CmsColumn,
  type CmsModel,
  type CmsRelation,
  type CmsStructure,
  type CmsTableModel,
  type ColumnKind,
  type ManyToManyRelation,
  type ManyToOneRelation,
  type OneToManyRelation,
  type SkippedTable,
} from "./model.js";
import { camelCase, humanize, humanizeReference, isSafeIdentifier, stableId } from "./names.js";

/** Tables of the exposed schema that are never listed (BetterAuth internals, drizzle). */
export const DEFAULT_EXCLUDED_TABLES: readonly string[] = ["session", "account", "verification", "__drizzle_migrations"];

export interface IntrospectOptions extends CmsCallOptions {
  /** Schema to expose. Default `public`. */
  schema?: string;
  /** Replaces `DEFAULT_EXCLUDED_TABLES`. */
  exclude?: readonly string[];
  /** Sample file columns to detect arrays (rule 4 above). Default true. */
  sampleFiles?: boolean;
}

// ─── Catalog (raw pg_catalog facts) ─────────────────────────────────────────

export interface CatalogColumn {
  table: string;
  column: string;
  attnum: number;
  /** `format_type(atttypid, atttypmod)`. */
  sqlType: string;
  /** `typname` of the column type, domains resolved to their base type. */
  typeName: string;
  /** `typcategory` of that type (`A` = array). */
  typeCategory: string;
  isEnum: boolean;
  /** Element `typname` for arrays. */
  elemTypeName: string | null;
  elemIsEnum: boolean;
  /** Labels of the enum (or of the array's enum element). */
  enumValues: string[] | null;
  notNull: boolean;
  defaultExpr: string | null;
  identity: boolean;
  generated: boolean;
  comment: string | null;
}

export interface CatalogConstraint {
  table: string;
  name: string;
  type: "p" | "f" | "c" | "u";
  columns: string[];
  refSchema: string | null;
  refTable: string | null;
  refColumns: string[];
  definition: string;
}

export interface Catalog {
  schema: string;
  tables: { name: string; comment: string | null }[];
  columns: CatalogColumn[];
  constraints: CatalogConstraint[];
}

type Tx = postgres.TransactionSql;

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : asString(value);
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString);
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    // Unparsed array literal (custom connection types); identifiers never contain commas here.
    const inner = value.slice(1, -1);
    return inner === "" ? [] : inner.split(",").map((part) => part.replace(/^"|"$/g, ""));
  }
  return [];
}

/** Read the raw catalog of `schema`. One round trip per query, no user data touched. */
export async function fetchCatalog(tx: Tx, schema: string): Promise<Catalog> {
  const tableRows = await tx`
    SELECT c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND NOT c.relispartition
    ORDER BY c.relname`;

  const columnRows = await tx`
    SELECT c.relname AS table_name, a.attname AS column_name, a.attnum AS attnum,
      format_type(a.atttypid, a.atttypmod) AS sql_type,
      bt.typname AS type_name, bt.typcategory AS type_category, bt.typtype = 'e' AS is_enum,
      et.typname AS elem_type_name, COALESCE(et.typtype = 'e', false) AS elem_is_enum,
      (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
         FROM pg_enum e
        WHERE e.enumtypid = CASE WHEN bt.typtype = 'e' THEN bt.oid ELSE et.oid END) AS enum_values,
      a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr,
      a.attidentity <> '' AS identity, a.attgenerated <> '' AS generated,
      col_description(c.oid, a.attnum) AS comment
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
    LEFT JOIN pg_type et ON et.oid = bt.typelem AND bt.typcategory = 'A'
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = ${schema} AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`;

  const constraintRows = await tx`
    SELECT c.relname AS table_name, con.conname AS name, con.contype AS type,
      ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      fn.nspname AS ref_schema, fc.relname AS ref_table,
      ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num, ord)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord) AS ref_columns,
      pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_class fc ON fc.oid = con.confrelid
    LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
    WHERE n.nspname = ${schema} AND con.contype IN ('p', 'f', 'c', 'u')
    ORDER BY c.relname, con.conname`;

  return {
    schema,
    tables: tableRows.map((row) => ({ name: asString(row.name), comment: asNullableString(row.comment) })),
    columns: columnRows.map((row) => ({
      table: asString(row.table_name),
      column: asString(row.column_name),
      attnum: Number(row.attnum),
      sqlType: asString(row.sql_type),
      typeName: asString(row.type_name),
      typeCategory: asString(row.type_category),
      isEnum: row.is_enum === true,
      elemTypeName: asNullableString(row.elem_type_name),
      elemIsEnum: row.elem_is_enum === true,
      enumValues: row.enum_values === null || row.enum_values === undefined ? null : asStringArray(row.enum_values),
      notNull: row.not_null === true,
      defaultExpr: asNullableString(row.default_expr),
      identity: row.identity === true,
      generated: row.generated === true,
      comment: asNullableString(row.comment),
    })),
    constraints: constraintRows.map((row) => ({
      table: asString(row.table_name),
      name: asString(row.name),
      type: asString(row.type) as CatalogConstraint["type"],
      columns: asStringArray(row.columns),
      refSchema: asNullableString(row.ref_schema),
      refTable: asNullableString(row.ref_table),
      refColumns: asStringArray(row.ref_columns),
      definition: asString(row.definition),
    })),
  };
}

// ─── Column classification ──────────────────────────────────────────────────

const FILE_NAME = /_(file|image)$/;
const TEXT_TYPES = new Set(["text", "varchar", "bpchar", "char", "citext", "uuid", "name"]);
const INTEGER_TYPES = new Set(["int2", "int4", "int8"]);
const NUMBER_TYPES = new Set(["numeric", "float4", "float8"]);
const SHORT_TEXT_NAME =
  /^(name|title|label|email|slug|handle|username|phone|url|website|code|sku|key|locale|currency|color|icon|image|status|type|city|country|zip|postal_code|first_name|last_name|full_name|display_name)$|_(name|email|url|slug|code|phone|key|type|id|token)$/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `col` or `"col"` as `pg_get_constraintdef` prints it. */
function columnPattern(column: string): string {
  return `(?:${escapeRegExp(column)}|"${escapeRegExp(column.replace(/"/g, '""'))}")`;
}

function kindOf(col: CatalogColumn): { kind: ColumnKind; integer?: boolean; jsonType?: "json" | "jsonb" } {
  if (col.typeCategory === "A") return { kind: col.elemIsEnum ? "enumArray" : "array" };
  if (col.isEnum) return { kind: "enum" };
  if (INTEGER_TYPES.has(col.typeName)) return { kind: "number", integer: true };
  if (NUMBER_TYPES.has(col.typeName)) return { kind: "number" };
  if (col.typeName === "bool") return { kind: "boolean" };
  if (col.typeName === "date") return { kind: "date" };
  if (col.typeName === "timestamp" || col.typeName === "timestamptz") return { kind: "timestamp" };
  if (col.typeName === "json" || col.typeName === "jsonb") {
    return { kind: FILE_NAME.test(col.column) ? "file" : "json", jsonType: col.typeName };
  }
  if (TEXT_TYPES.has(col.typeName)) return { kind: "text" };
  return { kind: "other" };
}

/** Static signals that a file column holds an array (rules 1–3), or `null` when unknown. */
export function staticFileMultiple(col: CatalogColumn, checks: CatalogConstraint[]): boolean | null {
  const comment = col.comment ?? "";
  if (comment.includes("forja:single")) return false;
  if (comment.includes("forja:multiple")) return true;
  if (col.defaultExpr && /^'\s*\[/.test(col.defaultExpr.trim())) return true;
  const typeofArray = new RegExp(`json(?:b)?_typeof\\(${columnPattern(col.column)}\\)\\s*=\\s*'array'`);
  if (checks.some((check) => check.columns.includes(col.column) && typeofArray.test(check.definition))) return true;
  return null;
}

// ─── Structure ──────────────────────────────────────────────────────────────

export interface BuildStructureOptions {
  exclude?: readonly string[];
  /** `table.column` of file columns sampled as arrays. */
  multipleFileColumns?: readonly string[];
}

interface TableFacts {
  name: string;
  comment: string | null;
  columns: CatalogColumn[];
  constraints: CatalogConstraint[];
  pk: string[];
  fks: CatalogConstraint[];
}

function singleFks(facts: TableFacts, schema: string): CatalogConstraint[] {
  return facts.fks.filter((fk) => fk.columns.length === 1 && fk.refColumns.length === 1 && fk.refSchema === schema);
}

/** Pure: catalog → `{tables, model}`. Split from `introspect` so it is unit-testable. */
export function buildStructure(catalog: Catalog, options: BuildStructureOptions = {}): CmsStructure {
  const schema = catalog.schema;
  const excluded = new Set(options.exclude ?? DEFAULT_EXCLUDED_TABLES);
  const sampledMultiple = new Set(options.multipleFileColumns ?? []);
  const skipped: SkippedTable[] = [];

  const facts = new Map<string, TableFacts>();
  for (const table of catalog.tables) {
    const constraints = catalog.constraints.filter((c) => c.table === table.name);
    facts.set(table.name, {
      name: table.name,
      comment: table.comment,
      columns: catalog.columns.filter((c) => c.table === table.name).sort((a, b) => a.attnum - b.attnum),
      constraints,
      pk: constraints.find((c) => c.type === "p")?.columns ?? [],
      fks: constraints.filter((c) => c.type === "f"),
    });
  }

  // 1) Which tables are exposed, which are bridges.
  const exposed = new Set<string>();
  const candidates: TableFacts[] = [];
  for (const table of facts.values()) {
    if (excluded.has(table.name)) {
      skipped.push({ table: table.name, reason: "excluded" });
    } else if (!isSafeIdentifier(table.name)) {
      skipped.push({ table: table.name, reason: "unsafe-identifier" });
    } else if (table.pk.length === 1 && isSafeIdentifier(table.pk[0] ?? "")) {
      exposed.add(table.name);
    } else {
      candidates.push(table);
    }
  }

  const bridges: TableFacts[] = [];
  for (const table of candidates) {
    const fks = singleFks(table, schema);
    const fkColumns = fks.map((fk) => fk.columns[0] ?? "");
    const targets = fks.map((fk) => fk.refTable ?? "");
    const others = table.columns.filter((c) => !fkColumns.includes(c.column));
    const isBridge =
      table.fks.length === 2 &&
      fks.length === 2 &&
      table.pk.length === 2 &&
      table.pk.every((column) => fkColumns.includes(column)) &&
      new Set(fkColumns).size === 2 &&
      targets.every((target) => exposed.has(target)) &&
      targets[0] !== targets[1] &&
      others.every((c) => c.column === "created_at" || c.column === "updated_at") &&
      [...fkColumns].every(isSafeIdentifier);
    if (isBridge) {
      bridges.push(table);
      skipped.push({ table: table.name, reason: "bridge" });
    } else {
      skipped.push({ table: table.name, reason: table.pk.length === 0 ? "no-primary-key" : "composite-primary-key" });
    }
  }

  // 2) Columns of every exposed table.
  const models = new Map<string, CmsTableModel>();
  const used = new Map<string, Set<string>>();
  const claim = (table: string, attempts: string[]): string => {
    const names = used.get(table) ?? new Set<string>(SYSTEM_PROPERTY_NAMES);
    used.set(table, names);
    for (const attempt of attempts) {
      if (attempt !== "" && !attempt.startsWith("_") && !names.has(attempt)) {
        names.add(attempt);
        return attempt;
      }
    }
    const base = attempts[attempts.length - 1] ?? "field";
    for (let n = 2; ; n++) {
      const attempt = `${base}${n}`;
      if (!names.has(attempt)) {
        names.add(attempt);
        return attempt;
      }
    }
  };

  const toColumn = (table: TableFacts, col: CatalogColumn, name: string): CmsColumn => {
    const { kind, integer, jsonType } = kindOf(col);
    const column: CmsColumn = {
      name,
      column: col.column,
      kind,
      sqlType: col.sqlType,
      notNull: col.notNull,
      hasDefault: col.defaultExpr !== null || col.identity,
      generated: col.generated,
    };
    if (integer) column.integer = true;
    if (jsonType) column.jsonType = jsonType;
    if ((kind === "enum" || kind === "enumArray") && col.enumValues) column.enumValues = col.enumValues;
    if (kind === "file") {
      const checks = table.constraints.filter((c) => c.type === "c");
      column.multiple = staticFileMultiple(col, checks) ?? sampledMultiple.has(`${table.name}.${col.column}`);
    }
    return column;
  };

  for (const tableName of [...exposed].sort()) {
    const table = facts.get(tableName);
    if (!table) continue;
    const pkName = table.pk[0] ?? "";
    const pkColumn = table.columns.find((col) => col.column === pkName);
    if (!pkColumn) continue;
    const model: CmsTableModel = { name: tableName, pk: toColumn(table, pkColumn, "_id"), columns: [], relations: [] };
    for (const col of table.columns) {
      if (!isSafeIdentifier(col.column) || col.column === pkName) continue;
      const probe = kindOf(col).kind;
      if (col.column === "created_at" && (probe === "timestamp" || probe === "date")) {
        model.createdAt = toColumn(table, col, "createdAt");
        continue;
      }
      if (col.column === "updated_at" && (probe === "timestamp" || probe === "date")) {
        model.updatedAt = toColumn(table, col, "updatedAt");
        continue;
      }
      const camel = camelCase(col.column);
      model.columns.push(toColumn(table, col, claim(tableName, [camel, col.column, `${camel}Column`])));
    }
    models.set(tableName, model);
  }

  // 3) Relations. FKs first (manyToOne on the child, oneToMany on the target)…
  const oneToManyPending: { target: string; relation: Omit<OneToManyRelation, "name">; base: string }[] = [];
  for (const tableName of [...exposed].sort()) {
    const table = facts.get(tableName);
    const model = models.get(tableName);
    if (!table || !model) continue;
    const fks = singleFks(table, schema).filter((fk) => exposed.has(fk.refTable ?? ""));
    for (const fk of fks) {
      const column = fk.columns[0] ?? "";
      const target = fk.refTable ?? "";
      const targetColumn = fk.refColumns[0] ?? "";
      if (!isSafeIdentifier(targetColumn)) continue;
      const id = stableId(`fk:${schema}.${tableName}.${column}`);
      const own = model.columns.find((c) => c.column === column);
      if (own) {
        model.relations.push({ kind: "manyToOne", name: own.name, id, column, target, targetColumn });
      }
      const siblings = fks.filter((other) => other.refTable === target).length;
      const stem = camelCase(column.replace(/_?id$/i, "") || column);
      const base =
        siblings > 1 || target === tableName
          ? `${camelCase(tableName)}By${stem.charAt(0).toUpperCase()}${stem.slice(1)}`
          : camelCase(tableName);
      oneToManyPending.push({
        target,
        base,
        relation: { kind: "oneToMany", id, child: tableName, childColumn: column, localColumn: targetColumn },
      });
    }
  }

  // …then bridges (manyToMany on both ends, one id per bridge)…
  const pairCount = new Map<string, number>();
  for (const bridge of bridges) {
    const key = singleFks(bridge, schema)
      .map((fk) => fk.refTable ?? "")
      .sort()
      .join("|");
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }
  for (const bridge of bridges.sort((a, b) => a.name.localeCompare(b.name))) {
    const [a, b] = singleFks(bridge, schema);
    if (!a || !b) continue;
    const id = stableId(`m2m:${schema}.${bridge.name}`);
    const pairKey = [a.refTable ?? "", b.refTable ?? ""].sort().join("|");
    const shared = (pairCount.get(pairKey) ?? 0) > 1;
    const createdAt = bridge.columns.some((c) => c.column === "created_at") ? "created_at" : undefined;
    for (const [self, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const model = models.get(self.refTable ?? "");
      if (!model) continue;
      const otherTable = other.refTable ?? "";
      const bridgeName = camelCase(bridge.name);
      const name = claim(model.name, shared ? [bridgeName, `${bridgeName}List`] : [camelCase(otherTable), bridgeName, `${camelCase(otherTable)}List`]);
      const relation: ManyToManyRelation = {
        kind: "manyToMany",
        name,
        id,
        bridge: bridge.name,
        selfColumn: self.columns[0] ?? "",
        otherColumn: other.columns[0] ?? "",
        localColumn: self.refColumns[0] ?? "",
        target: otherTable,
        targetColumn: other.refColumns[0] ?? "",
      };
      if (createdAt) relation.bridgeCreatedAt = createdAt;
      model.relations.push(relation);
    }
  }

  // …and the oneToMany halves last, so they never steal a nicer name.
  for (const pending of oneToManyPending) {
    const model = models.get(pending.target);
    if (!model) continue;
    const name = claim(model.name, [pending.base, `${pending.base}List`]);
    model.relations.push({ ...pending.relation, name });
  }

  // 4) Wire shape.
  const tables: DbTable[] = [];
  for (const model of models.values()) {
    const table = facts.get(model.name);
    tables.push(toDbTable(model, table?.comment ?? null, table?.columns ?? [], table?.constraints ?? []));
  }

  const modelTables: Record<string, CmsTableModel> = {};
  for (const [name, model] of models) modelTables[name] = model;
  const cmsModel: CmsModel = { schema, tables: modelTables, skipped };
  return { tables, model: cmsModel };
}

function isShortText(col: CmsColumn, catalogColumn: CatalogColumn | undefined, constraints: CatalogConstraint[]): boolean {
  if (catalogColumn && catalogColumn.typeName !== "text") return true;
  if (SHORT_TEXT_NAME.test(col.column)) return true;
  if (constraints.some((c) => c.type === "u" && c.columns.length === 1 && c.columns[0] === col.column)) return true;
  const lengthCheck = new RegExp(`(?:char_length|character_length|length|octet_length)\\(${columnPattern(col.column)}\\)`);
  return constraints.some((c) => c.type === "c" && c.columns.includes(col.column) && lengthCheck.test(c.definition));
}

const LABEL_COLUMN = /^(name|title|label|full_name|display_name|email|slug|handle|username)$|_(name|title)$/;

function toDbTable(model: CmsTableModel, comment: string | null, catalogColumns: CatalogColumn[], constraints: CatalogConstraint[]): DbTable {
  const properties: Record<string, DbProperty> = {};
  const relationOfColumn = new Map<string, ManyToOneRelation>();
  for (const relation of model.relations) if (relation.kind === "manyToOne") relationOfColumn.set(relation.column, relation);

  const labelColumn = model.columns.find((c) => c.kind === "text" && LABEL_COLUMN.test(c.column));

  for (const col of model.columns) {
    const catalogColumn = catalogColumns.find((c) => c.column === col.column);
    const relation = relationOfColumn.get(col.column);
    const property: DbProperty = {
      id: relation ? relation.id : stableId(`col:${model.name}.${col.column}`),
      name: col.name,
      propertyType: "string",
      label: relation ? humanizeReference(col.column) : humanize(col.column),
      objectReference: null,
      typeExtras: null,
    };
    const description = catalogColumn?.comment?.replace(/forja:(multiple|single)/g, "").trim();
    if (description) property.description = description;

    if (relation) {
      property.propertyType = "objectReference";
      property.objectReference = { objectReferenceTypeId: relation.target, objectReferenceRelation: "manyToOne" };
    } else {
      switch (col.kind) {
        case "text":
          property.propertyType = isShortText(col, catalogColumn, constraints) ? "string" : "long-string";
          break;
        case "other":
          property.propertyType = "string";
          break;
        case "number":
          property.propertyType = "number";
          break;
        case "boolean":
          property.propertyType = "boolean";
          break;
        case "date":
        case "timestamp":
          property.propertyType = "date";
          property.typeExtras = { date: { includeHour: col.kind === "timestamp" } };
          break;
        case "enum":
        case "enumArray":
          property.propertyType = "options";
          property.typeExtras = {
            options: (col.enumValues ?? []).map((value) => ({ id: value, value })),
            optionsConfig: { multiple: col.kind === "enumArray" },
          };
          break;
        case "file":
          property.propertyType = "file";
          property.typeExtras = { file: { multiple: col.multiple === true } };
          break;
        case "array":
          property.propertyType = "array";
          break;
        case "json":
          property.propertyType = "object";
          break;
      }
    }
    if (col === labelColumn) property.showInTree = true;
    properties[col.name] = property;
  }

  const relationsInOrder: CmsRelation[] = [
    ...model.relations.filter((r) => r.kind === "manyToMany"),
    ...model.relations.filter((r) => r.kind === "oneToMany"),
  ];
  for (const relation of relationsInOrder) {
    if (relation.kind === "manyToOne") continue;
    const target = relation.kind === "manyToMany" ? relation.target : relation.child;
    properties[relation.name] = {
      id: relation.id,
      name: relation.name,
      propertyType: "objectReference",
      label: humanize(relation.name),
      objectReference: { objectReferenceTypeId: target, objectReferenceRelation: relation.kind },
      typeExtras: null,
    };
  }

  return {
    _id: model.name,
    type: model.name,
    label: humanize(model.name),
    description: comment ?? "",
    icon: "table",
    properties,
  };
}

/** File columns whose multiplicity only data can tell (no static signal). */
function filesToSample(catalog: Catalog, exclude: ReadonlySet<string>): CatalogColumn[] {
  return catalog.columns.filter((col) => {
    if (exclude.has(col.table) || !isSafeIdentifier(col.table) || !isSafeIdentifier(col.column)) return false;
    if (kindOf(col).kind !== "file") return false;
    const checks = catalog.constraints.filter((c) => c.table === col.table && c.type === "c");
    return staticFileMultiple(col, checks) === null;
  });
}

/**
 * Read the project database and describe it for the database tab.
 * `sql` should log in as `cms_ro`; the call runs in one read-only transaction with the
 * CMS statement timeout.
 */
export async function introspect(sql: postgres.Sql, options: IntrospectOptions = {}): Promise<CmsStructure> {
  const schema = options.schema ?? "public";
  const exclude = options.exclude ?? DEFAULT_EXCLUDED_TABLES;
  return withCmsTransaction(sql, { ...options, readOnly: true }, async (tx) => {
    const catalog = await fetchCatalog(tx, schema);
    const multiple: string[] = [];
    if (options.sampleFiles !== false) {
      for (const col of filesToSample(catalog, new Set(exclude))) {
        const typeofFn = col.typeName === "json" ? tx`json_typeof` : tx`jsonb_typeof`;
        const [row] = await tx`
          SELECT EXISTS (
            SELECT 1 FROM (
              SELECT ${tx(col.column)} AS v FROM ${tx(schema)}.${tx(col.table)}
              WHERE ${tx(col.column)} IS NOT NULL LIMIT 20
            ) s WHERE ${typeofFn}(s.v) = 'array'
          ) AS multiple`;
        if (row?.multiple === true) multiple.push(`${col.table}.${col.column}`);
      }
    }
    return buildStructure(catalog, { exclude, multipleFileColumns: multiple });
  });
}

/** The wire body of `GET P/database/tables-structure`. */
export function tablesStructureResult(structure: CmsStructure): { tables: DbTable[] } {
  return { tables: structure.tables };
}
