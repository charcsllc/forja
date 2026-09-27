/**
 * Write coercion: a `data` object from the UI → one JSON record keyed by SQL column,
 * which the statement turns into typed values with `json_populate_record` (so the column
 * types, enums and arrays are converted by Postgres, not by string building).
 *
 * Protects the write rules of docs/research/02 §6:
 * - Unknown properties are refused (PROPERTY_NOT_FOUND); system fields (`_id`,
 *   `createdAt`…), generated columns and to-many relations are ignored (many-to-many is
 *   written only through link/unlink; one-to-many lives on the child).
 * - Numbers, booleans, dates (ISO) and JSON are coerced; a value that cannot be is a
 *   VALIDATION error naming the property. `""` on a non-text column means empty (NULL).
 * - An enum value must be one of the enum's labels.
 * - A to-one link takes an id or `{_id}`; `""` / `null` clears it.
 * - A file field stores `{name}` only (the read shape's signed `url` would go stale), an
 *   array of them when the column holds several.
 */
import { CmsError } from "./errors.js";
import { SYSTEM_PROPERTY_NAMES, type CmsColumn, type CmsTableModel } from "./model.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const SYSTEM = new Set<string>(SYSTEM_PROPERTY_NAMES);
const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(column: CmsColumn, message: string): CmsError {
  return new CmsError("VALIDATION", `${column.name}: ${message}`, { property: column.name });
}

function toJson(value: unknown, column: CmsColumn): Json {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    throw invalid(column, "is not valid JSON");
  }
}

function fileRef(entry: unknown, column: CmsColumn): Json {
  if (typeof entry === "string" && entry !== "") return { name: entry };
  if (isPlainObject(entry) && typeof entry.name === "string" && entry.name !== "") return { name: entry.name };
  throw invalid(column, "a file must be { name }");
}

function scalar(column: CmsColumn, value: unknown): Json {
  if (value === null) return null;
  switch (column.kind) {
    case "text":
    case "other":
      if (typeof value === "string") return value === "" && column.kind === "other" ? null : value;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
      throw invalid(column, "must be text");
    case "number": {
      if (value === "") return null;
      const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : typeof value === "string" ? value.trim() : "";
      if (!NUMERIC.test(text) || !Number.isFinite(Number(text))) throw invalid(column, "must be a number");
      if (column.integer && !Number.isInteger(Number(text))) throw invalid(column, "must be a whole number");
      // Integer input functions reject `1e3` and `2.0`; send the plain digits.
      return column.integer && !/^[+-]?\d+$/.test(text) ? String(Number(text)) : text;
    }
    case "boolean":
      if (value === true || value === "true" || value === 1 || value === "1") return true;
      if (value === false || value === "false" || value === 0 || value === "0") return false;
      if (value === "") return null;
      throw invalid(column, "must be true or false");
    case "date":
    case "timestamp": {
      if (value === "") return null;
      if (typeof value !== "string" && typeof value !== "number") throw invalid(column, "must be a date");
      const date = new Date(typeof value === "string" ? value.trim() : value);
      if (Number.isNaN(date.getTime())) throw invalid(column, "must be a date");
      if (column.kind === "date") return typeof value === "string" && DATE_ONLY.test(value.trim()) ? value.trim() : date.toISOString().slice(0, 10);
      return date.toISOString();
    }
    case "enum": {
      if (value === "") return null;
      const allowed = column.enumValues ?? [];
      if (typeof value !== "string" || !allowed.includes(value)) throw invalid(column, `must be one of ${allowed.join(", ")}`);
      return value;
    }
    case "enumArray": {
      const list = Array.isArray(value) ? value : value === "" ? [] : [value];
      const allowed = column.enumValues ?? [];
      for (const item of list) {
        if (typeof item !== "string" || !allowed.includes(item)) throw invalid(column, `values must be among ${allowed.join(", ")}`);
      }
      return list as string[];
    }
    case "array": {
      if (!Array.isArray(value)) throw invalid(column, "must be a list");
      for (const item of value) {
        if (item !== null && typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
          throw invalid(column, "must be a flat list");
        }
      }
      return toJson(value, column);
    }
    case "file": {
      if (value === "") return null;
      if (column.multiple) {
        const list = Array.isArray(value) ? value : [value];
        return list.map((entry) => fileRef(entry, column));
      }
      const first: unknown = Array.isArray(value) ? value[0] : value;
      return first === undefined || first === null ? null : fileRef(first, column);
    }
    case "json":
      return toJson(value, column);
  }
}

/** A to-one link value: an id, `{_id}`, or empty. */
function linkValue(column: CmsColumn, value: unknown): Json {
  if (value === null || value === "") return null;
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (isPlainObject(value) && (typeof value._id === "string" || typeof value._id === "number")) return String(value._id);
  throw invalid(column, "must be the id of the linked record");
}

export interface EncodedWrite {
  /** Columns written, in `data` order. */
  columns: CmsColumn[];
  /** JSON record keyed by SQL column name, for `json_populate_record`. */
  record: Record<string, Json>;
}

/** Validate and coerce `data` for `table`. */
export function encodeWrite(table: CmsTableModel, data: unknown): EncodedWrite {
  if (!isPlainObject(data)) throw new CmsError("VALIDATION", "data must be an object", { table: table.name });
  const fkColumns = new Set(table.relations.flatMap((r) => (r.kind === "manyToOne" ? [r.column] : [])));
  const toMany = new Set(table.relations.flatMap((r) => (r.kind === "manyToOne" ? [] : [r.name])));
  const columns: CmsColumn[] = [];
  const record: Record<string, Json> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || SYSTEM.has(key) || toMany.has(key)) continue;
    const column = table.columns.find((c) => c.name === key);
    if (!column) {
      throw new CmsError("PROPERTY_NOT_FOUND", `Property ${key} does not exist on ${table.name}`, { table: table.name, property: key });
    }
    if (column.generated) continue;
    record[column.column] = fkColumns.has(column.column) ? linkValue(column, value) : scalar(column, value);
    columns.push(column);
  }
  return { columns, record };
}
