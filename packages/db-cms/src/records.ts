/**
 * The CMS operations the engine exposes under `P/database/*`: query, create, update,
 * delete, link, unlink (docs/research/02 §1.6 and §6).
 *
 * Protects:
 * - Every call is one transaction with the 10 s statement timeout (`tx.ts`); queries are
 *   READ ONLY. Use a `cms_ro` connection for `executeQuery`/`introspect` and `cms_rw`
 *   for writes.
 * - Writes return the row exactly as a query would (same projection and decoding), so
 *   the UI can use the answer of `create` (`_id` included) without a refetch.
 * - Records are addressed by `_id` = the primary key compared as text.
 * - link/unlink take the property NAME in `propertyId` (what the UI sends; the
 *   `DbProperty.id` is accepted too) and are idempotent: linking twice or unlinking
 *   what is not linked succeeds with `changed: false`. A many-to-many writes the bridge;
 *   a to-one link sets the FK on this record; a one-to-many sets the FK on the child.
 * - `_count: true` puts `{_total}` on `results[0]._count`. An empty page carries no
 *   count; the UI then derives the total from the page (`extractTotal`), which is exact
 *   on the first page.
 */
import type postgres from "postgres";
import type { DbQueryResult, DbRow } from "@forja/contracts/v1";
import { compileQuery } from "./compile.js";
import { CmsError } from "./errors.js";
import type { CmsColumn, CmsModel, CmsRelation, CmsStructure, CmsTableModel } from "./model.js";
import { relationTarget, requireTable, resolveField } from "./resolve.js";
import { decodeRow, rawRow, type DecodeOptions } from "./rows.js";
import { colRef, join, tableRef, txt, type Frag, type SqlTag } from "./sqlkit.js";
import { withCmsTransaction, type CmsCallOptions } from "./tx.js";
import { uuidv7 } from "./uuid.js";
import { encodeWrite } from "./values.js";

export interface CmsOptions extends CmsCallOptions, DecodeOptions {}

function modelOf(structure: CmsStructure | CmsModel): CmsModel {
  return "model" in structure ? structure.model : structure;
}

/** `alias.pk = id`, comparing as text unless the key already is text. */
function pkMatch(sql: SqlTag, alias: string, pk: CmsColumn, id: string): Frag {
  const ref = colRef(sql, alias, pk.column);
  return pk.sqlType === "text" || pk.sqlType.startsWith("character varying")
    ? sql`${ref} = ${txt(sql, id)}`
    : sql`${ref}::text = ${txt(sql, id)}`;
}

function recordId(id: unknown): string {
  if (typeof id === "string" && id !== "") return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  throw new CmsError("VALIDATION", "A record id is required");
}

async function runQuery(tx: postgres.TransactionSql, model: CmsModel, tableName: string, queryOptions: unknown, options: DecodeOptions): Promise<DbQueryResult> {
  const { query, plan } = compileQuery(tx, model, tableName, queryOptions);
  const rows = await query;
  const table = requireTable(model, plan.table);
  const results: DbRow[] = [];
  for (const row of rows) results.push(await decodeRow(model, table, rawRow(row.r), plan.expansions, options));
  const first = results[0];
  if (plan.count && first) first._count = { _total: Number(rows[0]?.c ?? results.length) };
  return { results };
}

async function readRecord(tx: postgres.TransactionSql, model: CmsModel, table: CmsTableModel, id: string, options: DecodeOptions): Promise<DbRow> {
  const { results } = await runQuery(tx, model, table.name, { _filter: { _id: id }, _limit: 1 }, options);
  const row = results[0];
  if (!row) throw new CmsError("RECORD_NOT_FOUND", `Record ${id} does not exist in ${table.name}`, { table: table.name, recordId: id });
  return row;
}

