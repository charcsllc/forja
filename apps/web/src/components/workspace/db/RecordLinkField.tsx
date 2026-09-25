"use client";

import * as React from "react";
import { CheckIcon, LinkIcon, LoaderIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import { toast } from "@/lib/toast";
import { vcaasApi } from "@/lib/vcaas";
import {
    inverseLinkPropertyOf,
    labelForRecord,
    labelForTable,
    linkedIdOf,
    linkedIdsOf,
    type RelationKind,
} from "@/lib/totalum-schema";
import type { DbProperty, DbTable } from "@/lib/vcaas-types";
import { cn } from "@/lib/utils";

/**
 * ═══ PICKING A LINKED RECORD (Feature H3) ═══════════════════════════════════
 *
 * A `tableLink` field, rendered as something a person can actually use: search
 * the target table, see MEANINGFUL LABELS rather than ObjectIds, and create the
 * linked record inline when it does not exist yet.
 *
 * ── THE THREE RELATION KINDS ARE NOT THE SAME CONTROL ───────────────────────
 *
 * ⚠️ AND THEY ARE NOT WRITTEN THE SAME WAY EITHER:
 *
 *  · `manyToOne` / `oneToOne` — the id lives in THIS field. Single select, and
 *    saving is an ordinary record update. This component owns the value.
 *  · `manyToMany` — Totalum owns a junction table. Multi select, and links are
 *    made with the dedicated add/drop-reference endpoints. **We never create a
 *    junction table by hand** — the docs are explicit and doing so would corrupt
 *    the relation.
 *  · `oneToMany` — the CHILD holds the id. Editable here all the same, by writing
 *    the child's back-reference; see `ChildLinkEditor` below.
 *
 * ── ⭐ `oneToMany` USED TO BE A PARAGRAPH OF TEXT, AND THAT WAS THE BUG ──────
 *
 * This field used to render "these live on the {table} side, so you add and
 * remove them from the record's related list rather than here" and stop. Two
 * things were wrong with that:
 *
 *   1. **It was the only place a person could get to.** The related-records list
 *      it directed people to was never rendered by `DatabasePanel` (the detail
 *      view was dead code), so the instruction pointed at a screen that did not
 *      exist and the relation was uneditable from anywhere in the product.
 *   2. **The premise was wrong anyway.** "The id is on the child" explains where
 *      the WRITE goes, not who may ask for it. Writing the child's field from the
 *      parent's form is exactly as valid as writing it from the child's.
 *
 * `ChildLinkEditor` does that write. The original text survives, but only for the
 * two cases where it is actually true: an unsaved parent (no id to link to yet)
 * and a relation whose inverse field cannot be identified unambiguously.
 *
 * ── CREATING INLINE MUST NOT COST YOU THE FORM ──────────────────────────────
 *
 * "Create a new one" opens a nested sheet over this field. The parent form's
 * state is untouched — losing half-typed work to add a missing category is
 * exactly the friction that makes people give up on a CMS.
 */

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_LIMIT = 20;
/**
 * How many children a `oneToMany` field lists inline.
 *
 * ⚠️ A CAP, NOT A PAGE — there is no "next" here. The field is one control inside
 * a record form, and a parent with 400 children is a job for the table view
 * filtered by the relation, not for a scrolling list inside a modal. The count
 * beside the heading says when the list is truncated, so it never silently reads
 * as "this is all of them".
 */
const CHILD_PAGE = 25;

export interface RecordLinkFieldProps {
    projectId: string;
    /** The table on the other side of the relation. */
    targetTable: DbTable;
    relation: RelationKind;
    /** Current value: an id, an expanded record, or an array of either. */
    value: unknown;
    disabled?: boolean;
    onChange: (next: unknown) => void;
    /** Opens the inline "create a linked record" flow. */
    onCreateNew?: () => void;

    /**
     * ── What a `oneToMany` needs, and nothing else does ──────────────────────
     *
     * All three are optional so the control still works anywhere it is dropped in
     * with the original four props; without them a `oneToMany` degrades to the
     * explanation it used to be rather than breaking.
     */
    /** The field being edited, used to find its half on the child table. */
    property?: DbProperty;
    /** The table this form is editing — the "one" side. */
    ownerTable?: DbTable;
    /**
     * The record being edited, or `null` while creating.
     *
     * ⚠️ `null` IS NOT AN OVERSIGHT, IT IS THE REASON THE HINT STILL EXISTS. A
     * child is linked by writing the PARENT'S ID onto it, and an unsaved parent
     * has no id — there is nothing to write. Children become linkable the moment
     * the record is saved once.
     */
    ownerRecordId?: string | null;
    /** A child was linked or unlinked — written immediately, so the list is stale. */
    onChildrenChanged?: () => void;
}

interface Candidate {
    id: string;
    label: string;
}

export function RecordLinkField({
    projectId,
    targetTable,
    relation,
    value,
    disabled,
    onChange,
    onCreateNew,
    property,
    ownerTable,
    ownerRecordId,
    onChildrenChanged,
}: RecordLinkFieldProps) {
    const t = useT();

    const multiple = relation === "manyToMany";
    const selectedIds = React.useMemo(() => linkedIdsOf(value), [value]);

    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const [candidates, setCandidates] = React.useState<Candidate[]>([]);
    const [loading, setLoading] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    /** Labels for ids we already hold, so chips are not bare ObjectIds. */
    const [labels, setLabels] = React.useState<Record<string, string>>({});

    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const runSearch = React.useCallback(
        async (term: string) => {
            setLoading(true);
            setFailed(false);

            // Search across the label-ish fields with an OR of regexes. Server-side,
            // because a table can hold far more rows than a browser should fetch.
            const searchable = Object.values(targetTable.properties || {})
                .filter(p => p.propertyType === "string" && p.name !== "_id")
                .slice(0, 6);

            const filter =
                term.trim() && searchable.length > 0
                    ? {
                          _or: searchable.map(p => ({
                              [p.name]: { regex: term.trim(), options: "i" },
                          })),
                      }
                    : {};

            const response = await vcaasApi.database.query(projectId, {
                tableName: targetTable.type,
                queryOptions: { _filter: filter, _limit: SEARCH_LIMIT, _sort: { createdAt: "desc" } },
            });

            if (!mounted.current) return;
            setLoading(false);

            if (!response.ok || !response.data) {
                setFailed(true);
                setCandidates([]);
                return;
            }

            const rows = (response.data.results || []) as Record<string, unknown>[];
            const mapped = rows.map(row => ({
                id: String(row._id ?? ""),
                label: labelForRecord(targetTable, row),
            }));

            setCandidates(mapped);
            setLabels(current => {
                const next = { ...current };
                for (const item of mapped) next[item.id] = item.label;
                return next;
            });
        },
        [projectId, targetTable]
    );

    /**
     * Ids we have already tried to resolve.
     *
     * ⚠️ IT IS "TRIED", NOT "RESOLVED", AND THE DIFFERENCE IS AN INFINITE REQUEST
     * LOOP. A dangling id — the linked record was deleted — never comes back from
     * the query, so a `!labels[id]` test alone stays true forever. `setLabels`
     * builds a fresh object on every call, so the effect re-runs, queries again,
     * and hammers the API for as long as the field is on screen. Recording the
     * ATTEMPT is what makes each id cost at most one request.
     */
    const resolveAttempted = React.useRef(new Set<string>());

    // Resolve labels for ids we hold but have never seen a record for.
    React.useEffect(() => {
        const unknown = selectedIds.filter(
            id => !labels[id] && !resolveAttempted.current.has(id)
        );
        if (unknown.length === 0) return;

        for (const id of unknown) resolveAttempted.current.add(id);

        let cancelled = false;
        void (async () => {
            const response = await vcaasApi.database.query(projectId, {
                tableName: targetTable.type,
                queryOptions: { _filter: { _id: { in: unknown } }, _limit: unknown.length },
            });
            if (cancelled || !mounted.current || !response.ok || !response.data) return;

            const rows = (response.data.results || []) as Record<string, unknown>[];
            setLabels(current => {
                const next = { ...current };
                for (const row of rows) next[String(row._id)] = labelForRecord(targetTable, row);
                return next;
            });
        })();

        return () => {
            cancelled = true;
        };
        // `labels` is deliberately not a dependency: adding it re-runs the effect
        // with every resolution and loops. (The lint rule no longer reports this
        // now that the hooks all run unconditionally, so the disable is gone too —
        // a stale directive is a comment that stops being checked.)
    }, [selectedIds, projectId, targetTable, labels]);

    // Debounced search while the picker is open.
    React.useEffect(() => {
        if (!open) return;
        const timer = setTimeout(() => void runSearch(search), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [open, search, runSearch]);

    function toggle(id: string) {
        if (multiple) {
            const next = selectedIds.includes(id)
                ? selectedIds.filter(current => current !== id)
                : [...selectedIds, id];
            onChange(next);
            return;
        }
        onChange(id);
        setOpen(false);
    }

    function clear() {
        onChange(multiple ? [] : null);
    }

    /**
     * ⚠️⚠️ THIS GUARD USED TO SIT ABOVE `runSearch` AND THE TWO EFFECTS, AND THAT
     * WAS A RULES-OF-HOOKS VIOLATION — three of them, flagged as errors by eslint.
     *
     * A `oneToMany` field returned after 8 hooks; every other relation ran 11. React
     * identifies hooks by CALL ORDER, so the moment one component instance rendered
     * both branches — a form re-rendered for a record whose relation resolves
     * differently, a table switched under an open modal — React would read the
     * wrong slot for every hook after the branch and throw "Rendered fewer hooks
     * than expected", taking the whole record form down with it.
     *
     * The fix is placement, not logic: every hook now runs unconditionally and the
     * early return happens at render time, where it belongs.
     *
     * ⚠️ THE BRANCH STILL RETURNS BEFORE THIS COMPONENT'S EDITOR, and it must. A
     * `oneToMany` is not a value on this record: setting it here would write to a
     * field that does not exist and be silently lost. What changed is where it
     * goes instead — a child editor that writes the CHILD, rather than a
     * paragraph of text.
     */
    if (relation === "oneToMany") {
        /**
         * ⚠️ RESOLVED AT RENDER, NOT IN A HOOK — see the block above. This is one
         * `find` over a schema already in memory; memoising it would mean another
         * hook that only one branch reaches, which is the exact bug that comment
         * exists to prevent.
         */
        const inverse = property ? inverseLinkPropertyOf(property, targetTable, ownerTable) : null;

        if (inverse && ownerRecordId) {
            return (
                <ChildLinkEditor
                    projectId={projectId}
                    childTable={targetTable}
                    inverseProperty={inverse}
                    parentId={ownerRecordId}
                    disabled={disabled}
                    onChanged={onChildrenChanged}
                />
            );
        }

        /**
         * The two cases the explanation is still TRUE for:
         *   · the parent has no id yet (creating) — say what unblocks it;
         *   · the inverse field is ambiguous — the original text, because from
         *     here the relation genuinely is read-only.
         */
        return (
            <p className="text-muted-foreground border-border bg-muted/30 rounded-lg border p-2.5 text-xs">
                {inverse
                    ? t("workspace.database.link.oneToManySaveFirst", {
                          table: labelForTable(targetTable),
                      })
                    : t("workspace.database.link.oneToManyHint", {
                          table: labelForTable(targetTable),
                      })}
            </p>
        );
    }

    return (
        <div className="space-y-1.5">
            {/* ── Current selection ─────────────────────────────────────── */}
            {selectedIds.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                    {selectedIds.map(id => (
                        <li
                            key={id}
                            className="border-border bg-muted/50 flex max-w-full items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 text-xs"
                        >
                            <LinkIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
                            <span className="min-w-0 truncate">{labels[id] || id}</span>
                            {!disabled && (
                                <button
                                    type="button"
                                    onClick={() => toggle(id)}
                                    className="hover:bg-background focus-visible:ring-ring rounded p-0.5 focus-visible:ring-2 focus-visible:outline-none"
                                    aria-label={t("workspace.database.link.unlinkOne", {
                                        record: labels[id] || id,
                                    })}
                                >
                                    <XIcon className="size-3" aria-hidden />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="text-muted-foreground text-xs">
                    {t("workspace.database.link.nothingLinked", { table: labelForTable(targetTable) })}
                </p>
            )}

            {/* ── Actions ───────────────────────────────────────────────── */}
            {!disabled && (
                <div className="flex flex-wrap gap-1.5">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => setOpen(current => !current)}
                        aria-expanded={open}
                    >
                        <SearchIcon className="size-3.5" aria-hidden />
                        {multiple
                            ? t("workspace.database.link.addExisting")
                            : t("workspace.database.link.chooseExisting")}
                    </Button>

                    {onCreateNew && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 gap-1.5 text-xs"
                            onClick={onCreateNew}
                        >
                            <PlusIcon className="size-3.5" aria-hidden />
                            {t("workspace.database.link.createNew", {
                                table: labelForTable(targetTable),
                            })}
                        </Button>
                    )}

                    {selectedIds.length > 0 && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground h-7 text-xs"
                            onClick={clear}
                        >
                            {t("workspace.database.link.clear")}
                        </Button>
                    )}
                </div>
            )}

            {/* ── Picker ────────────────────────────────────────────────── */}
            {open && !disabled && (
                <div className="border-border bg-card space-y-2 rounded-lg border p-2">
                    <Input
                        autoFocus
                        value={search}
                        onChange={event => setSearch(event.target.value)}
                        placeholder={t("workspace.database.link.searchPlaceholder", {
                            table: labelForTable(targetTable),
                        })}
                        className="h-7 text-xs"
                    />

                    {loading && (
                        <div className="grid place-items-center py-4">
                            <LoaderIcon className="text-muted-foreground size-4 animate-spin" aria-hidden />
                        </div>
                    )}

                    {!loading && failed && (
                        <div className="py-3 text-center">
                            <p className="text-muted-foreground text-xs">
                                {t("workspace.database.link.searchFailed")}
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-1.5 h-7 text-xs"
                                onClick={() => void runSearch(search)}
                            >
                                {t("common.retry")}
                            </Button>
                        </div>
                    )}

                    {!loading && !failed && candidates.length === 0 && (
                        <p className="text-muted-foreground py-3 text-center text-xs">
                            {search.trim()
                                ? t("workspace.database.link.noMatches")
                                : t("workspace.database.link.tableEmpty")}
                        </p>
                    )}

                    {!loading && !failed && candidates.length > 0 && (
                        <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                            {candidates.map(candidate => {
                                const selected = selectedIds.includes(candidate.id);
                                return (
                                    <li key={candidate.id}>
                                        <button
                                            type="button"
                                            onClick={() => toggle(candidate.id)}
                                            className={cn(
                                                "hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs focus-visible:ring-2 focus-visible:outline-none",
                                                selected && "bg-primary-subtle"
                                            )}
                                        >
                                            <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                                            {selected && (
                                                <CheckIcon className="text-primary size-3.5 shrink-0" aria-hidden />
                                            )}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * ═══ THE CHILDREN OF A `oneToMany`, EDITABLE FROM THE PARENT ════════════════
 *
 * The list of records whose back-reference points at this one, with a picker to
 * attach another and a button to detach each. Every write goes to the CHILD:
 *
 *   link   →  update(child, { [inverse]: parentId })
 *   unlink →  update(child, { [inverse]: null })
 *
 * ⚠️⚠️ THESE WRITES ARE IMMEDIATE, AND NOTHING ELSE IN THIS FORM IS. Every other
 * field is staged in React state and committed by Save; a child link cannot be,
 * because it is a write to a DIFFERENT record — staging it would mean Cancel
 * silently discarding changes to rows the form does not own, and Save having to
 * reconcile children against a parent that may not exist yet. So the panel says
 * so in one line rather than letting people discover it from a Cancel that did
 * not cancel.
 *
 * ⚠️⚠️ LINKING A CHILD THAT ALREADY HAS A PARENT MOVES IT — IT DOES NOT COPY IT.
 * The child holds ONE id, so writing ours overwrites theirs. That is a silent
 * edit to a record the user is not looking at, on a screen where the other rows
 * all look equally available, so a taken child is labelled in the picker and
 * confirmed before the write. Everything else about this control is undoable by
 * eye; this is the one thing that is not.
 */
function ChildLinkEditor({
    projectId,
    childTable,
    inverseProperty,
    parentId,
    disabled,
    onChanged,
}: {
    projectId: string;
    childTable: DbTable;
    /** The field ON THE CHILD that holds the parent's id. */
    inverseProperty: DbProperty;
    parentId: string;
    disabled?: boolean;
    onChanged?: () => void;
}) {
    const t = useT();

    const [children, setChildren] = React.useState<Record<string, unknown>[] | null>(null);
    const [loadFailed, setLoadFailed] = React.useState(false);

    const [open, setOpen] = React.useState(false);
    const [search, setSearch] = React.useState("");
    const [candidates, setCandidates] = React.useState<Record<string, unknown>[]>([]);
    const [searching, setSearching] = React.useState(false);
    const [searchFailed, setSearchFailed] = React.useState(false);

    /** The id being written right now, so one row can show a spinner. */
    const [busyId, setBusyId] = React.useState<string | null>(null);
    /** A candidate that belongs to somebody else, held for confirmation. */
    const [stealing, setStealing] = React.useState<Record<string, unknown> | null>(null);

    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const field = inverseProperty.name;

    const load = React.useCallback(async () => {
        const response = await vcaasApi.database.query(projectId, {
            tableName: childTable.type,
            queryOptions: {
                _filter: { [field]: parentId },
                _limit: CHILD_PAGE,
                _sort: { createdAt: "desc" },
            },
        });
        if (!mounted.current) return;

        if (!response.ok || !response.data) {
            setLoadFailed(true);
            setChildren([]);
            return;
        }
        setLoadFailed(false);
        setChildren((response.data.results || []) as Record<string, unknown>[]);
    }, [projectId, childTable.type, field, parentId]);

    React.useEffect(() => {
        void load();
    }, [load]);

    const runSearch = React.useCallback(
        async (term: string) => {
            setSearching(true);
            setSearchFailed(false);

            const searchable = Object.values(childTable.properties || {})
                .filter(p => p.propertyType === "string" && p.name !== "_id")
                .slice(0, 6);

            const filter =
                term.trim() && searchable.length > 0
                    ? { _or: searchable.map(p => ({ [p.name]: { regex: term.trim(), options: "i" } })) }
                    : {};

            const response = await vcaasApi.database.query(projectId, {
                tableName: childTable.type,
                queryOptions: { _filter: filter, _limit: SEARCH_LIMIT, _sort: { createdAt: "desc" } },
            });
            if (!mounted.current) return;
            setSearching(false);

            if (!response.ok || !response.data) {
                setSearchFailed(true);
                setCandidates([]);
                return;
            }
            setCandidates((response.data.results || []) as Record<string, unknown>[]);
        },
        [projectId, childTable]
    );

    React.useEffect(() => {
        if (!open) return;
        const timer = setTimeout(() => void runSearch(search), SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [open, search, runSearch]);

    /** Point a child's back-reference at us, or clear it. */
    async function write(childId: string, next: string | null) {
        setBusyId(childId);
        const response = await vcaasApi.database.updateRecord(projectId, childId, {
            tableName: childTable.type,
            data: { [field]: next },
        });
        if (!mounted.current) return;
        setBusyId(null);

        if (!response.ok) {
            toast.error(
                t(next ? "workspace.database.link.childLinkFailed" : "workspace.database.link.childUnlinkFailed"),
                { description: response.error || undefined }
            );
            return;
        }

        /*
          Reload rather than splice. The list is a QUERY (`where inverse = us`),
          not a local array, and a child that was moved here from another parent
          has to appear with the values it actually has, not the ones the picker
          happened to be showing.
        */
        await load();
        if (open) void runSearch(search);
        toast.success(
            t(next ? "workspace.database.link.childLinked" : "workspace.database.link.childUnlinked")
        );
        onChanged?.();
    }

    const linkedIds = new Set((children ?? []).map(row => String(row._id)));

    return (
        <div className="space-y-1.5">
            {/* ── Current children ──────────────────────────────────────── */}
            {children === null ? (
                <div className="grid place-items-center py-2">
                    <LoaderIcon className="text-muted-foreground size-4 animate-spin" aria-hidden />
                </div>
            ) : loadFailed ? (
                <p className="text-destructive text-xs">
                    {t("workspace.database.detail.loadFailed")}{" "}
                    <button type="button" onClick={() => void load()} className="underline">
                        {t("common.retry")}
                    </button>
                </p>
            ) : children.length === 0 ? (
                <p className="text-muted-foreground text-xs">
                    {t("workspace.database.link.nothingLinked", { table: labelForTable(childTable) })}
                </p>
            ) : (
                <ul className="flex flex-wrap gap-1.5">
                    {children.map(row => {
                        const id = String(row._id);
                        return (
                            <li
                                key={id}
                                className="border-border bg-muted/50 flex max-w-full items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 text-xs"
                            >
                                <LinkIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
                                <span className="min-w-0 truncate">{labelForRecord(childTable, row)}</span>
                                {!disabled && (
                                    <button
                                        type="button"
                                        disabled={busyId === id}
                                        onClick={() => void write(id, null)}
                                        className="hover:bg-background focus-visible:ring-ring rounded p-0.5 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
                                        aria-label={t("workspace.database.link.unlinkOne", {
                                            record: labelForRecord(childTable, row) || id,
                                        })}
                                    >
                                        {busyId === id ? (
                                            <LoaderIcon className="size-3 animate-spin" aria-hidden />
                                        ) : (
                                            <XIcon className="size-3" aria-hidden />
                                        )}
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {/* ⚠️ SAYS WHEN THE LIST IS CUT OFF. Silently showing the first 25 of
                80 reads as "this record has 25 children", and every decision made
                from that — including deciding a link is missing and adding it
                twice — is wrong. */}
            {children !== null && children.length >= CHILD_PAGE && (
                <p className="text-muted-foreground text-[11px]">
                    {t("workspace.database.link.childrenTruncated", {
                        count: CHILD_PAGE,
                        table: labelForTable(childTable),
                    })}
                </p>
            )}

            {/* ── Actions ───────────────────────────────────────────────── */}
            {!disabled && (
                <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-xs"
                        onClick={() => setOpen(current => !current)}
                        aria-expanded={open}
                    >
                        <SearchIcon className="size-3.5" aria-hidden />
                        {t("workspace.database.link.addExisting")}
                    </Button>
                </div>
            )}

            {/* ⚠️ SAID BEFORE THE FIRST CLICK, NOT AFTER. Every other field in this
                form waits for Save; these do not, because they are writes to
                another record. Finding that out from a Cancel that did not cancel
                is how a CMS loses somebody's trust. */}
            {!disabled && (
                <p className="text-muted-foreground text-[11px]">
                    {t("workspace.database.link.childWritesImmediately", {
                        field: inverseProperty.label || inverseProperty.name,
                        table: labelForTable(childTable),
                    })}
                </p>
            )}

            {/* ── Picker ────────────────────────────────────────────────── */}
            {open && !disabled && (
                <div className="border-border bg-card space-y-2 rounded-lg border p-2">
                    <Input
                        autoFocus
                        value={search}
                        onChange={event => setSearch(event.target.value)}
                        placeholder={t("workspace.database.link.searchPlaceholder", {
                            table: labelForTable(childTable),
                        })}
                        className="h-7 text-xs"
                    />

                    {searching && (
                        <div className="grid place-items-center py-4">
                            <LoaderIcon className="text-muted-foreground size-4 animate-spin" aria-hidden />
                        </div>
                    )}

                    {!searching && searchFailed && (
                        <div className="py-3 text-center">
                            <p className="text-muted-foreground text-xs">
                                {t("workspace.database.link.searchFailed")}
                            </p>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="mt-1.5 h-7 text-xs"
                                onClick={() => void runSearch(search)}
                            >
                                {t("common.retry")}
                            </Button>
                        </div>
                    )}

                    {!searching && !searchFailed && candidates.length === 0 && (
                        <p className="text-muted-foreground py-3 text-center text-xs">
                            {search.trim()
                                ? t("workspace.database.link.noMatches")
                                : t("workspace.database.link.tableEmpty")}
                        </p>
                    )}

                    {!searching && !searchFailed && candidates.length > 0 && (
                        <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                            {candidates.map(candidate => {
                                const id = String(candidate._id);
                                const selected = linkedIds.has(id);
                                /*
                                  ⚠️ THE CHILD'S CURRENT OWNER, READ OFF THE ROW.
                                  `linkedIdOf` because the field comes back as a
                                  bare id or as an expanded record depending on
                                  the query — comparing the raw value to `parentId`
                                  reports every expanded row as free.
                                */
                                const owner = linkedIdOf(candidate[field]);
                                const taken = Boolean(owner) && owner !== parentId;

                                return (
                                    <li key={id}>
                                        <button
                                            type="button"
                                            disabled={busyId === id}
                                            onClick={() => {
                                                if (selected) return void write(id, null);
                                                if (taken) return setStealing(candidate);
                                                void write(id, parentId);
                                            }}
                                            className={cn(
                                                "hover:bg-muted focus-visible:ring-ring flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50",
                                                selected && "bg-primary-subtle"
                                            )}
                                        >
                                            <span className="min-w-0 flex-1 truncate">
                                                {labelForRecord(childTable, candidate)}
                                            </span>
                                            {taken && !selected && (
                                                <span className="text-muted-foreground shrink-0 text-[10px]">
                                                    {t("workspace.database.link.alreadyLinked")}
                                                </span>
                                            )}
                                            {busyId === id ? (
                                                <LoaderIcon className="size-3.5 shrink-0 animate-spin" aria-hidden />
                                            ) : (
                                                selected && (
                                                    <CheckIcon className="text-primary size-3.5 shrink-0" aria-hidden />
                                                )
                                            )}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            )}

            {/* ⚠️ NOT `tone="danger"` AND NO TYPED PHRASE. Nothing is deleted and
                the move is undone by linking it back — the friction is there to
                make the consequence VISIBLE, not to make it hard. */}
            <ConfirmDialog
                open={stealing !== null}
                onOpenChange={next => setStealing(next ? stealing : null)}
                title={t("workspace.database.link.moveTitle")}
                description={t("workspace.database.link.moveBody", {
                    record: labelForRecord(childTable, stealing) || "—",
                    table: labelForTable(childTable),
                })}
                confirmLabel={t("workspace.database.link.moveConfirm")}
                onConfirm={async () => {
                    if (stealing) await write(String(stealing._id), parentId);
                }}
            />
        </div>
    );
}
