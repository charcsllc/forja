import { linkFieldsOf, relationOf, storesIdOnRecord } from "@/lib/totalum-schema";
import type { DbProperty, DbTable } from "@/lib/vcaas-types";

/**
 * ═══ THE TOTALUM QUERY DSL ══════════════════════════════════════════════════
 *
 * `POST …/database/query` takes `{ tableName, queryOptions }`, where
 * `queryOptions` uses underscore-prefixed system keys and treats every other key
 * as a relation to expand:
 *
 *   `_limit`   page size
 *   `_offset`  rows to skip
 *   `_sort`    `{ field: 'asc' | 'desc' }`
 *   `_filter`  `{ field: value }` or `{ field: { operator: value } }`, plus `_or`
 *   `_count`   include the total row count
 *
 * Pure module — no React, no fetch. Unit-tested alongside the other panel logic.
 */

/**
 * Rows per page, and the choices offered in the toolbar.
 *
 * ⚠️ `PAGE_SIZE` IS THE DEFAULT, NOT THE ONLY VALUE. Every function that pages
 * takes the size as an argument now: a query built with 100 and a total computed
 * with 25 would disagree about how many pages exist, and the pager would offer
 * page 4 of a 3-page result.
 */
export const PAGE_SIZE = 25;
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

/**
 * Type guard for the page sizes the database grid offers.
 */
export function isPageSize(value: unknown): value is PageSize {
    return PAGE_SIZE_OPTIONS.includes(Number(value) as PageSize);
}

/** Fields Totalum manages; never offered for editing. */
export const SYSTEM_FIELDS = new Set(["_id", "createdAt", "updatedAt", "createdBy", "lastUpdatedBy"]);

export type FilterOperator =
    | "eq" | "ne"
    | "contains" | "startsWith" | "endsWith" | "regex"
    | "gt" | "gte" | "lt" | "lte";

export interface FilterRule {
    id: string;
    field: string;
    operator: FilterOperator;
    value: string;
}

/** Which operators make sense for which property type. */
const OPERATORS: { value: FilterOperator; types: string[] }[] = [
    { value: "eq", types: ["string", "long-string", "number", "date", "objectReference", "boolean"] },
    { value: "ne", types: ["string", "long-string", "number", "date", "objectReference", "boolean"] },
    { value: "contains", types: ["string", "long-string"] },
    { value: "startsWith", types: ["string", "long-string"] },
    { value: "endsWith", types: ["string", "long-string"] },
    { value: "regex", types: ["string", "long-string"] },
    { value: "gt", types: ["number", "date"] },
    { value: "gte", types: ["number", "date"] },
    { value: "lt", types: ["number", "date"] },
    { value: "lte", types: ["number", "date"] },
];

/**
 * The filter operators available for a property type. Unknown types still get equality so a filter row is never empty.
 */
export function operatorsForType(propertyType: string): FilterOperator[] {
    const matches = OPERATORS.filter(op => op.types.includes(propertyType)).map(op => op.value);
    // An unknown/custom property type still needs equality, or its filter row is
    // unusable rather than merely limited.
    return matches.length > 0 ? matches : ["eq", "ne"];
}

/** Numeric-looking strings become numbers so `gt`/`lt` compare correctly. */
function coerce(value: string, propertyType?: string): string | number {
    if (propertyType === "number") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
}

/**
 * Compile the grid's filter rules into the `_filter` document the API expects, coercing values by property type.
 */
export function buildFilter(
    rules: FilterRule[],
    propertiesByName: Record<string, DbProperty | undefined> = {}
): Record<string, unknown> {
    const filter: Record<string, unknown> = {};

    for (const rule of rules) {
        // An empty value means "not filled in yet", not "match empty".
        if (!rule.field || rule.value.trim() === "") continue;

        const propertyType = propertiesByName[rule.field]?.propertyType;
        const value = coerce(rule.value.trim(), propertyType);

        if (rule.operator === "eq") {
            filter[rule.field] = value;
        } else if (rule.operator === "regex") {
            // `options: 'i'` — a case-sensitive regex filter would surprise everyone.
            filter[rule.field] = { regex: rule.value.trim(), options: "i" };
        } else {
            filter[rule.field] = { [rule.operator]: value };
        }
    }

    return filter;
}

/**
 * Quick search across every text field of a table, as one `_or`.
 *
 * ⚠️ THE INPUT IS REGEX-ESCAPED. `contains` is implemented as a regex upstream,
 * so an unescaped `(` from a user's search box is a syntax error at best and a
 * catastrophically backtracking pattern at worst.
 */
export function buildSearchOr(table: DbTable | undefined, search: string): Record<string, unknown>[] | null {
    const query = search.trim();
    if (!query || !table) return null;

    const textFields = Object.values(table.properties).filter(
        property =>
            ["string", "long-string"].includes(property.propertyType) && property.name !== "_id"
    );
    if (textFields.length === 0) return null;

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return textFields.map(field => ({ [field.name]: { regex: escaped, options: "i" } }));
}