async function exists(tx: postgres.TransactionSql, schema: string, table: CmsTableModel, id: string): Promise<boolean> {
  const rows = await tx`SELECT 1 FROM ${tableRef(tx, schema, table.name)} ${tx("s")} WHERE ${pkMatch(tx, "s", table.pk, id)} LIMIT 1`;
  return rows.length > 0;
}

/** `POST P/database/query` → `{results}`. */
export async function executeQuery(
  sql: postgres.Sql,
  structure: CmsStructure | CmsModel,
  tableName: string,
  queryOptions: unknown,
  options: CmsOptions = {},
): Promise<DbQueryResult> {
  const model = modelOf(structure);
  requireTable(model, tableName);
  return withCmsTransaction(sql, { ...options, readOnly: true }, (tx) => runQuery(tx, model, tableName, queryOptions, options));
}

/** `POST P/database/records` `{tableName, data}` → the new row (with `_id`). */
export async function createRecord(
  sql: postgres.Sql,
  structure: CmsStructure | CmsModel,
  tableName: string,
  data: unknown,
  options: CmsOptions = {},
): Promise<DbRow> {
  const model = modelOf(structure);
  const table = requireTable(model, tableName);
  const { columns, record } = encodeWrite(table, data);

  if (!table.pk.hasDefault) {
    if (table.pk.kind !== "text") {
      throw new CmsError("VALIDATION", `${tableName} has no default for its primary key`, { table: tableName });
    }
    record[table.pk.column] = uuidv7();
    columns.unshift(table.pk);
  }

  return withCmsTransaction(sql, options, async (tx) => {
    const target = tableRef(tx, model.schema, table.name);
    const names: Frag[] = columns.map((c) => tx`${tx(c.column)}`);
    const values: Frag[] = columns.map((c) => colRef(tx, "j", c.column));
    for (const stamp of [table.createdAt, table.updatedAt]) {
      if (stamp && !stamp.hasDefault) {
        names.push(tx`${tx(stamp.column)}`);
        values.push(tx`now()`);
      }
    }
    const rows =
      names.length === 0
        ? await tx`INSERT INTO ${target} DEFAULT VALUES RETURNING ${tx(table.pk.column)}::text AS id`
        : await tx`INSERT INTO ${target} (${join(tx, names, tx`, `)}) SELECT ${join(tx, values, tx`, `)} FROM json_populate_record(NULL::${target}, ${JSON.stringify(record)}::text::json) ${tx("j")} RETURNING ${tx(table.pk.column)}::text AS id`;
    const id = rows[0]?.id;
    if (typeof id !== "string") throw new CmsError("VALIDATION", "The record was not created", { table: tableName });
    return readRecord(tx, model, table, id, options);
  });
}

/** `PATCH P/database/records/{id}` `{tableName, data}` → the updated row. */
export async function updateRecord(
  sql: postgres.Sql,
  structure: CmsStructure | CmsModel,
  tableName: string,
  id: string,
  data: unknown,
  options: CmsOptions = {},
): Promise<DbRow> {
  const model = modelOf(structure);
  const table = requireTable(model, tableName);
  const recordKey = recordId(id);
  const { columns, record } = encodeWrite(table, data);

  return withCmsTransaction(sql, options, async (tx) => {
    const sets: Frag[] = columns.map((c) => tx`${tx(c.column)} = ${colRef(tx, "j", c.column)}`);
    if (table.updatedAt) sets.push(tx`${tx(table.updatedAt.column)} = now()`);
    if (sets.length > 0) {
      const rows = await tx`UPDATE ${tableRef(tx, model.schema, table.name)} AS ${tx("s")} SET ${join(tx, sets, tx`, `)} FROM json_populate_record(NULL::${tableRef(tx, model.schema, table.name)}, ${JSON.stringify(record)}::text::json) ${tx("j")} WHERE ${pkMatch(tx, "s", table.pk, recordKey)} RETURNING 1`;
      if (rows.length === 0) {
        throw new CmsError("RECORD_NOT_FOUND", `Record ${recordKey} does not exist in ${tableName}`, { table: tableName, recordId: recordKey });
      }
    }
    return readRecord(tx, model, table, recordKey, options);
  });
}

