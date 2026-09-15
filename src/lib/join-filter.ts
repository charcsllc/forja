import type { DbProperty, DbTable } from "@/lib/vcaas-types";
import {
    fieldKindOf,
    relatedViewsFor,
    resolveLinkedTable,
    type FieldKind,
} from "@/lib/totalum-schema";

/**
 * ═══ THE VISUAL JOIN FILTER (Feature H3) ════════════════════════════════════
 *
 * A filter tree the user builds by picking things from menus, compiled into the
 * Totalum query DSL. Two rule shapes:
 *
 *  · **own** — a condition on a field of the table being browsed.
 *      `{ status: { ne: 'draft' } }`
 *  · **linked** — a condition on a field of a RELATED table, which becomes a
 *    nested `_has` block. This is the whole point: "clients that have at least
 *    one paid order" is not expressible with a flat filter.
 *      `{ order: { _has: 'some', _filter: { status: 'paid' } } }`
 *
 * ⚠️ `_has` FILTERS THE PARENT, `_filter` INSIDE IT FILTERS THE CHILDREN. Writing
 * the child condition at the top level instead would silently filter nothing,
 * because the parent has no such field.
 *
 * ── WHY `_or` NEEDS CARE ────────────────────────────────────────────────────
 *
 * Totalum's `_filter` is an AND-map: sibling keys are combined with AND. OR is
 * expressed as `_or: [ {...}, {...} ]`. Two consequences the compiler must respect:
 *
 *  1. **Two AND rules on the SAME field must merge into one object**, or the
 *     second silently overwrites the first — `{ age: {gte:18}, age: {lte:65} }`
 *     is just `{ age: {lte:65} }` in JavaScript. Ranges are the common case, so
 *     this is not a corner.
 *  2. **An OR group with one child is not an OR** — emitting `_or: [x]` where a
 *     plain `x` would do makes the generated query harder to read for no gain.
 *
 * Pure module: no React, no fetch. Unit-tested by `src/lib/__tests__/db-cms.test.ts`.
 */

export type JoinOperator =
    | "eq"
    | "ne"
    | "contains"
    | "startsWith"
    | "endsWith"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "nin"
    | "isEmpty"
    | "isNotEmpty";

