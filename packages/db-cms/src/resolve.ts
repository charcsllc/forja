/**
 * Name resolution: request names (tables, properties, expansion keys) → the model.
 *
 * Protects: a name the model does not know is refused (TABLE_NOT_FOUND /
 * PROPERTY_NOT_FOUND) before any SQL is built. Lookups use own properties only, so
 * `constructor` or `__proto__` never resolve to anything.
 */
import { CmsError } from "./errors.js";
import type { CmsModel, CmsRelation, CmsTableModel, ResolvedField } from "./model.js";

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function requireTable(model: CmsModel, name: string): CmsTableModel {
  const table = own(model.tables, name);
  if (!table) throw new CmsError("TABLE_NOT_FOUND", `Table ${name} does not exist`, { table: name });
  return table;
}

/** The table on the other side of a relation. */
export function relationTarget(relation: CmsRelation): string {
  return relation.kind === "oneToMany" ? relation.child : relation.target;
}

/**
 * A property name → column or relation. `_id`, `createdAt`, `updatedAt` are the system
 * columns. As a fallback a TABLE name resolves to the only relation this table has with
 * that table: the UI expands and filters relations declared on the other side by the
 * other table's `type` (`relatedViewsFor` in apps/web).
 */
export function resolveField(table: CmsTableModel, key: string): ResolvedField | null {
  if (key === "_id") return { type: "column", column: table.pk };
  if (key === "createdAt" && table.createdAt) return { type: "column", column: table.createdAt };
  if (key === "updatedAt" && table.updatedAt) return { type: "column", column: table.updatedAt };

  const column = table.columns.find((c) => c.name === key);
  if (column) {
    const relation = table.relations.find((r) => r.kind === "manyToOne" && r.column === column.column);
    return relation?.kind === "manyToOne" ? { type: "column", column, relation } : { type: "column", column };
  }
  const relation = table.relations.find((r) => r.name === key);
  if (relation && relation.kind !== "manyToOne") return { type: "relation", relation };

  const byTable = table.relations.filter((r) => relationTarget(r) === key);
  const only = byTable.length === 1 ? byTable[0] : undefined;
  if (!only) return null;
  if (only.kind !== "manyToOne") return { type: "relation", relation: only };
  const fkColumn = table.columns.find((c) => c.column === only.column);
  return fkColumn ? { type: "column", column: fkColumn, relation: only } : null;
}

export function requireField(table: CmsTableModel, key: string): ResolvedField {
  const field = resolveField(table, key);
  if (!field) {
    throw new CmsError("PROPERTY_NOT_FOUND", `Property ${key} does not exist on ${table.name}`, {
      table: table.name,
      property: key,
    });
  }
  return field;
}

/** The relation a resolved field carries, if any. */
export function relationOfField(field: ResolvedField): CmsRelation | undefined {
  return field.type === "relation" ? field.relation : field.relation;
}