/** `DELETE P/database/records/{id}?tableName=` → `{_id}`. */
export async function deleteRecord(
  sql: postgres.Sql,
  structure: CmsStructure | CmsModel,
  tableName: string,
  id: string,
  options: CmsCallOptions = {},
): Promise<{ _id: string }> {
  const model = modelOf(structure);
  const table = requireTable(model, tableName);
  const recordKey = recordId(id);
  return withCmsTransaction(sql, options, async (tx) => {
    const rows = await tx`DELETE FROM ${tableRef(tx, model.schema, table.name)} AS ${tx("s")} WHERE ${pkMatch(tx, "s", table.pk, recordKey)} RETURNING 1`;
    if (rows.length === 0) {
      throw new CmsError("RECORD_NOT_FOUND", `Record ${recordKey} does not exist in ${tableName}`, { table: tableName, recordId: recordKey });
    }
    return { _id: recordKey };
  });
}

// ─── link / unlink ──────────────────────────────────────────────────────────

/** `propertyId` as the UI sends it (the NAME), or a `DbProperty.id`, → relation. */
export function resolveLinkProperty(table: CmsTableModel, propertyId: string): CmsRelation {
  const field = resolveField(table, propertyId);
  if (field) {
    const relation = field.type === "relation" ? field.relation : field.relation;
    if (!relation) throw new CmsError("VALIDATION", `${propertyId} is not a relation`, { table: table.name, property: propertyId });
    return relation;
  }
  const byId = table.relations.filter((r) => r.id === propertyId);
  const only = byId.length === 1 ? byId[0] : undefined;
  if (only) return only;
  throw new CmsError("PROPERTY_NOT_FOUND", `Property ${propertyId} does not exist on ${table.name}`, { table: table.name, property: propertyId });
}

export interface LinkResult {
  _id: string;
  /** The property name the link went through. */
  propertyId: string;
  referenceId: string;
  /** False when the link already was (link) or was not (unlink) there. */
  changed: boolean;
}

