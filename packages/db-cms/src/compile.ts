/**
 * The compiler: `queryOptions` (Totalum's DSL, as the database tab builds it) → one
 * parameterized SELECT over the project's Postgres (docs/architecture/05 §6.3).
 *
 * Protects:
 * - Identifiers come only from the model (`resolve.ts`); values are only parameters.
 * - `_sort` never fails: an unknown or unsortable key falls back to `created_at`, then the
 *   primary key; the primary key always ends the ORDER BY so paging is stable.
 * - A filter value that cannot be parsed for its column (`"abc"` on a number, an invalid
 *   date) compiles to `FALSE`, never to a Postgres error. `ne`/`nin` are the negation of
 *   `eq`/`in` with NULL rows included (Mongo semantics: "not equal" matches a missing value).
 * - `contains`/`startsWith`/`endsWith` are ILIKE with `\`, `%`, `_` escaped.
 * - `{in:[null,""]}` is "is empty" (`IS NULL`, plus `= ''` on text, `[]`/`{}` on JSON,
 *   empty arrays); `{nin:[null,""]}` is its negation.
 * - A relation takes `{_has:"some", _filter}` (EXISTS, through the bridge for
 *   many-to-many). A bare id or `in`/`nin` on a to-many relation matches linked ids.
 * - `_count: true` adds `count(*) OVER ()`; the executor puts it on `results[0]._count._total`.
 * - Every non-`_` key is an expansion by property name: to-one → `row_to_json`, to-many →
 *   `json_agg` capped at 300. Unknown keys are ignored. `_limit` is capped at 1000.
 * - Rows come back as ONE json value per row (`r`), so decoding does not depend on the
 *   connection's type parsers.
 */
import type postgres from "postgres";
import { QueryOptionsSchema, type FilterMap, type FilterValue } from "@forja/contracts/v1";
import { CmsError } from "./errors.js";
import type {
  CmsColumn,
  CmsModel,
  CmsRelation,
  CmsStructure,
  CmsTableModel,
  ManyToManyRelation,
  ManyToOneRelation,
  OneToManyRelation,
} from "./model.js";
import { relationOfField, relationTarget, requireField, requireTable, resolveField } from "./resolve.js";
import { and, arrayLiteral, colRef, join, or, tableRef, txt, type Frag, type SqlTag } from "./sqlkit.js";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const MAX_EXPAND_LIMIT = 300;
/** Nesting of `_or` / `_has` a filter may use (the UI's builder needs 3). */
export const MAX_FILTER_DEPTH = 8;

const RESERVED_KEYS = new Set(["_limit", "_offset", "_sort", "_filter", "_count"]);

export interface ExpansionPlan {
  /** The key as the request named it (the output key too). */
  key: string;
  relation: CmsRelation;
  /** Table of the expanded rows. */
  target: string;
  many: boolean;
  limit: number;
}

export interface QueryPlan {
  table: string;
  count: boolean;
  limit: number;
  offset: number;
  /** Effective ORDER BY, as property names. */
  sort: { property: string; direction: "asc" | "desc" }[];
  expansions: ExpansionPlan[];
}

export interface CompiledQuery {
  /** Lazy: nothing runs until it is awaited. Rows are `{ r: json, c?: count }`. */
  query: postgres.PendingQuery<postgres.Row[]>;
  plan: QueryPlan;
}

type Primitive = string | number | boolean | null;
type CompareOp = "gt" | "gte" | "lt" | "lte";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRelationFilter(value: unknown): value is { _has: unknown; _filter?: unknown } {
  return isPlainObject(value) && "_has" in value;
}

function asPrimitive(value: unknown, op: string): Primitive {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new CmsError("VALIDATION", `Operator ${op} needs a single value`);
}

function asList(value: unknown, op: string): Primitive[] {
  if (!Array.isArray(value)) throw new CmsError("VALIDATION", `Operator ${op} needs a list`);
  return value.map((item) => asPrimitive(item, op));
}