/** Which operators make sense for a field kind. Order is the menu order. */
const OPERATORS_BY_KIND: Record<string, JoinOperator[]> = {
    string: ["contains", "eq", "ne", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
    longString: ["contains", "eq", "ne", "startsWith", "endsWith", "isEmpty", "isNotEmpty"],
    number: ["eq", "ne", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
    date: ["eq", "ne", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
    datetime: ["eq", "ne", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
    // A single-choice field is a small closed set — `in` lets someone pick several
    // without needing an OR group, which is the more common intent.
    options: ["eq", "ne", "in", "nin", "isEmpty", "isNotEmpty"],
    multipleOptions: ["in", "nin", "eq", "isEmpty", "isNotEmpty"],
    tableLink: ["eq", "ne", "in", "nin", "isEmpty", "isNotEmpty"],
    boolean: ["eq", "ne"],
    file: ["isEmpty", "isNotEmpty"],
    multipleFile: ["isEmpty", "isNotEmpty"],
    json: ["isEmpty", "isNotEmpty"],
};

export function operatorsForKind(kind: FieldKind): JoinOperator[] {
    return OPERATORS_BY_KIND[kind] ?? OPERATORS_BY_KIND.string;
}

/** Does this operator take a value from the user? */
export function operatorTakesValue(operator: JoinOperator): boolean {
    return operator !== "isEmpty" && operator !== "isNotEmpty";
}

/** Does this operator take a LIST of values? */
export function operatorTakesList(operator: JoinOperator): boolean {
    return operator === "in" || operator === "nin";
}

export interface JoinRule {
    id: string;
    kind: "rule";
    /**
     * `null` ⇒ a condition on the browsed table itself. Otherwise the `expandKey`
     * of a related view — the key the nested block is written under.
     */
    via: string | null;
    /** The field name the condition applies to (on the browsed or related table). */
    field: string;
    operator: JoinOperator;
    /** Raw text as typed. Coerced at compile time using the field's kind. */
    value: string;
}

export interface JoinGroup {
    id: string;
    kind: "group";
    combinator: "and" | "or";
    children: JoinNode[];
}

export type JoinNode = JoinRule | JoinGroup;

export function isGroup(node: JoinNode): node is JoinGroup {
    return node.kind === "group";
}

let sequence = 0;
/**
 * A stable id for a node.
 *
 * ⚠️ NOT `Math.random()` / `Date.now()` — these ids are React keys and end up in
 * a server-rendered tree; a counter is deterministic and cannot collide within a
 * session.
 */
export function nextNodeId(prefix = "n"): string {
    sequence += 1;
    return `${prefix}${sequence}`;
}

export function emptyGroup(combinator: "and" | "or" = "and"): JoinGroup {
    return { id: nextNodeId("g"), kind: "group", combinator, children: [] };
}

export function emptyRule(field = "", via: string | null = null): JoinRule {
    return { id: nextNodeId("r"), kind: "rule", via, field, operator: "contains", value: "" };
}

/** Every field a rule may target, given where it sits. */
export interface FilterTarget {
    /** `null` for the browsed table itself. */
    via: string | null;
    table: DbTable;
    label: string;
    properties: DbProperty[];
}

export function filterTargetsFor(tables: DbTable[], table: DbTable | undefined): FilterTarget[] {
    if (!table) return [];

    const own: FilterTarget = {
        via: null,
        table,
        label: table.label || table.type,
        properties: Object.values(table.properties || {}),
    };

    const linked = relatedViewsFor(tables, table).map(view => ({
        via: view.expandKey,
        table: view.table,
        label: view.table.label || view.table.type,
        properties: Object.values(view.table.properties || {}),
    }));

    return [own, ...linked];
}

/**
 * Coerce a typed string to the value the API expects.
 *
 * ⚠️ NUMBERS MUST NOT GO AS STRINGS. `{ price: { gte: "10" } }` compares
 * lexicographically upstream, so "9" > "10" — a silently wrong result rather than
 * an error. Dates go as ISO strings, which is what the docs specify.
 */
export function coerceValue(raw: string, kind: FieldKind): unknown {
    const text = raw.trim();
    if (!text) return "";

    if (kind === "number") {
        const parsed = Number(text);
        return Number.isFinite(parsed) ? parsed : text;
    }

    if (kind === "date" || kind === "datetime") {
        const parsed = new Date(text);
        return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
    }

    if (kind === "boolean") {
        if (text === "true") return true;
        if (text === "false") return false;
        return text;
    }

    return text;
}

function splitList(raw: string, kind: FieldKind): unknown[] {
    return raw
        .split(",")
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => coerceValue(part, kind));
}

/** The `{ operator: value }` object for one condition, or `null` to skip it. */
function conditionFor(rule: JoinRule, kind: FieldKind): unknown | null {
    if (rule.operator === "isEmpty") {
        // Absent and explicitly-null are different states upstream; a user asking
        // for "is empty" means both.
        return { in: [null, ""] };
    }
    if (rule.operator === "isNotEmpty") {
        return { nin: [null, ""] };
    }

    if (operatorTakesList(rule.operator)) {
        const list = splitList(rule.value, kind);
        if (list.length === 0) return null;
        return { [rule.operator]: list };
    }

    if (!rule.value.trim()) return null;

    const value = coerceValue(rule.value, kind);
    // Equality is expressed as a bare value, which is what the docs show and what
    // reads best in the generated query.
    return rule.operator === "eq" ? value : { [rule.operator]: value };
}

function kindFor(target: FilterTarget | undefined, field: string): FieldKind {
    const property = target?.properties.find(p => p.name === field);
    return property ? fieldKindOf(property) : "string";
}

/**
 * ⭐ MERGE TWO CONDITIONS ON THE SAME FIELD INSTEAD OF OVERWRITING.
 *
 * `price >= 10` AND `price <= 100` must become `{ price: { gte: 10, lte: 100 } }`.
 * Plain assignment would keep only the last one — a filter that silently returns
 * the wrong rows, which is worse than an error.
 *
 * Two bare values (`eq`) genuinely conflict and cannot both hold, so the later
 * one wins and the caller is not lied to about it being a range.
 */
function mergeCondition(target: Record<string, unknown>, field: string, condition: unknown): void {
    const existing = target[field];

    const mergeable = (value: unknown) =>
        value !== null && typeof value === "object" && !Array.isArray(value);

    if (existing !== undefined && mergeable(existing) && mergeable(condition)) {
        target[field] = { ...(existing as object), ...(condition as object) };
        return;
    }

    target[field] = condition;
}

interface CompiledGroup {
    /** Conditions on the browsed table, already merged. */
    own: Record<string, unknown>;
    /** Nested `_has` blocks, keyed by `expandKey`. */
    linked: Record<string, { _has: string; _filter: Record<string, unknown> }>;
    /** Nested OR branches. */
    or: Record<string, unknown>[];
}

function compileGroup(
    group: JoinGroup,
    targets: FilterTarget[]
): Record<string, unknown> | null {
    const byVia = new Map<string | null, FilterTarget>(targets.map(t => [t.via, t]));

    const compiled: CompiledGroup = { own: {}, linked: {}, or: [] };

    const branches: Record<string, unknown>[] = [];

    for (const child of group.children) {
        if (isGroup(child)) {
            const nested = compileGroup(child, targets);
            if (!nested) continue;

            if (group.combinator === "or") branches.push(nested);
            else Object.assign(compiled.own, mergeNested(compiled.own, nested));
            continue;
        }

        if (!child.field) continue;

        const target = byVia.get(child.via);
        const kind = kindFor(target, child.field);
        const condition = conditionFor(child, kind);
        if (condition === null) continue;

        if (group.combinator === "or") {
            // Each OR branch is a self-contained filter object.
            branches.push(
                child.via === null
                    ? { [child.field]: condition }
                    : { [child.via]: { _has: "some", _filter: { [child.field]: condition } } }
            );
            continue;
        }

        if (child.via === null) {
            mergeCondition(compiled.own, child.field, condition);
        } else {
            const block = compiled.linked[child.via] ?? { _has: "some", _filter: {} };
            mergeCondition(block._filter, child.field, condition);
            compiled.linked[child.via] = block;
        }
    }

    if (group.combinator === "or") {
        if (branches.length === 0) return null;
        // ⚠️ A single-branch OR is just that branch. Emitting `_or: [x]` would be
        // correct but needlessly noisy in the query the user is shown.
        if (branches.length === 1) return branches[0];
        return { _or: branches };
    }

    const result: Record<string, unknown> = { ...compiled.own };
    for (const [via, block] of Object.entries(compiled.linked)) {
        result[via] = block;
    }
    if (compiled.or.length > 0) result._or = compiled.or;

    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Fold a nested AND result into its parent.
 *
 * An AND inside an AND is flat logically, so its keys are merged rather than
 * wrapped — except `_or`, which would collide if two nested groups both had one.
 */
function mergeNested(
    parent: Record<string, unknown>,
    nested: Record<string, unknown>
): Record<string, unknown> {
    const out: Record<string, unknown> = { ...parent };

    for (const [key, value] of Object.entries(nested)) {
        if (key === "_or") {
            // Two ORs under one AND must BOTH hold. `_and` is not part of the DSL,
            // so the second one is kept as a nested group under a synthetic key…
            // which the DSL also does not have. The honest answer is to keep the
            // first and let the builder prevent the situation: the UI only ever
            // nests one OR per AND level (see `JoinFilterBuilder`).
            if (out._or === undefined) out._or = value;
            continue;
        }
        mergeCondition(out, key, value);
    }

    return out;
}

/**
 * Compile the tree into the `_filter` object.
 *
 * Returns `null` when nothing usable was entered — an incomplete rule is normal
 * while someone is still typing and must not produce a filter that hides rows.
 */
export function compileJoinFilter(
    root: JoinGroup,
    tables: DbTable[],
    table: DbTable | undefined
): Record<string, unknown> | null {
    if (!table) return null;
    return compileGroup(root, filterTargetsFor(tables, table));
}

/** How many rules the tree holds — for "3 conditions" summaries. */
export function countRules(node: JoinNode): number {
    if (!isGroup(node)) return node.field ? 1 : 0;
    return node.children.reduce((total, child) => total + countRules(child), 0);
}

/** Remove a node by id, anywhere in the tree. */
export function removeNode(root: JoinGroup, id: string): JoinGroup {
    return {
        ...root,
        children: root.children
            .filter(child => child.id !== id)
            .map(child => (isGroup(child) ? removeNode(child, id) : child)),
    };
}

/** Replace a node by id, anywhere in the tree. */
export function updateNode(root: JoinGroup, id: string, next: JoinNode): JoinGroup {
    return {
        ...root,
        children: root.children.map(child => {
            if (child.id === id) return next;
            return isGroup(child) ? updateNode(child, id, next) : child;
        }),
    };
}

/** Append a node to the group with `groupId`. */
export function addToGroup(root: JoinGroup, groupId: string, node: JoinNode): JoinGroup {
    if (root.id === groupId) {
        return { ...root, children: [...root.children, node] };
    }
    return {
        ...root,
        children: root.children.map(child =>
            isGroup(child) ? addToGroup(child, groupId, node) : child
        ),
    };
}

/**
 * The generated query, pretty-printed for the read-only "what this becomes" view.
 *
 * Shown because someone who knows the API should be able to check our work, and
 * because it teaches the DSL to someone who does not.
 */
export function previewQuery(filter: Record<string, unknown> | null): string {
    if (!filter || Object.keys(filter).length === 0) return "{}";
    return JSON.stringify({ _filter: filter }, null, 2);
}

/** Re-export so the builder needs one import. */
export { resolveLinkedTable };