async function changeLink(
  mode: "link" | "unlink",
  sql: postgres.Sql,
  structure: CmsStructure | CmsModel,
  tableName: string,
  id: string,
  propertyId: string,
  referenceId: string,
  options: CmsCallOptions,
): Promise<LinkResult> {
  const model = modelOf(structure);
  const table = requireTable(model, tableName);
  const relation = resolveLinkProperty(table, propertyId);
  const target = requireTable(model, relationTarget(relation));
  const self = recordId(id);
  const ref = recordId(referenceId);
  const schema = model.schema;

  return withCmsTransaction(sql, options, async (tx) => {
    const t = tableRef(tx, schema, table.name);
    const o = tableRef(tx, schema, target.name);
    const touch = (model: CmsTableModel): Frag => (model.updatedAt ? tx`, ${tx(model.updatedAt.column)} = now()` : tx``);
    let rows: postgres.RowList<postgres.Row[]>;

    switch (relation.kind) {
      case "manyToMany": {
        const bridge = tableRef(tx, schema, relation.bridge);
        rows =
          mode === "link"
            ? await tx`INSERT INTO ${bridge} (${tx(relation.selfColumn)}, ${tx(relation.otherColumn)}) SELECT ${colRef(tx, "s", relation.localColumn)}, ${colRef(tx, "r", relation.targetColumn)} FROM ${t} ${tx("s")}, ${o} ${tx("r")} WHERE ${pkMatch(tx, "s", table.pk, self)} AND ${pkMatch(tx, "r", target.pk, ref)} ON CONFLICT DO NOTHING RETURNING 1`
            : await tx`DELETE FROM ${bridge} AS ${tx("b")} USING ${t} ${tx("s")}, ${o} ${tx("r")} WHERE ${pkMatch(tx, "s", table.pk, self)} AND ${pkMatch(tx, "r", target.pk, ref)} AND ${colRef(tx, "b", relation.selfColumn)} = ${colRef(tx, "s", relation.localColumn)} AND ${colRef(tx, "b", relation.otherColumn)} = ${colRef(tx, "r", relation.targetColumn)} RETURNING 1`;
        break;
      }
      case "manyToOne":
        rows =
          mode === "link"
            ? await tx`UPDATE ${t} AS ${tx("s")} SET ${tx(relation.column)} = ${colRef(tx, "r", relation.targetColumn)}${touch(table)} FROM ${o} ${tx("r")} WHERE ${pkMatch(tx, "s", table.pk, self)} AND ${pkMatch(tx, "r", target.pk, ref)} AND ${colRef(tx, "s", relation.column)} IS DISTINCT FROM ${colRef(tx, "r", relation.targetColumn)} RETURNING 1`
            : await tx`UPDATE ${t} AS ${tx("s")} SET ${tx(relation.column)} = NULL${touch(table)} FROM ${o} ${tx("r")} WHERE ${pkMatch(tx, "s", table.pk, self)} AND ${pkMatch(tx, "r", target.pk, ref)} AND ${colRef(tx, "s", relation.column)} = ${colRef(tx, "r", relation.targetColumn)} RETURNING 1`;
        break;
      case "oneToMany":
        rows =
          mode === "link"
            ? await tx`UPDATE ${o} AS ${tx("r")} SET ${tx(relation.childColumn)} = ${colRef(tx, "s", relation.localColumn)}${touch(target)} FROM ${t} ${tx("s")} WHERE ${pkMatch(tx, "s", table.pk, self)} AND ${pkMatch(tx, "r", target.pk, ref)} AND ${colRef(tx, "r", relation.childColumn)} IS DISTINCT FROM ${colRef(tx, "s", relation.localColumn)} RETURNING 1`
            : await tx`UPDATE ${o} AS ${tx("r")} SET ${tx(relation.childColumn)} = NULL${touch(target)} FROM ${t} ${tx("s")} WHERE ${pkMatch(tx, "s", table.pk, self)} AND ${pkMatch(tx, "r", target.pk, ref)} AND ${colRef(tx, "r", relation.childColumn)} = ${colRef(tx, "s", relation.localColumn)} RETURNING 1`;
        break;
    }

    if (rows.length === 0) {
      if (!(await exists(tx, schema, table, self))) {
        throw new CmsError("RECORD_NOT_FOUND", `Record ${self} does not exist in ${table.name}`, { table: table.name, recordId: self });
      }
      if (mode === "link" && !(await exists(tx, schema, target, ref))) {
        throw new CmsError("RECORD_NOT_FOUND", `Record ${ref} does not exist in ${target.name}`, { table: target.name, recordId: ref });
      }
    }
    return { _id: self, propertyId: relation.name, referenceId: ref, changed: rows.length > 0 };
  });
}

/** `POST P/database/records/{id}/link` `{tableName, propertyId: <name>, referenceId}`. */
export function link(
  sql: postgres.Sql,
  structure: CmsStructure | CmsModel,
  tableName: string,
  id: string,
  propertyId: string,
  referenceId: string,
  options: CmsCallOptions = {},
): Promise<LinkResult> {
  return changeLink("link", sql, structure, tableName, id, propertyId, referenceId, options);
}

/** `DELETE P/database/records/{id}/link` (JSON body) — same arguments as `link`. */
export function unlink(
  sql: postgres.Sql,
  structure: CmsStructure | CmsModel,
  tableName: string,
  id: string,
  propertyId: string,
  referenceId: string,
  options: CmsCallOptions = {},
): Promise<LinkResult> {
  return changeLink("unlink", sql, structure, tableName, id, propertyId, referenceId, options);
}