const NUMERIC = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The text Postgres will parse for `value` in a column of this kind, or null if impossible. */
export function filterText(column: CmsColumn, value: Exclude<Primitive, null>): string | null {
  switch (column.kind) {
    case "number": {
      if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
      if (typeof value !== "string") return null;
      const trimmed = value.trim();
      return NUMERIC.test(trimmed) && Number.isFinite(Number(trimmed)) ? trimmed : null;
    }
    case "boolean":
      if (value === true || value === "true" || value === 1 || value === "1") return "true";
      if (value === false || value === "false" || value === 0 || value === "0") return "false";
      return null;
    case "date":
    case "timestamp": {
      if (typeof value === "boolean") return null;
      const trimmed = typeof value === "string" ? value.trim() : value;
      if (trimmed === "") return null;
      const date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) return null;
      if (column.kind === "date") return typeof trimmed === "string" && DATE_ONLY.test(trimmed) ? trimmed : date.toISOString().slice(0, 10);
      return date.toISOString();
    }
    default:
      return String(value);
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const TYPED_KINDS = new Set(["number", "boolean", "date", "timestamp"]);

class Compiler {
  private aliases = 0;

  constructor(
    readonly sql: SqlTag,
    readonly model: CmsModel,
  ) {}

  alias(): string {
    return `t${this.aliases++}`;
  }

  table(name: string): CmsTableModel {
    return requireTable(this.model, name);
  }

  // ─── values ──────────────────────────────────────────────────────────────

  private typed(column: CmsColumn, text: string): Frag {
    const { sql } = this;
    switch (column.kind) {
      case "number":
        return sql`${text}::text::numeric`;
      case "boolean":
        return sql`${text}::text::boolean`;
      case "date":
        return sql`${text}::text::date`;
      case "timestamp":
        return sql`${text}::text::timestamptz`;
      default:
        return txt(sql, text);
    }
  }

  private typedList(column: CmsColumn, texts: string[]): Frag {
    const { sql } = this;
    const literal = arrayLiteral(texts);
    switch (column.kind) {
      case "number":
        return sql`${literal}::text::numeric[]`;
      case "boolean":
        return sql`${literal}::text::boolean[]`;
      case "date":
        return sql`${literal}::text::date[]`;
      case "timestamp":
        return sql`${literal}::text::timestamptz[]`;
      default:
        return sql`${literal}::text::text[]`;
    }
  }

  /** Left-hand side: typed kinds compare natively, everything else as text. */
  private lhs(column: CmsColumn, ref: Frag): Frag {
    return TYPED_KINDS.has(column.kind) ? ref : this.sql`${ref}::text`;
  }

  private emptyJson(ref: Frag): Frag {
    return this.sql`(${ref} IS NULL OR ${ref}::text IN ('null', '[]', '{}', '""'))`;
  }

  // ─── column conditions ───────────────────────────────────────────────────

  private eq(column: CmsColumn, ref: Frag, value: Primitive): Frag {
    const { sql } = this;
    if (value === null) return sql`${ref} IS NULL`;
    if (column.kind === "file" || column.kind === "json") return value === "" ? this.emptyJson(ref) : sql`FALSE`;
    if (column.kind === "enumArray" || column.kind === "array") {
      return sql`${txt(sql, String(value))} = ANY(${ref}::text[])`;
    }
    const text = filterText(column, value);
    if (text === null) return sql`FALSE`;
    if (column.kind === "timestamp" && text.endsWith("T00:00:00.000Z")) {
      // A bare day (the UI turns "2026-09-27" into UTC midnight) matches the whole day.
      return sql`(${ref} >= ${txt(sql, text)}::timestamptz AND ${ref} < ${txt(sql, text)}::timestamptz + interval '1 day')`;
    }
    return sql`${this.lhs(column, ref)} = ${this.typed(column, text)}`;
  }

  private ne(column: CmsColumn, ref: Frag, value: Primitive): Frag {
    if (value === null) return this.sql`${ref} IS NOT NULL`;
    return this.sql`NOT COALESCE(${this.eq(column, ref, value)}, FALSE)`;
  }

  private compare(column: CmsColumn, ref: Frag, op: CompareOp, value: Primitive): Frag {
    const { sql } = this;
    if (value === null) return sql`FALSE`;
    let left: Frag;
    let right: Frag;
    if (column.kind === "number" || column.kind === "date" || column.kind === "timestamp") {
      const text = filterText(column, value);
      if (text === null) return sql`FALSE`;
      left = ref;
      right = this.typed(column, text);
    } else if (column.kind === "text" || column.kind === "other" || column.kind === "enum") {
      left = sql`${ref}::text`;
      right = txt(sql, String(value));
    } else {
      return sql`FALSE`;
    }
    switch (op) {
      case "gt":
        return sql`${left} > ${right}`;
      case "gte":
        return sql`${left} >= ${right}`;
      case "lt":
        return sql`${left} < ${right}`;
      case "lte":
        return sql`${left} <= ${right}`;
    }
  }

  private like(ref: Frag, op: "contains" | "startsWith" | "endsWith", value: Primitive): Frag {
    const { sql } = this;
    if (value === null) return sql`FALSE`;
    const escaped = escapeLike(String(value));
    const pattern = op === "contains" ? `%${escaped}%` : op === "startsWith" ? `${escaped}%` : `%${escaped}`;
    return sql`${ref}::text ILIKE ${txt(sql, pattern)} ESCAPE '\\'`;
  }

  private regex(ref: Frag, value: Primitive, options: unknown): Frag {
    const { sql } = this;
    if (typeof value !== "string" && typeof value !== "number") throw new CmsError("VALIDATION", "regex needs a string");
    const insensitive = typeof options === "string" && options.includes("i");
    return insensitive
      ? sql`${ref}::text ~* ${txt(sql, String(value))}`
      : sql`${ref}::text ~ ${txt(sql, String(value))}`;
  }

  private inList(column: CmsColumn, ref: Frag, list: Primitive[]): Frag {
    const { sql } = this;
    const hasNull = list.includes(null);
    const hasEmpty = list.includes("");
    const rest = list.filter((value): value is string | number | boolean => value !== null && value !== "");
    const parts: Frag[] = [];
    switch (column.kind) {
      case "file":
      case "json":
        if (hasNull || hasEmpty) parts.push(this.emptyJson(ref));
        break;
      case "enumArray":
      case "array":
        if (hasNull || hasEmpty) parts.push(sql`(${ref} IS NULL OR cardinality(${ref}) = 0)`);
        if (rest.length > 0) parts.push(sql`${ref}::text[] && ${this.typedList({ ...column, kind: "text" }, rest.map(String))}`);
        break;
      case "text":
      case "other":
      case "enum":
        if (hasNull) parts.push(sql`${ref} IS NULL`);
        if (hasEmpty) parts.push(sql`${ref}::text = ''`);
        if (rest.length > 0) parts.push(sql`${ref}::text = ANY(${this.typedList(column, rest.map(String))})`);
        break;
      default: {
        if (hasNull || hasEmpty) parts.push(sql`${ref} IS NULL`);
        const texts = rest.map((value) => filterText(column, value)).filter((text): text is string => text !== null);
        if (texts.length > 0) parts.push(sql`${ref} = ANY(${this.typedList(column, texts)})`);
      }
    }
    return or(sql, parts);
  }

  private columnFilter(column: CmsColumn, ref: Frag, value: FilterValue): Frag {
    const { sql } = this;
    if (!isPlainObject(value)) return this.eq(column, ref, asPrimitive(value, "eq"));
    const ops: Record<string, unknown> = value;
    const parts: Frag[] = [];
    for (const [op, operand] of Object.entries(ops)) {
      switch (op) {
        case "ne":
          parts.push(this.ne(column, ref, asPrimitive(operand, op)));
          break;
        case "gt":
        case "gte":
        case "lt":
        case "lte":
          parts.push(this.compare(column, ref, op, asPrimitive(operand, op)));
          break;
        case "contains":
        case "startsWith":
        case "endsWith":
          parts.push(this.like(ref, op, asPrimitive(operand, op)));
          break;
        case "regex":
          parts.push(this.regex(ref, asPrimitive(operand, op), ops.options));
          break;
        case "options":
          break;
        case "in":
          parts.push(this.inList(column, ref, asList(operand, op)));
          break;
        case "nin":
          parts.push(sql`NOT COALESCE(${this.inList(column, ref, asList(operand, op))}, FALSE)`);
          break;
        default:
          throw new CmsError("VALIDATION", `Unknown filter operator ${op}`);
      }
    }
    return and(sql, parts);
  }

  // ─── relations ───────────────────────────────────────────────────────────

  /** `EXISTS (a row on the other side of `relation` for the row `alias`[ that matches])`. */
  private exists(alias: string, relation: CmsRelation, inner?: (target: CmsTableModel, targetAlias: string) => Frag): Frag {
    const { sql } = this;
    const target = this.table(relationTarget(relation));
    const r = this.alias();
    const from = this.relationFrom(alias, relation, target, r);
    const condition = inner ? inner(target, r) : null;
    return sql`EXISTS (SELECT 1 ${from}${condition ? sql` AND ${condition}` : sql``})`;
  }

  /** `FROM … WHERE <join to alias>` for the rows of `relation`, target aliased `r`. */
  private relationFrom(alias: string, relation: CmsRelation, target: CmsTableModel, r: string): Frag {
    const { sql } = this;
    const schema = this.model.schema;
    switch (relation.kind) {
      case "manyToOne":
        return sql`FROM ${tableRef(sql, schema, target.name)} ${sql(r)} WHERE ${colRef(sql, r, relation.targetColumn)} = ${colRef(sql, alias, relation.column)}`;
      case "oneToMany":
        return sql`FROM ${tableRef(sql, schema, target.name)} ${sql(r)} WHERE ${colRef(sql, r, relation.childColumn)} = ${colRef(sql, alias, relation.localColumn)}`;
      case "manyToMany": {
        const b = this.alias();
        return sql`FROM ${tableRef(sql, schema, relation.bridge)} ${sql(b)} JOIN ${tableRef(sql, schema, target.name)} ${sql(r)} ON ${colRef(sql, r, relation.targetColumn)} = ${colRef(sql, b, relation.otherColumn)} WHERE ${colRef(sql, b, relation.selfColumn)} = ${colRef(sql, alias, relation.localColumn)}`;
      }
    }
  }

  /** Primitive conditions on a to-many relation compare the ids of the linked rows. */
  private toManyFilter(alias: string, relation: OneToManyRelation | ManyToManyRelation, value: FilterValue): Frag {
    const { sql } = this;
    const anyLink = () => this.exists(alias, relation);
    const idIn = (ids: string[]) =>
      this.exists(alias, relation, (target, r) => sql`${colRef(sql, r, target.pk.column)}::text = ANY(${arrayLiteral(ids)}::text::text[])`);
    const eq = (v: Primitive): Frag => (v === null || v === "" ? sql`NOT ${anyLink()}` : idIn([String(v)]));
    const inList = (list: Primitive[]): Frag => {
      const parts: Frag[] = [];
      if (list.some((v) => v === null || v === "")) parts.push(sql`NOT ${anyLink()}`);
      const ids = list.filter((v) => v !== null && v !== "").map(String);
      if (ids.length > 0) parts.push(idIn(ids));
      return or(sql, parts);
    };

    if (!isPlainObject(value)) return eq(asPrimitive(value, "eq"));
    const parts: Frag[] = [];
    for (const [op, operand] of Object.entries(value)) {
      switch (op) {
        case "ne": {
          const v = asPrimitive(operand, op);
          parts.push(v === null || v === "" ? anyLink() : sql`NOT ${idIn([String(v)])}`);
          break;
        }
        case "in":
          parts.push(inList(asList(operand, op)));
          break;
        case "nin":
          parts.push(sql`NOT ${inList(asList(operand, op))}`);
          break;
        case "options":
          break;
        case "gt":
        case "gte":
        case "lt":
        case "lte":
        case "contains":
        case "startsWith":
        case "endsWith":
        case "regex":
          parts.push(sql`FALSE`);
          break;
        default:
          throw new CmsError("VALIDATION", `Unknown filter operator ${op}`);
      }
    }
    return and(sql, parts);
  }

  // ─── filter maps ─────────────────────────────────────────────────────────

  filterMap(table: CmsTableModel, alias: string, map: FilterMap, depth = 0): Frag {
    const { sql } = this;
    if (depth > MAX_FILTER_DEPTH) throw new CmsError("VALIDATION", `Filters may nest at most ${MAX_FILTER_DEPTH} levels`);
    const parts: Frag[] = [];
    for (const [key, value] of Object.entries(map)) {
      if (key === "_or") {
        if (!Array.isArray(value)) throw new CmsError("VALIDATION", "_or needs a list of filters");
        const branches = value.map((branch: unknown) => {
          if (!isPlainObject(branch)) throw new CmsError("VALIDATION", "Each _or branch must be a filter object");
          return this.filterMap(table, alias, branch as FilterMap, depth + 1);
        });
        if (branches.length > 0) parts.push(or(sql, branches));
        continue;
      }
      if (Array.isArray(value)) throw new CmsError("VALIDATION", `The filter on ${key} must be a value or an operator object`);
      parts.push(this.fieldFilter(table, alias, key, value, depth));
    }
    return and(sql, parts);
  }

  private fieldFilter(table: CmsTableModel, alias: string, key: string, value: FilterValue, depth: number): Frag {
    const field = requireField(table, key);
    if (isRelationFilter(value)) {
      const relation = relationOfField(field);
      if (!relation) throw new CmsError("VALIDATION", `${key} is not a relation`, { table: table.name, property: key });
      if (value._has !== "some") throw new CmsError("VALIDATION", `Only _has: "some" is supported`);
      const inner = isPlainObject(value._filter) ? (value._filter as FilterMap) : {};
      return this.exists(alias, relation, (target, r) => this.filterMap(target, r, inner, depth + 1));
    }
    if (field.type === "column") return this.columnFilter(field.column, colRef(this.sql, alias, field.column.column), value);
    return this.toManyFilter(alias, field.relation, value);
  }

  // ─── ordering ────────────────────────────────────────────────────────────

  private orderTerm(column: CmsColumn, alias: string, direction: "asc" | "desc"): Frag {
    const { sql } = this;
    const ref = colRef(sql, alias, column.column);
    const expr = column.kind === "json" || column.kind === "file" || column.kind === "other" ? sql`${ref}::text` : ref;
    return direction === "desc" ? sql`${expr} DESC NULLS LAST` : sql`${expr} ASC NULLS LAST`;
  }

  /** Default order of a table: newest first, then by id. */
  defaultOrder(table: CmsTableModel, alias: string): Frag {
    const terms = [table.createdAt, table.pk].filter((c): c is CmsColumn => c !== undefined);
    return join(this.sql, terms.map((c) => this.orderTerm(c, alias, "desc")), this.sql`, `);
  }

  sortTerms(table: CmsTableModel, alias: string, sort: Record<string, "asc" | "desc"> | undefined): { frag: Frag; plan: QueryPlan["sort"] } {
    const terms: Frag[] = [];
    const plan: QueryPlan["sort"] = [];
    const seen = new Set<string>();
    const push = (column: CmsColumn, direction: "asc" | "desc") => {
      if (seen.has(column.column)) return;
      seen.add(column.column);
      terms.push(this.orderTerm(column, alias, direction));
      plan.push({ property: column.name, direction });
    };
    for (const [key, direction] of Object.entries(sort ?? {})) {
      const field = resolveField(table, key);
      const column = field?.type === "column" ? field.column : (table.createdAt ?? table.pk);
      push(column, direction === "desc" ? "desc" : "asc");
    }
    if (plan.length === 0 && table.createdAt) push(table.createdAt, "desc");
    push(table.pk, plan[0]?.direction ?? "asc");
    return { frag: join(this.sql, terms, this.sql`, `), plan };
  }

  // ─── projection and expansions ───────────────────────────────────────────

  expansions(table: CmsTableModel, options: Record<string, unknown>): ExpansionPlan[] {
    const plans: ExpansionPlan[] = [];
    for (const [key, value] of Object.entries(options)) {
      if (RESERVED_KEYS.has(key) || key.startsWith("_")) continue;
      const field = resolveField(table, key);
      const relation = field ? relationOfField(field) : undefined;
      if (!relation) continue;
      const requested = isPlainObject(value) && typeof value._limit === "number" ? value._limit : MAX_EXPAND_LIMIT;
      plans.push({
        key,
        relation,
        target: relationTarget(relation),
        many: relation.kind !== "manyToOne",
        limit: Math.min(Math.max(1, Math.floor(requested)), MAX_EXPAND_LIMIT),
      });
    }
    return plans;
  }

  private expandOne(alias: string, relation: ManyToOneRelation): Frag {
    const { sql } = this;
    const target = this.table(relation.target);
    const r = this.alias();
    const e = this.alias();
    const from = this.relationFrom(alias, relation, target, r);
    return sql`(SELECT row_to_json(${sql(e)}) FROM (SELECT ${this.projection(target, r, [], false)} ${from} LIMIT 1) ${sql(e)})`;
  }

  private expandMany(alias: string, relation: OneToManyRelation | ManyToManyRelation, limit: number): Frag {
    const { sql } = this;
    const target = this.table(relationTarget(relation));
    const r = this.alias();
    const e = this.alias();
    const from = this.relationFrom(alias, relation, target, r);
    return sql`(SELECT COALESCE(json_agg(${sql(e)}), '[]'::json) FROM (SELECT ${this.projection(target, r, [], false)} ${from} ORDER BY ${this.defaultOrder(target, r)} LIMIT ${String(limit)}::text::int) ${sql(e)})`;
  }

  /** The linked ids of a many-to-many, as a JSON array of strings (at most 300). */
  private linkIds(alias: string, relation: ManyToManyRelation): Frag {
    const { sql } = this;
    const target = this.table(relation.target);
    const r = this.alias();
    const e = this.alias();
    const from = this.relationFrom(alias, relation, target, r);
    return sql`(SELECT COALESCE(json_agg(${sql(e)}.id), '[]'::json) FROM (SELECT ${colRef(sql, r, target.pk.column)}::text AS id ${from} ORDER BY 1 LIMIT ${String(MAX_EXPAND_LIMIT)}::text::int) ${sql(e)})`;
  }

  projection(table: CmsTableModel, alias: string, expansions: ExpansionPlan[], withLinks: boolean): Frag {
    const { sql } = this;
    const items: Frag[] = [];
    const item = (expr: Frag, name: string) => sql`${expr} AS ${sql(name)}`;
    const byKey = new Map(expansions.map((plan) => [plan.key, plan]));

    items.push(item(colRef(sql, alias, table.pk.column), "_id"));
    if (table.createdAt) items.push(item(colRef(sql, alias, table.createdAt.column), "createdAt"));
    if (table.updatedAt) items.push(item(colRef(sql, alias, table.updatedAt.column), "updatedAt"));

    for (const column of table.columns) {
      const plan = byKey.get(column.name);
      items.push(
        item(plan?.relation.kind === "manyToOne" ? this.expandOne(alias, plan.relation) : colRef(sql, alias, column.column), column.name),
      );
    }
    for (const relation of table.relations) {
      if (relation.kind === "manyToOne") continue;
      const plan = byKey.get(relation.name);
      if (plan) items.push(item(this.expandMany(alias, relation, plan.limit), relation.name));
      else if (withLinks && relation.kind === "manyToMany") items.push(item(this.linkIds(alias, relation), relation.name));
    }
    // Expansions requested by table name (fallback key) come out under that key.
    for (const plan of expansions) {
      if (plan.key === plan.relation.name) continue;
      const expr = plan.relation.kind === "manyToOne" ? this.expandOne(alias, plan.relation) : this.expandMany(alias, plan.relation, plan.limit);
      items.push(item(expr, plan.key));
    }
    return join(sql, items, sql`, `);
  }
}

function modelOf(structure: CmsStructure | CmsModel): CmsModel {
  return "model" in structure ? structure.model : structure;
}

/**
 * Compile `queryOptions` for `tableName`. Throws `CmsError` (TABLE_NOT_FOUND,
 * PROPERTY_NOT_FOUND, VALIDATION) before anything runs. Build it with the connection or
 * transaction that will await it.
 */
export function compileQuery(sql: SqlTag, structure: CmsStructure | CmsModel, tableName: string, queryOptions: unknown): CompiledQuery {
  const parsed = QueryOptionsSchema.safeParse(queryOptions ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
    throw new CmsError("VALIDATION", `Invalid queryOptions${where}: ${issue?.message ?? "malformed"}`, { table: tableName });
  }
  const options = parsed.data;
  const compiler = new Compiler(sql, modelOf(structure));
  const table = compiler.table(tableName);
  const alias = compiler.alias();

  const where = options._filter ? compiler.filterMap(table, alias, options._filter) : sql`TRUE`;
  const expansions = compiler.expansions(table, options);
  const { frag: order, plan: sortPlan } = compiler.sortTerms(table, alias, options._sort);
  const limit = Math.min(Math.max(1, Math.floor(options._limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const offset = Math.max(0, Math.floor(options._offset ?? 0));
  const count = options._count === true;
  const e = compiler.alias();
  const projection = compiler.projection(table, alias, expansions, true);

  const query = sql`SELECT (SELECT row_to_json(${sql(e)}) FROM (SELECT ${projection}) ${sql(e)}) AS r${
    count ? sql`, count(*) OVER () AS c` : sql``
  } FROM ${tableRef(sql, compiler.model.schema, table.name)} ${sql(alias)} WHERE ${where} ORDER BY ${order} LIMIT ${String(limit)}::text::int OFFSET ${String(offset)}::text::int`;

  return {
    query,
    plan: { table: table.name, count, limit, offset, sort: sortPlan, expansions },
  };
}
