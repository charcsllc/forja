/**
 * Decoding: the JSON a compiled query returns per row → the row the UI reads.
 *
 * Protects the read shape of docs/research/02 §6: `_id` is a string, `createdAt` /
 * `updatedAt` are ISO strings, a to-one link is an id string or (expanded) a row, a
 * to-many link is an array, and a file is `{name, url?, type?}` (an array for multiple
 * files) where `url` comes from the caller's `resolveFileUrl`, never from the stored
 * value when a resolver is given (a stored URL may be stale or foreign).
 */
import type { DbRow } from "@forja/contracts/v1";
import type { CmsColumn, CmsModel, CmsTableModel } from "./model.js";
import type { ExpansionPlan } from "./compile.js";
import { requireTable } from "./resolve.js";

/** Turns a stored file name into a URL the browser can load (signed, usually). */
export type FileUrlResolver = (name: string) => string | undefined | null | Promise<string | undefined | null>;

export interface DecodeOptions {
  resolveFileUrl?: FileUrlResolver;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: unknown): unknown {
  if (typeof value !== "string" && typeof value !== "number") return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function idString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : String(value);
}

async function decodeFile(entry: unknown, image: boolean, options: DecodeOptions): Promise<unknown> {
  const file = typeof entry === "string" ? { name: entry } : entry;
  if (!isPlainObject(file) || typeof file.name !== "string") return entry;
  const out: { name: string; url?: string; type?: string } = { name: file.name };
  const resolved = options.resolveFileUrl ? await options.resolveFileUrl(file.name) : undefined;
  const url = resolved ?? (options.resolveFileUrl ? undefined : file.url);
  if (typeof url === "string" && url !== "") out.url = url;
  const type = typeof file.type === "string" && file.type !== "" ? file.type : image ? "image" : undefined;
  if (type) out.type = type;
  return out;
}

async function decodeColumn(column: CmsColumn, value: unknown, options: DecodeOptions): Promise<unknown> {
  if (value === null || value === undefined) return null;
  switch (column.kind) {
    case "timestamp":
      return iso(value);
    case "file": {
      const image = column.column.endsWith("_image");
      if (Array.isArray(value)) return Promise.all(value.map((entry) => decodeFile(entry, image, options)));
      const single = await decodeFile(value, image, options);
      return column.multiple ? [single] : single;
    }
    default:
      return value;
  }
}

/** One raw row (the `r` json of a compiled query, or an expanded child) → wire row. */
export async function decodeRow(
  model: CmsModel,
  table: CmsTableModel,
  raw: Record<string, unknown>,
  expansions: readonly ExpansionPlan[],
  options: DecodeOptions,
): Promise<DbRow> {
  const out: DbRow = { _id: idString(raw._id) ?? "" };
  const byKey = new Map(expansions.map((plan) => [plan.key, plan]));

  const decodeNested = async (plan: ExpansionPlan, value: unknown): Promise<unknown> => {
    const target = requireTable(model, plan.target);
    if (plan.many) {
      const list = Array.isArray(value) ? value : [];
      return Promise.all(list.map((item) => (isPlainObject(item) ? decodeRow(model, target, item, [], options) : item)));
    }
    return isPlainObject(value) ? decodeRow(model, target, value, [], options) : null;
  };

  const fkColumns = new Set(table.relations.flatMap((r) => (r.kind === "manyToOne" ? [r.column] : [])));
  for (const column of table.columns) {
    const value = raw[column.name];
    const plan = byKey.get(column.name);
    if (plan && plan.relation.kind === "manyToOne") out[column.name] = await decodeNested(plan, value);
    else if (fkColumns.has(column.column)) out[column.name] = idString(value);
    else out[column.name] = await decodeColumn(column, value, options);
  }
  for (const relation of table.relations) {
    if (relation.kind === "manyToOne" || !(relation.name in raw)) continue;
    const plan = byKey.get(relation.name);
    const value = raw[relation.name];
    out[relation.name] = plan ? await decodeNested(plan, value) : Array.isArray(value) ? value.map(idString) : [];
  }
  for (const plan of expansions) {
    if (plan.key !== plan.relation.name) out[plan.key] = await decodeNested(plan, raw[plan.key]);
  }
  for (const [key, column] of [
    ["createdAt", table.createdAt],
    ["updatedAt", table.updatedAt],
  ] as const) {
    if (!column) continue;
    const value = column.kind === "timestamp" ? iso(raw[key]) : raw[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/** Parse the `r` column whatever the connection did with json (parsed or text). */
export function rawRow(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  return isPlainObject(parsed) ? parsed : {};
}