export interface QueryOptionsInput {
    page: number;
    sortField: string;
    sortDirection: "asc" | "desc";
    filters: FilterRule[];
    search: string;
    table: DbTable | undefined;
    /**
     * FEATURE H3 — the compiled visual join filter, merged in as extra `_filter`
     * keys. Optional and absent by default, so every pre-H3 caller builds exactly
     * the same options object it always did.
     */
    joinFilter?: Record<string, unknown> | null;
    /** Rows per page. Defaults to `PAGE_SIZE` so existing callers are unchanged. */
    pageSize?: number;
    /**
     * ⭐ RELATIONS TO EXPAND — see `buildLinkExpansion`. Merged in at the TOP
     * level of `queryOptions`, which is where the DSL puts them: every key that
     * does not start with `_` names a relation.
     */
    expand?: Record<string, unknown> | null;
}

export function buildQueryOptions({
    page,
    sortField,
    sortDirection,
    filters,
    search,
    table,
    joinFilter,
    pageSize = PAGE_SIZE,
    expand,
}: QueryOptionsInput): Record<string, unknown> {
    const propertiesByName = table?.properties ?? {};

    const options: Record<string, unknown> = {
        _limit: pageSize,
        _offset: Math.max(0, page - 1) * pageSize,
        _sort: { [sortField]: sortDirection },
        _count: true,
    };

    const filter = buildFilter(filters, propertiesByName);

    /**
     * ⚠️ THE JOIN FILTER AND THE SEARCH BOX BOTH WANT `_or`, AND ONLY ONE CAN
     * HAVE IT. Totalum's `_filter` ANDs sibling keys and has `_or` but no `_and`,
     * so two independent OR sets cannot both sit at the top level — the second
     * assignment would silently discard the first.
     *
     * The join filter wins, because it is the deliberate, visible artefact the
     * user built; the search box is transient text. Search still applies, but as
     * a single-field `regex` (one key, which ANDs cleanly) against the most
     * likely label field instead of an OR across several. Narrower than usual,
     * never wrong, and never silently drops the filter someone just built.
     */
    if (joinFilter) Object.assign(filter, joinFilter);

    const searchOr = buildSearchOr(table, search);
    if (searchOr && searchOr.length > 0) {
        if (filter._or === undefined) {
            filter._or = searchOr;
        } else {
            const [firstBranch] = searchOr;
            for (const [field, condition] of Object.entries(firstBranch)) {
                if (filter[field] === undefined) filter[field] = condition;
            }
        }
    }

    if (Object.keys(filter).length > 0) options._filter = filter;

    /**
     * ⚠️ EXPANSIONS GO LAST, AND `_`-PREFIXED KEYS ARE REFUSED. A relation whose
     * field name happened to start with an underscore would land on top of
     * `_filter` or `_limit` and silently rewrite the query.
     */
    for (const [name, config] of Object.entries(expand ?? {})) {
        if (name.startsWith("_")) continue;
        options[name] = config;
    }

    return options;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Expanding relations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⭐ HOW MANY RELATION COLUMNS RESOLVE THEIR LINKED RECORD.
 *
 * ⚠️ EXPANSION IS NOT FREE — every expanded field is a join Totalum runs per row,
 * so a table with ten relations would multiply the cost of the one query this
 * panel makes most often. Three is what fits on screen as readable labels anyway.
 */
export const LINK_PREVIEW_MAX_COLUMNS = 3;

/**
 * ⚠️ AND A MANY-SIDED RELATION IS CAPPED HARD. Totalum's default is 300 CHILDREN
 * PER RELATION PER ROW; on a 100-row page that is 30 000 records fetched to
 * render a cell that says "3 linked". The cell shows at most a few labels, so a
 * few is all we ask for.
 */
export const LINK_EXPAND_LIMIT = 5;

/**
 * The relation columns whose linked records are resolved into labels, in the
 * order the schema declares them.
 *
 * ⚠️ SCHEMA ORDER, NOT "THE ONES WITH VALUES". Choosing by content would move the
 * readable columns around as you page, which reads as a bug.
 */
export function previewLinkProperties(table: DbTable | undefined): DbProperty[] {
    return linkFieldsOf(table).slice(0, LINK_PREVIEW_MAX_COLUMNS);
}

/**
 * `queryOptions` fragment that expands the given relation fields.
 *
 * ⚠️ THE SHAPE DIFFERS BY SIDE, and it matters:
 *   · `manyToOne` / `oneToOne` → `true`. One record, so there is nothing to cap.
 *   · `oneToMany` / `manyToMany` → `{ _limit }`. An object config expands too,
 *     and it is the only place the child count can be bounded.
 *
 * ⚠️ AN EXPANDED FIELD CHANGES TYPE — the docs say so explicitly: `user_id` goes
 * from `"64a1…"` to `{ _id: "64a1…", name: "John" }`. Everything downstream must
 * read the id through `linkedIdOf` / `linkedIdsOf`, which handle both shapes.
 * That is why they exist.
 */
export function buildLinkExpansion(properties: DbProperty[]): Record<string, unknown> {
    const expansion: Record<string, unknown> = {};

    for (const property of properties) {
        if (property.name.startsWith("_")) continue;
        expansion[property.name] = storesIdOnRecord(relationOf(property))
            ? true
            : { _limit: LINK_EXPAND_LIMIT };
    }

    return expansion;
}

/**
 * Pull the total row count out of a query result.
 *
 * ⚠️ Totalum returns `_count` as METADATA ON THE FIRST RECORD, not as a sibling of
 * `results`. Miss that and the pager silently reports one page for every table.
 * When it is absent we fall back to a conservative estimate that still paginates
 * correctly rather than claiming a total we do not have.
 */
export function extractTotal(
    results: Record<string, unknown>[],
    page: number,
    pageSize: number = PAGE_SIZE
): number | null {
    const first = results[0];
    if (first && typeof first._count === "object" && first._count !== null) {
        const total = (first._count as { _total?: unknown })._total;
        if (typeof total === "number") return total;
    }

    // No count metadata: a short page means this is the last one.
    if (results.length < pageSize) return (page - 1) * pageSize + results.length;
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Property type → form input
// ═══════════════════════════════════════════════════════════════════════════

export type EditorKind = "text" | "textarea" | "number" | "date" | "datetime" | "boolean" | "reference" | "json";

/**
 * The input to render for a property.
 *
 * `file` is handled by the caller (uploads are not editable as text), and
 * `objectReference` gets a plain id field: resolving it into a picker would need a
 * second query per reference on every row.
 */
export function editorKindFor(property: DbProperty): EditorKind {
    switch (property.propertyType) {
        case "number": return "number";
        case "boolean": return "boolean";
        case "date": {
            // `typeExtras` is loosely typed (`Record<string, unknown>`) because its
            // shape varies per property type — narrow it here rather than widening
            // the shared interface for one field.
            const dateExtras = property.typeExtras?.date as { includeHour?: boolean } | undefined;
            return dateExtras?.includeHour ? "datetime" : "date";
        }
        case "long-string": return "textarea";
        case "objectReference": return "reference";
        case "array":
        case "object": return "json";
        default: return "text";
    }
}

/** Turn a stored value into something an `<input>` can hold. */
export function toInputValue(value: unknown, kind: EditorKind): string {
    if (value === null || value === undefined) return "";

    if (kind === "json") {
        try {
            return typeof value === "string" ? value : JSON.stringify(value, null, 2);
        } catch {
            return String(value);
        }
    }

    if (kind === "date" || kind === "datetime") {
        const date = new Date(String(value));
        if (Number.isNaN(date.getTime())) return "";
        // `datetime-local` wants `YYYY-MM-DDTHH:mm`; `date` wants `YYYY-MM-DD`.
        const iso = date.toISOString();
        return kind === "datetime" ? iso.slice(0, 16) : iso.slice(0, 10);
    }

    if (typeof value === "object") {
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }

    return String(value);
}

/**
 * Turn form input back into the value to send.
 *
 * Returns `undefined` for a field the user left blank, so it is OMITTED from the
 * payload rather than written as `""` — writing an empty string over an absent
 * optional field changes the record in a way the user did not ask for.
 */
export function fromInputValue(raw: string, kind: EditorKind): unknown {
    const trimmed = raw.trim();
    if (trimmed === "") return undefined;

    switch (kind) {
        case "number": {
            const parsed = Number(trimmed);
            return Number.isFinite(parsed) ? parsed : trimmed;
        }
        case "boolean":
            return trimmed === "true" || trimmed === "1";
        case "json":
            try {
                return JSON.parse(trimmed);
            } catch {
                // Invalid JSON is surfaced by the caller's validation; passing the raw
                // string through would silently store a broken value.
                return trimmed;
            }
        case "date":
        case "datetime": {
            const date = new Date(trimmed);
            return Number.isNaN(date.getTime()) ? trimmed : date.toISOString();
        }
        default:
            return trimmed;
    }
}

/** Validate a JSON field before submit, so a typo cannot silently corrupt a record. */
export function jsonFieldError(raw: string, kind: EditorKind): boolean {
    if (kind !== "json" || raw.trim() === "") return false;
    try {
        JSON.parse(raw);
        return false;
    } catch {
        return true;
    }
}

/** The properties a user may edit, in a stable order. */
/**
 * ⚠️⚠️ FILE PROPERTIES ARE EDITABLE NOW, AND EXCLUDING THEM WAS A BUG WITH NO
 * SYMPTOM IN THE SOURCE. `propertyType !== 'file'` filtered them out here, which
 * meant `RecordForm`'s `isFileKind` branch — a whole `<FileField>` with upload,
 * preview and removal — could never render for anything. The form looked complete
 * and silently had no way to attach a file to a record that has a file column.
 *
 * `SYSTEM_FIELDS` still goes: `_id`, `createdAt` and friends are Totalum's to
 * write, and offering them would let a user corrupt a record's identity.
 */
export function editableProperties(table: DbTable | undefined): DbProperty[] {
    if (!table) return [];
    return Object.values(table.properties).filter(
        property => !SYSTEM_FIELDS.has(property.name)
    );
}
