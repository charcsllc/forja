"use client";

import * as React from "react";
import {
    ArrowDownWideNarrowIcon,
    BracesIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    DatabaseIcon,
    FilterIcon,
    LoaderIcon,
    MaximizeIcon,
    PencilIcon,
    PlusIcon,
    RefreshCwIcon,
    SearchIcon,
    TableIcon,
    Trash2Icon,
    XIcon,
} from "lucide-react";
import {
    ConfirmDialog,
    CopyButton,
    EmptyState,
    ErrorState,
    Modal,
    SkeletonTable,
    StatusPill,
} from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useLocale, useT } from "@/i18n";
import type { Locale } from "@/i18n";
import {
    formatDate,
    formatDateTime,
    isIsoDateString,
    isoHasTime,
} from "@/lib/format";
import { hrefFor, linkKindOf, linkLabel, optionTint } from "@/lib/db-cell";
import { canPreviewFiles, previewFileColumns } from "@/lib/db-files";
import { toast } from "@/lib/toast";
import {
    buildLinkExpansion,
    buildQueryOptions,
    previewLinkProperties,
    editableProperties,
    editorKindFor,
    extractTotal,
    fromInputValue,
    jsonFieldError,
    PAGE_SIZE,
    PAGE_SIZE_OPTIONS,
    isPageSize,
    SYSTEM_FIELDS,
    toInputValue,
    type EditorKind,
} from "@/lib/totalum-query";
import { vcaasApi } from "@/lib/vcaas";
import {
    fieldKindOf,
    filesOf,
    isFileKind,
    isManyToMany,
    labelForRecord,
    labelForTable,
    linkedEntriesOf,
    linkedIdsOf,
    optionsOf,
    relationOf,
    resolveLinkedTable,
    storesIdOnRecord,
    type LinkedEntry,
    type RelationKind,
} from "@/lib/totalum-schema";
import {
    compileJoinFilter,
    countRules,
    emptyGroup,
    type JoinGroup,
} from "@/lib/join-filter";
import { FileField } from "./db/FileField";
import { FilePreviewStrip } from "./db/FilePreview";
import { JoinFilterBuilder } from "./db/JoinFilterBuilder";
import { LinkedRecordCell } from "./db/LinkedRecordCell";
import { RecordLinkField } from "./db/RecordLinkField";
import { RecordDetail } from "./db/RecordDetail";
import type { DbProperty, DbTable } from "@/lib/vcaas-types";
import { cn } from "@/lib/utils";

/**
 * THE DATABASE BROWSER.
 *
 * Reads and writes the generated app's own Totalum tables through
 * `…/database/{tables-structure,query,records}`.
 *
 * ── QUERYING IS SERVER-SIDE, ALWAYS ─────────────────────────────────────────
 *
 * Paging, sorting, filtering and search all go into `queryOptions` (see
 * `src/lib/totalum-query.ts`) rather than being applied to a fetched page. A
 * table with 50 000 rows must not be pulled into the browser to sort it, and a
 * client-side "sort" over one page would be misleading in exactly the way the
 * name-sort problem was.
 *
 * ── DELETES ARE CONFIRMED, AND NAME THE ROW ─────────────────────────────────
 *
 * This edits a user's real application data with no undo. The confirmation shows
 * the record's `_id` so it is possible to tell you are about to delete the row
 * you meant.
 *
 * ── THE RAW JSON VIEW IS A FIRST-CLASS SURFACE ──────────────────────────────
 *
 * The table view flattens nested objects to `{…}`. For a record with real
 * structure, JSON is the only honest rendering, so it is a toggle rather than a
 * debug afterthought.
 */

type View = "data" | "schema";

/** Per-browser, not per-account — the same trade the projects view/sort make. */
const PAGE_SIZE_KEY = "totalum:database:page-size";
const TABLE_SORT_KEY = "totalum:database:table-sort";

/**
 * A stand-in `DbProperty` for a column Totalum manages and the schema does not
 * describe. `propertyType: "date"` is what makes `Cell` format it rather than
 * print the ISO string — the whole reason these two columns can be shown at all.
 *
 * ⚠️ `includeHour` IS NOT DECORATION. `fieldKindOf` reads exactly that flag to
 * decide `date` vs `datetime`, and these two carry a real time — without it a row
 * created and updated ten minutes apart would show the same value twice.
 */
function SYSTEM_COLUMN(name: "createdAt" | "updatedAt"): DbProperty {
    return {
        name,
        label: name,
        propertyType: "date",
        id: name,
        typeExtras: { date: { includeHour: true } },
    } as unknown as DbProperty;
}

/** The human name of a column, falling back to the field name it is stored under. */
function columnLabel(property: DbProperty): string {
    return property.label?.trim() || property.name;
}

export interface DatabasePanelProps {
    projectId: string;
}

export function DatabasePanel({ projectId }: DatabasePanelProps) {
    const t = useT();
    const { locale } = useLocale();

    const [tables, setTables] = React.useState<DbTable[]>([]);
    const [selectedTable, setSelectedTable] = React.useState<string>("");
    const [view, setView] = React.useState<View>("data");

    const [tablesLoading, setTablesLoading] = React.useState(true);
    const [tablesError, setTablesError] = React.useState<string | null>(null);

    const [records, setRecords] = React.useState<Record<string, unknown>[]>([]);
    const [recordsLoading, setRecordsLoading] = React.useState(false);
    const [recordsError, setRecordsError] = React.useState<string | null>(null);
    const [total, setTotal] = React.useState<number | null>(null);
    const [page, setPage] = React.useState(1);

    /**
     * Rows per page. Persisted per browser, like the projects view/sort choices.
     *
     * ⚠️ CHANGING IT RESETS TO PAGE 1. Going from 25 to 100 while on page 4 would
     * ask for rows 300-400 of a result that now has three pages — an empty table
     * and a pager insisting there is more.
     */
    const [pageSize, setPageSize] = React.useState<number>(PAGE_SIZE);

    React.useEffect(() => {
        try {
            const stored = window.localStorage.getItem(PAGE_SIZE_KEY);
            if (stored && isPageSize(Number(stored))) setPageSize(Number(stored));
        } catch {
            // Private mode. The default is fine.
        }
    }, []);

    const changePageSize = React.useCallback((next: number) => {
        setPageSize(next);
        setPage(1);
        try {
            window.localStorage.setItem(PAGE_SIZE_KEY, String(next));
        } catch {
            /* ignore */
        }
    }, []);

    /**
     * ⚠️ ON A PHONE THE ASIDE AND THE TABLE SHARE THE WIDTH, so only one shows at
     * a time — the same trade `CodePanel` makes for its file tree, and for the
     * same measured reason: at 375px a 176px aside leaves 199px for the table,
     * which is one column of `_id` and nothing else. It opens on the LIST, because
     * "which table?" is the question you arrive with.
     */
    const [asideOpenOnMobile, setAsideOpenOnMobile] = React.useState(true);

    const [searchInput, setSearchInput] = React.useState("");
    const [search, setSearch] = React.useState("");
    const [sortField, setSortField] = React.useState("createdAt");
    const [sortDirection, setSortDirection] = React.useState<"asc" | "desc">("desc");
    const [showJson, setShowJson] = React.useState(false);

    /**
     * ⭐ FEATURE H3 — the visual join filter.
     *
     * ⚠️ TWO PIECES OF STATE, NOT ONE. `draftFilter` is what the builder edits;
     * `appliedFilter` is what the query uses. Re-querying on every keystroke would
     * fire a request per character and make a half-typed rule hide every row —
     * the count preview is the live feedback, "Apply" is the commit.
     */
    const [draftFilter, setDraftFilter] = React.useState<JoinGroup>(() => emptyGroup("and"));
    const [appliedFilter, setAppliedFilter] = React.useState<Record<string, unknown> | null>(null);
    const [filterOpen, setFilterOpen] = React.useState(false);
    const [matchCount, setMatchCount] = React.useState<number | null>(null);
    const [counting, setCounting] = React.useState(false);

    /** The record open in the CMS detail view, with the table it belongs to. */
    const [detail, setDetail] = React.useState<{ table: DbTable; record: Record<string, unknown> } | null>(null);
    /** A linked record being fetched because the grid only had its id. */
    const [detailLoading, setDetailLoading] = React.useState(false);

    /**
     * Tables whose relation expansion the API rejected — see `fetchRecords`.
     *
     * ⚠️ A REF, NOT STATE. Writing it during a fetch that a state change would
     * re-trigger is how you get an infinite pair of queries.
     */
    const expandFailed = React.useRef<Set<string>>(new Set());

    const [editing, setEditing] = React.useState<Record<string, unknown> | null>(null);
    const [creating, setCreating] = React.useState(false);
    const [deleting, setDeleting] = React.useState<Record<string, unknown> | null>(null);

    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const table = React.useMemo(
        () => tables.find(candidate => candidate.type === selectedTable),
        [tables, selectedTable]
    );

    // ── Tables ────────────────────────────────────────────────────────────
    const fetchTables = React.useCallback(async () => {
        setTablesLoading(true);
        setTablesError(null);

        const response = await vcaasApi.database.tablesStructure(projectId);
        if (!mounted.current) return;

        if (response.ok && response.data) {
            const list = response.data.tables || [];
            setTables(list);
            setSelectedTable(current => current || list[0]?.type || "");
        } else {
            setTablesError(response.error || t("workspace.database.tablesFailedDescription"));
        }
        setTablesLoading(false);
    }, [projectId, t]);

    React.useEffect(() => {
        void fetchTables();
    }, [fetchTables]);

    // Debounce the search box into an actual query.
    React.useEffect(() => {
        const timer = setTimeout(() => {
            setSearch(searchInput.trim());
            setPage(1);
        }, 350);
        return () => clearTimeout(timer);
    }, [searchInput]);

    // ── Records ───────────────────────────────────────────────────────────
    const fetchRecords = React.useCallback(async () => {
        if (!selectedTable) return;

        setRecordsLoading(true);
        setRecordsError(null);

        /**
         * ⭐ THE FIRST THREE RELATION COLUMNS ARE EXPANDED, so the grid can show
         * WHICH client an order belongs to instead of `6a6ce621…`. One query
         * either way — the alternative is a second round trip per relation column
         * to look the labels up, which is the N+1 the Totalum docs open with.
         */
        const expansion = expandFailed.current.has(selectedTable)
            ? null
            : buildLinkExpansion(previewLinkProperties(table));

        const run = (expand: Record<string, unknown> | null) =>
            vcaasApi.database.query(projectId, {
                tableName: selectedTable,
                queryOptions: buildQueryOptions({
                    page,
                    pageSize,
                    sortField,
                    sortDirection,
                    filters: [],
                    search,
                    table,
                    joinFilter: appliedFilter,
                    expand,
                }),
            });

        let response = await run(expansion);

        /**
         * ⚠️⚠️ AN EXPANSION THAT THE API REFUSES MUST NOT TAKE THE TABLE DOWN
         * WITH IT. Every non-`_` key in `queryOptions` is read as a relation to
         * expand, so a schema this panel misreads — a link whose field name is not
         * a valid expansion key, a relation type the backend will not join —
         * turns a working table into an error screen, and the user loses their
         * data view to gain a label.
         *
         * So the query is retried WITHOUT expansions, and the table is remembered
         * as one that cannot be expanded (a ref, not state: re-rendering on it
         * would re-run this effect and re-issue both queries). The relation
         * columns fall back to ids, which is what they showed before.
         */
        if (!response.ok && expansion && Object.keys(expansion).length > 0) {
            expandFailed.current.add(selectedTable);
            response = await run(null);
        }

        if (!mounted.current) return;

        if (response.ok && response.data) {
            const results = response.data.results || [];
            setRecords(results);
            setTotal(extractTotal(results, page, pageSize));
        } else {
            setRecordsError(response.error || t("workspace.database.recordsFailedDescription"));
            setRecords([]);
            setTotal(null);
        }
        setRecordsLoading(false);
    }, [projectId, selectedTable, page, pageSize, sortField, sortDirection, search, table, appliedFilter, t]);

    React.useEffect(() => {
        if (view === "data") void fetchRecords();
    }, [fetchRecords, view]);

    // Reset paging/sort when switching table — a sort field from another table
    // would produce an upstream error rather than an empty result.
    React.useEffect(() => {
        setPage(1);
        setSortField("createdAt");
        setSortDirection("desc");
        setSearchInput("");
        // A rule naming a field of the PREVIOUS table would error upstream rather
        // than return nothing, so the builder resets with the table.
        setDraftFilter(emptyGroup("and"));
        setAppliedFilter(null);
        setMatchCount(null);
        setDetail(null);
    }, [selectedTable]);

    /**
     * The live match count for the DRAFT filter.
     *
     * ⚠️ `_limit: 1` — we want the count, not the rows. Fetching a full page to
     * count it would triple the traffic of a builder that re-counts as you type.
     */
    React.useEffect(() => {
        if (!filterOpen || !selectedTable) return;

        const compiled = compileJoinFilter(draftFilter, tables, table);
        if (!compiled) {
            setMatchCount(null);
            return;
        }

        let cancelled = false;
        const timer = setTimeout(async () => {
            setCounting(true);
            const response = await vcaasApi.database.query(projectId, {
                tableName: selectedTable,
                queryOptions: { _filter: compiled, _limit: 1, _count: true },
            });
            if (cancelled || !mounted.current) return;
            setCounting(false);
            setMatchCount(
                response.ok && response.data ? extractTotal(response.data.results || [], 1) : null
            );
        }, 400);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [draftFilter, filterOpen, projectId, selectedTable, tables, table]);

    /**
     * ═══ THE COLUMNS ════════════════════════════════════════════════════════
     *
     * ⚠️ FILE COLUMNS ARE INCLUDED NOW. They were excluded outright, which meant a
     * table whose point was its attachments showed every column except the one
     * that mattered. `Cell` renders them as a name or a count — enough to see that
     * a row HAS a file, which is the question a list answers.
     *
     * ⚠️ `createdAt` / `updatedAt` ARE APPENDED, and are not in `table.properties`
     * — Totalum manages them, so they have no `DbProperty`. They are the default
     * sort of this panel and the first thing anyone scans a CMS for, so hiding
     * them while sorting by them was the odder of the two choices. They go LAST:
     * metadata belongs after the record's own fields.
     */
    const columns = React.useMemo(() => {
        if (!table) return [];

        const properties = Object.values(table.properties);
        const present = (name: string) => records.some(record => record[name] != null);

        return [
            // `_id` first — it is the row's identity and what deletes are keyed on.
            { name: "_id", label: "_id", propertyType: "string", id: "_id" } as DbProperty,
            ...properties,
            ...(present("createdAt") ? [SYSTEM_COLUMN("createdAt")] : []),
            ...(present("updatedAt") ? [SYSTEM_COLUMN("updatedAt")] : []),
        ];
    }, [table, records]);

    /**
     * ═══⭐ WHICH FILE COLUMNS SHOW THUMBNAILS ══════════════════════════════
     *
     * ⚠️ TWO BUDGETS, BOTH IN `@/lib/db-files`, AND NEITHER IS COSMETIC. A
     * thumbnail is a request for the ORIGINAL bytes behind a signed URL — there is
     * no resizing parameter to add — so a 100-row page of a table with six file
     * columns holding twenty files each is thousands of image requests for a
     * screenful of about fifteen rows.
     *
     *   · the FIRST THREE file columns only, in schema order. Ordering by "which
     *     ones have files on this page" would move the pictures to a different
     *     column as you page, which reads as a bug.
     *   · at most 50 rows on the page. Above that the page size is 100 and you are
     *     scanning ids, not looking at photographs; the columns fall back to the
     *     name-or-count text they rendered before.
     *
     * `Cell` still draws the first three files per cell and collapses the rest —
     * see `splitForPreview`.
     */
    const previewColumns = React.useMemo(() => {
        if (!table) return new Set<string>();
        return previewFileColumns(
            Object.values(table.properties)
                .filter(property => isFileKind(fieldKindOf(property)))
                .map(property => property.name)
        );
    }, [table]);

    const showFilePreviews = canPreviewFiles(records.length);

    /**
     * ═══⭐ WHICH RELATION COLUMNS SHOW A NAME INSTEAD OF AN ID ═════════════
     *
     * The same first-three rule, for the same reason — these are the columns
     * `fetchRecords` expands, and a column can only be labelled if its record
     * came back with the row. The value is the table on the OTHER side, which is
     * what `labelForRecord` needs to pick the record's best field.
     */
    const linkPreviewColumns = React.useMemo(() => {
        const map = new Map<string, DbTable | undefined>();
        for (const property of previewLinkProperties(table)) {
            map.set(property.name, resolveLinkedTable(tables, property));
        }
        return map;
    }, [table, tables]);

    /**
     * ⭐ OPEN THE RECORD ON THE OTHER SIDE OF A LINK.
     *
     * ⚠️ USUALLY THERE IS NOTHING TO FETCH — the grid query expanded the field, so
     * the whole record is already in hand and the modal opens instantly. The fetch
     * is the fallback for a value that arrived as a bare id (an unexpanded column,
     * or a table whose expansion the API refused), and it exists so that path
     * still opens something rather than a detail view of `{ _id }` alone.
     */
    const openLinkedRecord = React.useCallback(
        async (entry: LinkedEntry, target: DbTable | undefined) => {
            if (!target) return;

            // More than `_id` means it is a real expanded record, not our own stub.
            if (entry.record && Object.keys(entry.record).length > 1) {
                setDetail({ table: target, record: entry.record });
                return;
            }

            setDetailLoading(true);
            const response = await vcaasApi.database.query(projectId, {
                tableName: target.type,
                queryOptions: { _filter: { _id: entry.id }, _limit: 1 },
            });
            if (!mounted.current) return;
            setDetailLoading(false);

            const row = response.ok ? (response.data?.results || [])[0] : null;
            if (!row) {
                toast.error(t("workspace.database.detail.openFailed"), {
                    description: response.error || undefined,
                });
                return;
            }
            setDetail({ table: target, record: row as Record<string, unknown> });
        },
        [projectId, t]
    );

    const pageCount = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;
    const canPrev = page > 1;
    const canNext = pageCount !== null ? page < pageCount : records.length === pageSize;

    // ── Mutations ─────────────────────────────────────────────────────────
    async function handleDelete(record: Record<string, unknown>) {
        const id = String(record._id ?? "");
        const response = await vcaasApi.database.deleteRecord(projectId, id, selectedTable);

        if (!response.ok) {
            toast.error(t("workspace.database.deleteFailed"), { description: response.error || undefined });
            throw new Error(response.error || "delete failed");
        }

        toast.success(t("workspace.database.deleted"));
        await fetchRecords();
    }

    // ── Render ────────────────────────────────────────────────────────────
    if (tablesLoading) {
        return (
            <div className="bg-card h-full p-4">
                <SkeletonTable rows={8} />
            </div>
        );
    }

    if (tablesError) {
        return (
            <div className="grid h-full place-items-center p-6">
                <ErrorState
                    title={t("workspace.database.tablesFailed")}
                    description={t("workspace.database.tablesFailedDescription")}
                    detail={tablesError}
                    onRetry={() => void fetchTables()}
                    variant="panel"
                />
            </div>
        );
    }

    if (tables.length === 0) {
        return (
            <div className="grid h-full place-items-center p-6">
                <EmptyState
                    variant="panel"
                    icon={<DatabaseIcon />}
                    title={t("workspace.database.noTablesTitle")}
                    description={t("workspace.database.noTablesDescription")}
                    actions={
                        <Button variant="outline" size="sm" onClick={() => void fetchTables()}>
                            <RefreshCwIcon className="size-4" aria-hidden />
                            {t("common.refresh")}
                        </Button>
                    }
                />
            </div>
        );
    }

    return (
        <div className="bg-card flex h-full min-h-0">
            {/*
              ═══⭐ THE TABLES ASIDE — WAS A DROPDOWN ═══════════════════════════

              ⚠️ A `<select>` HIDES THE ONE THING THIS SCREEN IS ABOUT. A generated
              app has ten or twenty tables, and the dropdown meant you could not
              see what your database CONTAINED without opening a menu, could not
              search it, and could not tell a big table from an empty one. The
              aside makes the schema the furniture of the page: every table
              visible, searchable, and sortable by how much is in it.
            */}
            <TablesAside
                projectId={projectId}
                tables={tables}
                selected={selectedTable}
                onSelect={type => {
                    setSelectedTable(type);
                    setAsideOpenOnMobile(false);
                }}
                className={cn(
                    !asideOpenOnMobile && "hidden sm:flex",
                    asideOpenOnMobile && "w-full sm:w-52"
                )}
            />

            <div
                className={cn(
                    "flex min-h-0 min-w-0 flex-1 flex-col",
                    asideOpenOnMobile && "hidden sm:flex"
                )}
            >
            {/* ═══ TOOLBAR ═══════════════════════════════════════════ */}
            {/*
              ⚠️ ONE ROW, THREE GROUPS, IN FREQUENCY ORDER: what you are looking at
              (Data / Schema) · how you are narrowing it (filter, search) · what you
              do to it (JSON, refresh, new). Before, five controls of four different
              heights wrapped onto two rows and the table picker sat among them as
              if choosing a table were the same kind of act as pressing refresh.
            */}
            <div className="border-border/60 flex flex-wrap items-center gap-1.5 border-b px-2 py-1.5">
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 gap-1 px-1.5 sm:hidden"
                    onClick={() => setAsideOpenOnMobile(true)}
                >
                    <ChevronLeftIcon className="size-3.5" aria-hidden />
                    <span className="sr-only">{t("workspace.database.tableLabel")}</span>
                </Button>

                <div className="min-w-0">
                    <p className="font-display truncate text-sm font-semibold" title={table?.type}>
                        {labelForTable(table)}
                    </p>
                </div>

                {view === "data" && total !== null && (
                    <span
                        data-tabular
                        className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium"
                    >
                        {t(total === 1 ? "workspace.database.rowCount" : "workspace.database.rowCountPlural", {
                            count: total,
                        })}
                    </span>
                )}

                <span aria-hidden className="bg-border mx-0.5 h-5 w-px shrink-0" />

                {/* Data / Schema — a segmented pair, sized like everything else. */}
                <div className="bg-muted flex h-7 shrink-0 items-center gap-0.5 rounded-lg p-0.5">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setView("data")}
                        aria-pressed={view === "data"}
                        className={cn("h-6 gap-1.5 px-2 text-xs", view === "data" && "bg-card shadow-2xs")}
                    >
                        <TableIcon className="size-3.5" aria-hidden />
                        {t("workspace.database.viewData")}
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setView("schema")}
                        aria-pressed={view === "schema"}
                        className={cn("h-6 gap-1.5 px-2 text-xs", view === "schema" && "bg-card shadow-2xs")}
                    >
                        <BracesIcon className="size-3.5" aria-hidden />
                        {t("workspace.database.viewSchema")}
                    </Button>
                </div>

                {view === "data" && (
                    <>
                        <Button
                            variant={appliedFilter ? "default" : "outline"}
                            size="sm"
                            className="h-7 shrink-0 gap-1.5 px-2 text-xs"
                            onClick={() => setFilterOpen(current => !current)}
                            aria-expanded={filterOpen}
                        >
                            <FilterIcon className="size-3.5" aria-hidden />
                            <span className="hidden sm:inline">{t("workspace.database.filter.title")}</span>
                            {appliedFilter && (
                                <span className="bg-primary-foreground/25 rounded px-1 text-[10px] tabular-nums">
                                    {countRules(draftFilter)}
                                </span>
                            )}
                        </Button>

                        <div className="relative min-w-0 flex-1 sm:max-w-xs">
                            <SearchIcon
                                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
                                aria-hidden
                            />
                            <Input
                                value={searchInput}
                                onChange={event => setSearchInput(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === "Escape") setSearchInput("");
                                }}
                                placeholder={t("workspace.database.searchPlaceholder")}
                                aria-label={t("workspace.database.searchPlaceholder")}
                                className="h-7 pr-6 pl-7 text-xs"
                            />
                            {searchInput && (
                                <button
                                    type="button"
                                    onClick={() => setSearchInput("")}
                                    aria-label={t("pages.projects.searchClear")}
                                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 focus-visible:ring-2 focus-visible:outline-none"
                                >
                                    <XIcon className="size-3" aria-hidden />
                                </button>
                            )}
                        </div>

                        <div className="ml-auto flex shrink-0 items-center gap-0.5">
                            {/*
                              ⚠️ THE JSON TOGGLE IS AN ICON NOW. It was a labelled
                              button the same size as "New record", which put a
                              debugging view at the same weight as the primary
                              action on the screen. It is a lens on what is already
                              there — icon-sized, `aria-pressed`, named by its
                              tooltip.
                            */}
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className={cn("size-7", showJson && "bg-accent text-foreground")}
                                        onClick={() => setShowJson(value => !value)}
                                        aria-pressed={showJson}
                                        aria-label={t("workspace.database.jsonView")}
                                    >
                                        <BracesIcon className="size-3.5" aria-hidden />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t("workspace.database.jsonView")}</TooltipContent>
                            </Tooltip>

                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-7"
                                        onClick={() => void fetchRecords()}
                                        disabled={recordsLoading}
                                        aria-label={t("common.refresh")}
                                    >
                                        <RefreshCwIcon
                                            className={cn("size-3.5", recordsLoading && "animate-spin")}
                                            aria-hidden
                                        />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t("common.refresh")}</TooltipContent>
                            </Tooltip>

                            <Button size="sm" className="ml-1 h-7 gap-1.5 px-2" onClick={() => setCreating(true)}>
                                <PlusIcon className="size-3.5" aria-hidden />
                                <span className="hidden sm:inline">{t("workspace.database.newRecord")}</span>
                            </Button>
                        </div>
                    </>
                )}
            </div>

            {/*
              ═══⭐ THE PAGER, ON TOP ══════════════════════════════════════════

              ⚠️ IT IS THE SAME COMPONENT AS THE ONE AT THE FOOT, rendered twice
              rather than copied. Two hand-written pagers drift — one gains the page
              size, the other keeps a stale range — and a table that disagrees with
              itself about how many rows it has is worse than a table with one pager.

              On top because a 100-row page is a long way to scroll to reach "next",
              and because the rows-per-page control belongs where you decide how much
              to look at, not after you have looked.
            */}
            {view === "data" && !recordsLoading && !recordsError && records.length > 0 && (
                <Pager
                    page={page}
                    pageSize={pageSize}
                    total={total}
                    rowsOnPage={records.length}
                    canPrev={canPrev}
                    canNext={canNext}
                    onPage={setPage}
                    onPageSize={changePageSize}
                    className="border-border/60 border-b"
                />
            )}

            {/* ⭐ FEATURE H3 — the visual join filter, under the toolbar so the
                results it changes stay in view while it is open. */}
            {view === "data" && filterOpen && (
                <div className="border-border/60 border-b p-2">
                    <JoinFilterBuilder
                        tables={tables}
                        table={table}
                        root={draftFilter}
                        onChange={setDraftFilter}
                        matchCount={matchCount}
                        counting={counting}
                        onApply={() => {
                            setAppliedFilter(compileJoinFilter(draftFilter, tables, table));
                            setPage(1);
                        }}
                        onClear={() => {
                            setDraftFilter(emptyGroup("and"));
                            setAppliedFilter(null);
                            setMatchCount(null);
                            setPage(1);
                        }}
                    />
                </div>
            )}

            {/* ═══ BODY ══════════════════════════════════════════════ */}
            <div className="tp-scroll min-h-0 flex-1 overflow-auto">
                {view === "schema" ? (
                    <SchemaView table={table} tables={tables} />
                ) : recordsLoading ? (
                    <div className="p-4">
                        <SkeletonTable rows={8} />
                    </div>
                ) : recordsError ? (
                    <div className="grid h-full place-items-center p-6">
                        <ErrorState
                            variant="panel"
                            title={t("workspace.database.recordsFailed")}
                            description={t("workspace.database.recordsFailedDescription")}
                            detail={recordsError}
                            onRetry={() => void fetchRecords()}
                        />
                    </div>
                ) : records.length === 0 ? (
                    <div className="grid h-full place-items-center p-6">
                        <EmptyState
                            variant="panel"
                            icon={<DatabaseIcon />}
                            title={
                                search
                                    ? t("workspace.database.noMatchesTitle", { query: search })
                                    : t("workspace.database.emptyTitle")
                            }
                            description={
                                search
                                    ? t("workspace.database.noMatchesDescription")
                                    : t("workspace.database.emptyDescription")
                            }
                            actions={
                                search ? (
                                    <Button variant="outline" size="sm" onClick={() => setSearchInput("")}>
                                        {t("pages.projects.searchClear")}
                                    </Button>
                                ) : (
                                    <Button size="sm" onClick={() => setCreating(true)}>
                                        <PlusIcon className="size-4" aria-hidden />
                                        {t("workspace.database.newRecord")}
                                    </Button>
                                )
                            }
                        />
                    </div>
                ) : showJson ? (
                    <pre className="tp-scroll overflow-auto p-3 font-mono text-[11px] leading-relaxed">
                        {JSON.stringify(records, null, 2)}
                    </pre>
                ) : (
                    <table className="w-full border-collapse text-xs">
                        <thead className="bg-muted/60 sticky top-0 z-10">
                            <tr>
                                {columns.map(column => {
                                    const active = sortField === column.name;
                                    return (
                                        <th
                                            key={column.name}
                                            scope="col"
                                            aria-sort={
                                                active
                                                    ? sortDirection === "asc"
                                                        ? "ascending"
                                                        : "descending"
                                                    : "none"
                                            }
                                            className="border-border/60 border-b p-0 text-left font-medium"
                                        >
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    if (active) {
                                                        setSortDirection(d => (d === "asc" ? "desc" : "asc"));
                                                    } else {
                                                        setSortField(column.name);
                                                        setSortDirection("asc");
                                                    }
                                                    setPage(1);
                                                }}
                                                className="hover:bg-accent focus-visible:ring-ring group/th flex w-full items-center gap-1 px-2.5 py-2 text-left whitespace-nowrap focus-visible:ring-2 focus-visible:outline-none"
                                            >
                                                {/*
                                                  ⚠️ THE HUMAN LABEL, NOT THE FIELD
                                                  NAME. Every header was the raw
                                                  storage key in a mono font
                                                  (`customer_email`), which is the
                                                  developer's name for the column,
                                                  not the one the schema gives it.
                                                  The raw name stays on `title` —
                                                  it is what you need when writing
                                                  a filter, and nowhere else.
                                                */}
                                                <span title={column.name}>{columnLabel(column)}</span>
                                                {active && (
                                                    <span aria-hidden className="text-muted-foreground">
                                                        {sortDirection === "asc" ? "↑" : "↓"}
                                                    </span>
                                                )}
                                            </button>
                                        </th>
                                    );
                                })}
                                <th scope="col" className="border-border/60 w-20 border-b px-2.5 py-2 text-right">
                                    <span className="sr-only">{t("pages.projects.columnActions")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {records.map((record, index) => (
                                /**
                                 * ⭐ THE WHOLE ROW OPENS THE EDIT DIALOG.
                                 *
                                 * ⚠️ IT USED TO BE THE FIRST CELL ONLY, AND THAT CELL
                                 * IS THE `_id` — an opaque hex string that looks like
                                 * nothing you would click. So the way into a record was
                                 * a 24-character identifier that gave no sign it was a
                                 * target, and the rest of the row, which is what people
                                 * actually point at, did nothing.
                                 *
                                 * ⚠️ SELECTING TEXT MUST NOT OPEN IT. A click that ends
                                 * a selection is a read, not a navigation — copying an
                                 * id out of a cell would otherwise fling a dialog open
                                 * every time. Links, buttons and the actions column stop
                                 * propagation on their own.
                                 */
                                <tr
                                    key={String(record._id ?? index)}
                                    onClick={event => {
                                        if (!table) return;
                                        if (window.getSelection()?.toString()) return;
                                        if ((event.target as HTMLElement).closest("a,button")) return;
                                        setEditing(record);
                                    }}
                                    className="hover:bg-accent/40 border-border/40 cursor-pointer border-b"
                                >
                                    {columns.map(column => (
                                        <td key={column.name} className="max-w-64 truncate px-2.5 py-1.5 align-top">
                                            <Cell
                                                value={record[column.name]}
                                                property={column}
                                                locale={locale}
                                                previewFiles={
                                                    showFilePreviews && previewColumns.has(column.name)
                                                }
                                                previewLink={linkPreviewColumns.has(column.name)}
                                                linkTable={linkPreviewColumns.get(column.name)}
                                                onOpenLink={openLinkedRecord}
                                            />
                                        </td>
                                    ))}
                                    <td className="px-1.5 py-1 text-right whitespace-nowrap">
                                        {/*
                                          ⚠️ "OPEN" IS THE DETAIL VIEW, NOT THE EDITOR —
                                          the row itself now opens the editor. The detail
                                          is the other question a CMS gets asked: what is
                                          linked to this record? It stays reachable, and
                                          it is the only way to the related-records
                                          sections.
                                        */}
                                        {table && (
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="size-6"
                                                onClick={() => setDetail({ table, record })}
                                                aria-label={t("workspace.database.detail.open")}
                                            >
                                                <MaximizeIcon className="size-3" aria-hidden />
                                            </Button>
                                        )}
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="text-destructive size-6"
                                            onClick={() => setDeleting(record)}
                                            aria-label={t("workspace.database.deleteRecord")}
                                        >
                                            <Trash2Icon className="size-3" aria-hidden />
                                        </Button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>

            {/* ═══ PAGER (foot) ══════════════════════════════════════ */}
            {view === "data" && !recordsLoading && !recordsError && records.length > 0 && (
                <Pager
                    page={page}
                    pageSize={pageSize}
                    total={total}
                    rowsOnPage={records.length}
                    canPrev={canPrev}
                    canNext={canNext}
                    onPage={setPage}
                    onPageSize={changePageSize}
                    className="border-border/60 border-t"
                />
            )}

            {/* ═══ DIALOGS ═══════════════════════════════════════════ */}
            {/*
              ═══⭐ THE RECORD, OPENED ═════════════════════════════════════════

              ⚠️ THIS WAS BUILT AND NEVER RENDERED. `RecordDetail` was imported and
              the "Open" button in every row set the state that holds it, but
              nothing put it on screen — so the button did nothing, and the CMS
              half of this panel (a record's relations, from both directions) was
              unreachable. It is also what a linked record's name in the grid now
              opens: "which client is this?" is answered by showing the client.
            */}
            {(detail || detailLoading) && (
                <Modal
                    open
                    onOpenChange={open => {
                        if (open) return;
                        setDetail(null);
                        setDetailLoading(false);
                    }}
                    size="lg"
                    title={
                        detail
                            ? labelForRecord(detail.table, detail.record)
                            : t("workspace.database.detail.loading")
                    }
                    description={detail ? labelForTable(detail.table) : undefined}
                >
                    {detail ? (
                        <RecordDetail
                            projectId={projectId}
                            tables={tables}
                            table={detail.table}
                            record={detail.record}
                            /**
                             * ⚠️ EDITING A RECORD OF ANOTHER TABLE MOVES THE PANEL
                             * TO THAT TABLE FIRST. The form writes to
                             * `selectedTable`; opening it on a linked `client`
                             * while the panel is showing `order` would save the
                             * client's fields into the order table.
                             */
                            onEdit={() => {
                                const { table: target, record: row } = detail;
                                setDetail(null);
                                if (target.type !== selectedTable) setSelectedTable(target.type);
                                setEditing(row);
                            }}
                            onOpenRecord={(nextTable, nextRecord) =>
                                setDetail({ table: nextTable, record: nextRecord })
                            }
                            /*
                              ⚠️ THE NEW RECORD IS NOT PRE-LINKED. Creating from
                              here switches to the related table and opens a blank
                              form; the link is made in the form's own picker. Only
                              the form knows how to write a link for each relation
                              kind, and inventing a second path for it is how the
                              two drift apart.
                            */
                            onCreateRelated={view => {
                                setDetail(null);
                                if (view.table.type !== selectedTable) setSelectedTable(view.table.type);
                                setCreating(true);
                            }}
                            onChanged={() => void fetchRecords()}
                        />
                    ) : (
                        <div className="grid place-items-center py-10">
                            <LoaderIcon
                                className="text-muted-foreground size-5 animate-spin"
                                aria-hidden
                            />
                        </div>
                    )}
                </Modal>
            )}

            {(creating || editing) && (
                <RecordForm
                    projectId={projectId}
                    tableName={selectedTable}
                    table={table}
                    tables={tables}
                    record={editing}
                    onDelete={
                        editing
                            ? () => {
                                  /**
                                   * ⚠️ THE FORM CLOSES FIRST. Two stacked dialogs
                                   * fight over the focus trap, and the confirmation
                                   * ends up behind the form it was opened from —
                                   * looking like a click that did nothing.
                                   */
                                  const target = editing;
                                  setEditing(null);
                                  setDeleting(target);
                              }
                            : undefined
                    }
                    onClose={() => {
                        setCreating(false);
                        setEditing(null);
                    }}
                    onSaved={() => {
                        setCreating(false);
                        setEditing(null);
                        void fetchRecords();
                    }}
                    /* The form stays open — only the rows behind it are re-read. */
                    onChildrenChanged={() => void fetchRecords()}
                />
            )}

            <ConfirmDialog
                open={!!deleting}
                onOpenChange={open => {
                    if (!open) setDeleting(null);
                }}
                tone="danger"
                title={t("workspace.database.deleteTitle")}
                description={t("workspace.database.deleteDescription")}
                confirmLabel={t("workspace.database.deleteRecord")}
                onConfirm={async () => {
                    if (deleting) await handleDelete(deleting);
                }}
            >
                {/* Show WHICH row — an id makes a mis-click recoverable to notice. */}
                <p className="bg-muted text-muted-foreground rounded-md px-2 py-1.5 font-mono text-xs break-all">
                    {String(deleting?._id ?? "")}
                </p>
            </ConfirmDialog>
            </div>
        </div>
    );
}

// ──────────────────────────── Tables aside ─────────────────────────────────

type TableSort = "name" | "records";

/**
 * ═══⭐ EVERY TABLE, VISIBLE ═════════════════════════════════════════════════
 *
 * ── COUNTING ROWS IS THE ONLY EXPENSIVE PART, SO IT IS DONE ONCE AND LAZILY ──
 *
 * ⚠️ ONE QUERY PER TABLE, and there is no cheaper way: Totalum reports a count as
 * metadata on the first row of a result, so "how many rows" means asking for a
 * row. `_limit: 1` keeps each one tiny, they run in parallel, and the result is
 * cached for the life of the panel — a project with twenty tables costs twenty
 * one-row reads, once.
 *
 * ⚠️ THE COUNTS ARE NOT FETCHED UNTIL THEY ARE ASKED FOR. Sorting by size is the
 * only thing that needs every count, and most sessions never touch it; firing
 * twenty queries on mount for a number nobody reads would make opening the
 * Database tab measurably slower for everyone. Counts appear as they arrive.
 */
function TablesAside({
    projectId,
    tables,
    selected,
    onSelect,
    className,
}: {
    projectId: string;
    tables: DbTable[];
    selected: string;
    onSelect: (type: string) => void;
    className?: string;
}) {
    const t = useT();
    const [search, setSearch] = React.useState("");
    const [sort, setSort] = React.useState<TableSort>("name");
    const [counts, setCounts] = React.useState<Record<string, number>>({});
    const [counting, setCounting] = React.useState(false);

    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    React.useEffect(() => {
        try {
            const stored = window.localStorage.getItem(TABLE_SORT_KEY);
            if (stored === "name" || stored === "records") setSort(stored);
        } catch {
            /* private mode */
        }
    }, []);

    /** Ask every table how many rows it has. Only ever called once. */
    const loadCounts = React.useCallback(async () => {
        setCounting(true);

        const results = await Promise.all(
            tables.map(async candidate => {
                const response = await vcaasApi.database.query(projectId, {
                    tableName: candidate.type,
                    queryOptions: { _limit: 1, _count: true },
                });
                const rows = response.ok && response.data ? response.data.results || [] : [];
                return [candidate.type, extractTotal(rows, 1, 1) ?? 0] as const;
            })
        );

        if (!mounted.current) return;
        setCounts(Object.fromEntries(results));
        setCounting(false);
    }, [projectId, tables]);

    function chooseSort(next: TableSort) {
        setSort(next);
        try {
            window.localStorage.setItem(TABLE_SORT_KEY, next);
        } catch {
            /* ignore */
        }
        // ⚠️ Sorting by size is what makes the counts worth fetching — and the
        // only thing that does. Ask for them the moment it is chosen, never before.
        if (next === "records" && Object.keys(counts).length === 0 && !counting) {
            void loadCounts();
        }
    }

    const visible = React.useMemo(() => {
        const query = search.trim().toLowerCase();

        const matched = query
            ? tables.filter(
                  candidate =>
                      candidate.type.toLowerCase().includes(query) ||
                      (candidate.label || "").toLowerCase().includes(query)
              )
            : tables.slice();

        return matched.sort((a, b) => {
            if (sort === "records") {
                // ⚠️ Descending, and an un-counted table sorts as -1 rather than 0
                // so "not counted yet" never claims to be an empty table.
                const left = counts[a.type] ?? -1;
                const right = counts[b.type] ?? -1;
                if (left !== right) return right - left;
            }
            return labelForTable(a).localeCompare(labelForTable(b));
        });
    }, [tables, search, sort, counts]);

    return (
        <aside
            className={cn(
                "border-border/60 flex w-52 shrink-0 flex-col border-r max-lg:w-44",
                className
            )}
        >
            <div className="border-border/60 space-y-1.5 border-b p-2">
                <div className="relative">
                    <SearchIcon
                        className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
                        aria-hidden
                    />
                    <Input
                        value={search}
                        onChange={event => setSearch(event.target.value)}
                        onKeyDown={event => {
                            if (event.key === "Escape") setSearch("");
                        }}
                        placeholder={t("workspace.database.searchTables")}
                        aria-label={t("workspace.database.searchTables")}
                        className="h-7 pr-6 pl-7 text-xs"
                    />
                    {search && (
                        <button
                            type="button"
                            onClick={() => setSearch("")}
                            aria-label={t("pages.projects.searchClear")}
                            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 focus-visible:ring-2 focus-visible:outline-none"
                        >
                            <XIcon className="size-3" aria-hidden />
                        </button>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    <SortChip active={sort === "name"} onClick={() => chooseSort("name")}>
                        {t("workspace.database.sortByName")}
                    </SortChip>
                    <SortChip active={sort === "records"} onClick={() => chooseSort("records")}>
                        {counting ? (
                            <LoaderIcon className="size-3 animate-spin" aria-hidden />
                        ) : (
                            <ArrowDownWideNarrowIcon className="size-3" aria-hidden />
                        )}
                        {t("workspace.database.sortByRecords")}
                    </SortChip>
                </div>
            </div>

            <ul className="tp-scroll min-h-0 flex-1 overflow-y-auto p-1">
                {visible.map(candidate => {
                    const count = counts[candidate.type];
                    const active = candidate.type === selected;

                    return (
                        <li key={candidate.type}>
                            <button
                                type="button"
                                onClick={() => onSelect(candidate.type)}
                                aria-current={active}
                                className={cn(
                                    "focus-visible:ring-ring flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none",
                                    active ? "bg-primary-subtle text-primary-subtle-foreground" : "hover:bg-accent"
                                )}
                            >
                                <TableIcon
                                    className={cn(
                                        "size-3.5 shrink-0",
                                        active ? "text-primary" : "text-muted-foreground"
                                    )}
                                    aria-hidden
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-medium">
                                        {labelForTable(candidate)}
                                    </span>
                                    {candidate.label && candidate.label !== candidate.type && (
                                        <span className="text-muted-foreground block truncate font-mono text-[10px]">
                                            {candidate.type}
                                        </span>
                                    )}
                                </span>
                                {count !== undefined && (
                                    <span
                                        data-tabular
                                        className="text-muted-foreground shrink-0 text-[10px]"
                                    >
                                        {count}
                                    </span>
                                )}
                            </button>
                        </li>
                    );
                })}

                {visible.length === 0 && (
                    <p className="text-muted-foreground p-3 text-center text-xs">
                        {t("workspace.database.noTableMatches")}
                    </p>
                )}
            </ul>
        </aside>
    );
}

function SortChip({
    active,
    onClick,
    children,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                "focus-visible:ring-ring flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none",
                active ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
            )}
        >
            {children}
        </button>
    );
}

// ─────────────────────────────── Pager ─────────────────────────────────────

/**
 * The pager, rendered at the top AND the foot of the table.
 *
 * ⚠️ ONE COMPONENT, TWO PLACES. Two hand-written pagers drift — one gains the
 * rows-per-page control, the other keeps computing its range from the old
 * constant — and a table that disagrees with itself about how many rows it has
 * is worse than a table with one pager.
 */
function Pager({
    page,
    pageSize,
    total,
    rowsOnPage,
    canPrev,
    canNext,
    onPage,
    onPageSize,
    className,
}: {
    page: number;
    pageSize: number;
    total: number | null;
    rowsOnPage: number;
    canPrev: boolean;
    canNext: boolean;
    onPage: (next: number | ((current: number) => number)) => void;
    onPageSize: (next: number) => void;
    className?: string;
}) {
    const t = useT();
    const pageCount = total !== null ? Math.max(1, Math.ceil(total / pageSize)) : null;

    return (
        <div className={cn("flex items-center justify-between gap-2 px-2 py-1.5", className)}>
            <div className="flex min-w-0 items-center gap-2">
                <p data-tabular className="text-muted-foreground truncate text-[11px]">
                    {total !== null
                        ? t("workspace.database.showingCount", {
                              from: (page - 1) * pageSize + 1,
                              to: (page - 1) * pageSize + rowsOnPage,
                              total,
                          })
                        : t("workspace.database.showingPage", { page })}
                </p>
            </div>

            <div className="flex shrink-0 items-center gap-1">
                {/* Rows per page. `sr-only` label rather than a visible one — the
                    values say what they are, and the row has no width to spare. */}
                <label htmlFor="db-page-size" className="sr-only">
                    {t("workspace.database.rowsPerPage")}
                </label>
                <Select
                    value={String(pageSize)}
                    onValueChange={value => onPageSize(Number(value))}
                >
                    <SelectTrigger
                        id="db-page-size"
                        size="sm"
                        aria-label={t("workspace.database.rowsPerPage")}
                        className="h-7 w-auto gap-1 px-2 text-[11px]"
                    >
                        <span data-tabular>{pageSize}</span>
                    </SelectTrigger>
                    <SelectContent align="end">
                        {PAGE_SIZE_OPTIONS.map(option => (
                            <SelectItem key={option} value={String(option)}>
                                {t("workspace.database.rowsPerPageOption", { count: option })}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <div className="bg-card ml-1 flex h-7 items-center rounded-md border p-0.5">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        disabled={!canPrev}
                        onClick={() => onPage(current => Math.max(1, current - 1))}
                        aria-label={t("common.previous")}
                    >
                        <ChevronLeftIcon className="size-3.5" aria-hidden />
                    </Button>
                    <span data-tabular className="text-muted-foreground px-1.5 text-[11px] whitespace-nowrap">
                        {pageCount !== null
                            ? t("pages.projects.pageOf", { page, total: pageCount })
                            : page}
                    </span>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        disabled={!canNext}
                        onClick={() => onPage(current => current + 1)}
                        aria-label={t("common.next")}
                    >
                        <ChevronRightIcon className="size-3.5" aria-hidden />
                    </Button>
                </div>
            </div>
        </div>
    );
}

// ─────────────────────────────── Cell ──────────────────────────────────────

/**
 * ═══ ONE CELL, TYPED BY THE SCHEMA ══════════════════════════════════════════
 *
 * ⚠️ THIS USED TO BE `String(value)` IN A MONO FONT, AND THAT WAS THE DATE BUG.
 * Every column rendered its raw stored form, so a date column read
 * `2026-03-15T14:32:11.842Z`, a reference read `{…}`, an options field read like
 * a string and a number sat left-aligned among words. The table was a JSON dump
 * with borders.
 *
 * The fix is to give the cell the SAME thing every other part of this panel
 * already has — the column's `DbProperty` — and render by `fieldKindOf()`:
 *
 *   date · datetime   → the user's locale, tabular, with the exact value on hover
 *   number            → tabular and right-aligned, so columns of figures line up
 *   boolean           → a yes/no pill, not the literal `true`
 *   options           → the value as a pill, one per entry
 *   tableLink         → "3 linked" / the linked id, never `{…}`
 *   file              → a file count, since the bytes are not in this response
 *   _id               → mono, because it IS an opaque identifier
 *   everything else   → plain text in the body font
 *
 * ⚠️ THE ISO FALLBACK IS NOT REDUNDANT. `createdAt` / `updatedAt` are appended by
 * Totalum and have no `DbProperty`, so without `isIsoDateString` the two columns
 * a CMS user looks at most would be the only ones still showing raw ISO.
 */
function Cell({
    value,
    property,
    locale,
    previewFiles = false,
    previewLink = false,
    linkTable,
    onOpenLink,
}: {
    value: unknown;
    /** The column's schema entry. Absent for `_id`, `createdAt`, `updatedAt`. */
    property?: DbProperty;
    locale: Locale;
    /**
     * ⭐ Draw this file column as thumbnails rather than as text. Decided by the
     * panel, not here: it depends on how many rows are on the page and on how many
     * file columns the table has — neither of which a cell can see.
     */
    previewFiles?: boolean;
    /** ⭐ Draw this relation column as the linked record's name, not its id. */
    previewLink?: boolean;
    /** The table on the other side of a previewed relation. */
    linkTable?: DbTable;
    onOpenLink?: (entry: LinkedEntry, table: DbTable | undefined) => void;
}) {
    const t = useT();

    if (value === null || value === undefined || value === "") {
        return <span className="text-muted-foreground/50 italic">{t("workspace.database.nullValue")}</span>;
    }

    const kind = property ? fieldKindOf(property) : null;

    if (typeof value === "boolean" || kind === "boolean") {
        const on = value === true || value === "true";
        return (
            <StatusPill tone={on ? "success" : "neutral"}>
                {t(on ? "common.yes" : "common.no")}
            </StatusPill>
        );
    }

    // ── Dates ─────────────────────────────────────────────────────────────
    if (kind === "date" || kind === "datetime" || isIsoDateString(value)) {
        const raw = String(value);
        // The schema decides whether a time exists; for a schema-less system
        // column the string itself does.
        const withTime = kind === "datetime" || (kind === null && isoHasTime(raw));
        const text = withTime ? formatDateTime(raw, locale) : formatDate(raw, locale);
        if (text) {
            // `title` keeps the exact stored value one hover away — this is a
            // database browser, and the ISO string is sometimes the answer.
            return (
                <span data-tabular className="whitespace-nowrap" title={raw}>
                    {text}
                </span>
            );
        }
    }

    if (kind === "tableLink") {
        /**
         * ⭐ THE RECORD IT POINTS AT, NOT THE ID IT STORES.
         *
         * ⚠️ THE OLD RENDERING IS STILL THE FALLBACK for the fourth relation
         * column onwards — those are not expanded, so there is no record to name
         * and printing "3 linked" is the honest thing. See `linkPreviewColumns`.
         */
        if (previewLink) {
            return (
                <LinkedRecordCell
                    entries={linkedEntriesOf(value)}
                    table={linkTable}
                    onOpen={
                        onOpenLink && linkTable
                            ? entry => onOpenLink(entry, linkTable)
                            : undefined
                    }
                />
            );
        }

        const ids = linkedIdsOf(value);
        if (ids.length === 0) {
            return <span className="text-muted-foreground/50 italic">{t("workspace.database.nullValue")}</span>;
        }
        return (
            <span className="text-muted-foreground truncate">
                {ids.length === 1 ? (
                    <span className="font-mono text-[11px]">{ids[0]}</span>
                ) : (
                    t("workspace.database.linkedCount", { count: ids.length })
                )}
            </span>
        );
    }

    if (kind === "file" || kind === "multipleFile") {
        const files = filesOf(value);
        if (files.length === 0) {
            return <span className="text-muted-foreground/50 italic">{t("workspace.database.nullValue")}</span>;
        }

        /**
         * ⭐ THE ATTACHMENT, NOT ITS FILENAME.
         *
         * ⚠️ THE OLD TEXT IS STILL THE FALLBACK, and deliberately: on a 100-row
         * page, or in the fourth file column of a table that has five, thumbnails
         * are a worse trade than a count (see `previewFiles` above). A file column
         * never goes back to showing nothing.
         */
        if (previewFiles) {
            return (
                <FilePreviewStrip
                    files={files}
                    size="sm"
                    label={property ? columnLabel(property) : undefined}
                />
            );
        }

        return (
            <span className="text-muted-foreground truncate">
                {files.length === 1 ? files[0].name : t("workspace.database.fileCount", { count: files.length })}
            </span>
        );
    }

    if (kind === "options" || kind === "multipleOptions") {
        const options = Array.isArray(value) ? value : [value];
        return (
            <span className="flex flex-wrap gap-1">
                {options.map((option, index) => (
                    <OptionBadge key={`${String(option)}-${index}`} value={String(option)} />
                ))}
            </span>
        );
    }

    if (typeof value === "number" || kind === "number") {
        return <span data-tabular className="block text-right">{String(value)}</span>;
    }

    if (typeof value === "object") {
        // Nested structure cannot be shown honestly in a cell — the JSON view is
        // the place for it.
        return (
            <span className="text-muted-foreground font-mono">
                {Array.isArray(value) ? `[${value.length}]` : "{…}"}
            </span>
        );
    }

    // `_id` is an opaque identifier and reads as one in mono. Ordinary text is
    // text, and was needlessly monospaced before.
    if (property?.name === "_id") {
        return <span className="font-mono text-[11px]">{String(value)}</span>;
    }

    /**
     * ⭐ A URL OR AN EMAIL IS SOMETHING YOU DO SOMETHING WITH.
     *
     * ⚠️ `relative z-10` AND `stopPropagation` — the whole ROW opens the record
     * now, so without both, clicking a customer's email address would open the
     * edit dialog instead of the mail client. The link has to be the one thing in
     * the row that is not the row.
     */
    const link = hrefFor(String(value));
    if (link) {
        const text = String(value);
        return (
            <a
                href={link}
                target={linkKindOf(text) === "url" ? "_blank" : undefined}
                rel="noopener noreferrer"
                title={text}
                onClick={event => event.stopPropagation()}
                className="text-primary relative z-10 truncate hover:underline"
            >
                {linkLabel(text)}
            </a>
        );
    }

    return <span className="truncate">{String(value)}</span>;
}

/**
 * One option value as a coloured badge.
 *
 * ⚠️ THE COLOUR COMES FROM THE VALUE (see `optionTint`), so `pending` is the same
 * colour in every row, on every page and after a reorder of the column's declared
 * options. A per-row or per-index palette would make the colour decorative; this
 * makes it something you can scan a column by.
 */
function OptionBadge({ value }: { value: string }) {
    return (
        <span
            className={cn(
                "text-2xs inline-flex max-w-full items-center rounded-full px-2 py-0.5 font-medium whitespace-nowrap",
                optionTint(value)
            )}
        >
            <span className="truncate">{value}</span>
        </span>
    );
}

// ─────────────────────────────── Schema ────────────────────────────────────

function SchemaView({ table, tables }: { table: DbTable | undefined; tables: DbTable[] }) {
    const t = useT();
    if (!table) return null;

    const properties = Object.values(table.properties);

    return (
        <div className="p-3">
            <div className="mb-3">
                <h3 className="font-display text-sm font-semibold">{table.label || table.type}</h3>
                {table.description && (
                    <p className="text-muted-foreground mt-0.5 text-xs">{table.description}</p>
                )}
            </div>

            <ul className="space-y-1">
                {properties.map(property => (
                    <li
                        key={property.name}
                        className="border-border/60 flex flex-wrap items-center gap-2 rounded-md border p-2 text-xs"
                    >
                        <code className="font-mono font-medium">{property.name}</code>
                        <StatusPill tone="outline">{property.propertyType}</StatusPill>
                        {SYSTEM_FIELDS.has(property.name) && (
                            <StatusPill tone="neutral">{t("workspace.database.systemField")}</StatusPill>
                        )}
                        {/*
                          ⭐ FEATURE H3 — THIS LINE WAS DEAD. It read
                          `objectReference.tableTo`, a field the API has never
                          sent, so the link target was never shown for ANY
                          relation. The real shape is
                          `{ objectReferenceTypeId, objectReferenceRelation }`,
                          where the id is the target table's `_id` — which is why
                          it needs the full table list to resolve into a name.
                        */}
                        {property.propertyType === "objectReference" && (
                            <span className="text-muted-foreground font-mono">
                                → {labelForTable(resolveLinkedTable(tables, property)) || "?"}
                                {relationOf(property) ? ` (${relationOf(property)})` : ""}
                            </span>
                        )}
                        {property.label && property.label !== property.name && (
                            <span className="text-muted-foreground ml-auto">{property.label}</span>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

// ─────────────────────────────── Record form ───────────────────────────────

function RecordForm({
    projectId,
    tableName,
    table,
    tables,
    record,
    onClose,
    onSaved,
    onCreateLinked,
    onChildrenChanged,
    onDelete,
}: {
    projectId: string;
    tableName: string;
    table: DbTable | undefined;
    tables: DbTable[];
    record: Record<string, unknown> | null;
    onClose: () => void;
    /**
     * Open a nested form to create the record on the other side of a link.
     * ⚠️ The parent form's state is NOT unmounted — losing half-typed work to
     * add a missing category is exactly the friction that kills a CMS.
     */
    onCreateLinked?: (target: DbTable, propertyName: string, relation: RelationKind) => void;
    onSaved: () => void;
    /**
     * ⭐ A `oneToMany` CHILD WAS LINKED OR UNLINKED WHILE THE FORM IS STILL OPEN.
     *
     * ⚠️ NOT `onSaved`. That one closes the form, and closing a form somebody is
     * halfway through typing because they attached a child is exactly the data
     * loss this whole nested-editing design exists to avoid. This only asks the
     * panel to re-read the rows behind the modal.
     */
    onChildrenChanged?: () => void;
    /**
     * ⭐ Delete the record being edited. Absent when creating — there is nothing
     * to delete yet, and a Delete button on a blank form is a trap.
     */
    onDelete?: () => void;
}) {
    const t = useT();
    const properties = React.useMemo(() => editableProperties(table), [table]);
    const isEdit = !!record;

    const [values, setValues] = React.useState<Record<string, string>>(() => {
        const initial: Record<string, string> = {};
        for (const property of properties) {
            initial[property.name] = toInputValue(record?.[property.name], editorKindFor(property));
        }
        return initial;
    });

    /**
     * ⭐ FEATURE H3 — file and tableLink values are NOT strings, so they cannot
     * live in `values`. A file is `{ name }` (or a list of them) and a link is an
     * id or a list of ids; round-tripping either through a text input would
     * destroy it. They are held here and merged at submit.
     */
    const [richValues, setRichValues] = React.useState<Record<string, unknown>>(() => {
        const initial: Record<string, unknown> = {};
        for (const property of properties) {
            const kind = fieldKindOf(property);
            if (isFileKind(kind) || kind === "tableLink") {
                initial[property.name] = record?.[property.name] ?? null;
            }
        }
        return initial;
    });
    /**
     * ⚠️⚠️ THE LINKS THE RECORD HAD WHEN THE FORM OPENED — THIS IS WHAT MADE
     * "EDIT THE REFERENCES" NOT WORK.
     *
     * A `manyToMany` link lives in a junction table Totalum owns, so saving it is
     * not a field write: it is add-reference and drop-reference calls. The submit
     * handler only ever ADDED — it looped over whatever was selected and called
     * `linkRecord` for each. So:
     *
     *   · removing a link in the picker did nothing at all. The chip disappeared,
     *     the save reported success, and the link was still there on reload;
     *   · every save re-linked rows that were already linked.
     *
     * Fixing it needs the BEFORE state, which is only knowable at mount — after
     * the first edit the picker holds the after state and the difference is gone.
     * `useRef` rather than `useState`: it is never rendered and must never trigger
     * one, and it must not be recomputed when `richValues` changes underneath it.
     */
    const initialLinks = React.useRef<Record<string, string[]>>(
        (() => {
            const initial: Record<string, string[]> = {};
            for (const property of properties) {
                if (fieldKindOf(property) !== "tableLink") continue;
                if (!isManyToMany(relationOf(property))) continue;
                initial[property.name] = linkedIdsOf(record?.[property.name]);
            }
            return initial;
        })()
    );

    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    // Any JSON field that no longer parses blocks submit — a typo here would
    // otherwise be stored as a string and quietly corrupt the record.
    const invalidJsonFields = properties.filter(property =>
        jsonFieldError(values[property.name] ?? "", editorKindFor(property))
    );

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault();
        if (invalidJsonFields.length > 0) return;

        setSaving(true);
        setError(null);

        const data: Record<string, unknown> = {};
        /** many-to-many links, applied AFTER the record exists (see below). */
        const manyToManyLinks: { property: string; ids: string[] }[] = [];

        for (const property of properties) {
            const kind = fieldKindOf(property);

            if (isFileKind(kind)) {
                const files = richValues[property.name];
                /**
                 * ⚠️ ONLY `{ name }` IS WRITTEN. The read shape carries a SIGNED,
                 * EXPIRING `url`; persisting it would store a dead link.
                 */
                const stripped = filesOf(files).map(file => ({ name: file.name }));
                data[property.name] = kind === "multipleFile" ? stripped : (stripped[0] ?? null);
                continue;
            }

            if (kind === "tableLink") {
                const relation = relationOf(property);

                if (isManyToMany(relation)) {
                    /**
                     * ⚠️ A MANY-TO-MANY LINK IS NOT A FIELD. Totalum owns the
                     * junction table, so writing ids into `data` would create a
                     * property that does not exist and silently lose the links.
                     * They are applied with the link endpoint once we have an id.
                     */
                    manyToManyLinks.push({
                        property: property.name,
                        ids: linkedIdsOf(richValues[property.name]),
                    });
                    continue;
                }

                if (storesIdOnRecord(relation)) {
                    const ids = linkedIdsOf(richValues[property.name]);
                    data[property.name] = ids[0] ?? null;
                }
                // `oneToMany` stores nothing on this record — deliberately skipped.
                continue;
            }

            const parsed = fromInputValue(values[property.name] ?? "", editorKindFor(property));
            // `undefined` = left blank = omit, rather than writing an empty string.
            if (parsed !== undefined) data[property.name] = parsed;
        }

        const response = isEdit
            ? await vcaasApi.database.updateRecord(projectId, String(record!._id), { tableName, data })
            : await vcaasApi.database.createRecord(projectId, { tableName, data });

        if (!response.ok) {
            setSaving(false);
            setError(response.error || t("common.unexpectedError"));
            return;
        }

        /**
         * Many-to-many links, now that the record certainly has an id.
         *
         * ⚠️ A FAILED LINK DOES NOT FAIL THE SAVE. The record is already stored;
         * reporting "could not save" at this point would be a lie and would push
         * the user into creating a duplicate. The link failure is surfaced on its
         * own so they can retry just that part.
         */
        const savedId =
            String(record?._id ?? "") ||
            String((response.data as Record<string, unknown> | undefined)?._id ?? "");

        if (savedId) {
            for (const link of manyToManyLinks) {
                const before = initialLinks.current[link.property] ?? [];
                const after = link.ids;

                /**
                 * ⚠️ A DIFF, NOT A REPLAY. Re-linking an id that is already linked
                 * is at best a wasted request and at worst a duplicate junction
                 * row, and — the actual bug — an id the user REMOVED needs a drop,
                 * which never happened. Both directions are applied here.
                 */
                const added = after.filter(id => !before.includes(id));
                const removed = before.filter(id => !after.includes(id));

                for (const referenceId of added) {
                    const linked = await vcaasApi.database.linkRecord(projectId, savedId, {
                        tableName,
                        propertyId: link.property,
                        referenceId,
                    });
                    if (!linked.ok) {
                        toast.error(t("workspace.database.linkFailed"), {
                            description: linked.error || undefined,
                        });
                    }
                }

                for (const referenceId of removed) {
                    const unlinked = await vcaasApi.database.unlinkRecord(projectId, savedId, {
                        tableName,
                        propertyId: link.property,
                        referenceId,
                    });
                    if (!unlinked.ok) {
                        toast.error(t("workspace.database.unlinkFailed"), {
                            description: unlinked.error || undefined,
                        });
                    }
                }

                // The record now IS the after state — a second save in the same
                // session must diff against this, not against the original.
                initialLinks.current[link.property] = after;
            }
        }

        setSaving(false);
        toast.success(isEdit ? t("workspace.database.updated") : t("workspace.database.created"));
        onSaved();
    }

    return (
        <Modal
            open
            onOpenChange={open => {
                if (!open && !saving) onClose();
            }}
            title={isEdit ? t("workspace.database.editTitle") : t("workspace.database.createTitle")}
            description={t("workspace.database.formDescription", { table: table?.label || tableName })}
        >
            <form onSubmit={handleSubmit} className="space-y-3">
                {/*
                  ═══⭐ THE RECORD'S ID, ALWAYS VISIBLE WHILE EDITING ═══════════

                  ⚠️ IT IS THE ONE VALUE THE FORM CANNOT SHOW AS A FIELD — `_id` is
                  a system field, so `editableProperties` excludes it, and the
                  moment the grid started showing linked records by NAME the id
                  stopped being on screen anywhere at all. It is what you paste
                  into a filter, an API call or a support message.

                  ⚠️ QUIET, NOT HIDDEN. Muted, mono, one line above the fields,
                  with a copy button — it must never compete with the data, and it
                  must never be something you have to go and look for.
                */}
                {isEdit && (
                    <div className="border-border/60 bg-muted/30 flex items-center gap-1.5 rounded-md border px-2 py-1">
                        <span className="text-muted-foreground shrink-0 text-[11px]">
                            {t("workspace.database.detail.recordId")}
                        </span>
                        <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
                            {String(record?._id ?? "")}
                        </code>
                        <CopyButton
                            value={String(record?._id ?? "")}
                            size="icon"
                            className="size-6 shrink-0"
                        />
                    </div>
                )}

                {properties.length === 0 && (
                    <p className="text-muted-foreground text-sm">{t("workspace.database.noEditableFields")}</p>
                )}

                {properties.map(property => {
                    const fieldKind = fieldKindOf(property);

                    // ⭐ FEATURE H3 — files and links get real controls, not a text box.
                    if (isFileKind(fieldKind)) {
                        return (
                            <div key={property.name} className="space-y-1.5">
                                <Label className="flex items-center gap-1.5 text-xs">
                                    <span className="font-mono">{property.name}</span>
                                    <span className="text-muted-foreground">
                                        ({fieldKind === "multipleFile" ? "multipleFile" : "file"})
                                    </span>
                                </Label>
                                <FileField
                                    projectId={projectId}
                                    value={richValues[property.name]}
                                    multiple={fieldKind === "multipleFile"}
                                    onChange={next =>
                                        setRichValues(current => ({ ...current, [property.name]: next }))
                                    }
                                />
                            </div>
                        );
                    }

                    if (fieldKind === "tableLink") {
                        const target = resolveLinkedTable(tables, property);
                        const relation = relationOf(property);
                        if (!target || !relation) return null;

                        return (
                            <div key={property.name} className="space-y-1.5">
                                <Label className="flex items-center gap-1.5 text-xs">
                                    <span className="font-mono">{property.name}</span>
                                    <span className="text-muted-foreground">
                                        (→ {labelForTable(target)})
                                    </span>
                                </Label>
                                <RecordLinkField
                                    projectId={projectId}
                                    targetTable={target}
                                    relation={relation}
                                    value={richValues[property.name]}
                                    onChange={next =>
                                        setRichValues(current => ({ ...current, [property.name]: next }))
                                    }
                                    /**
                                     * ⭐ WHAT MAKES A `oneToMany` EDITABLE FROM HERE.
                                     * The id lives on the child, so the control needs
                                     * to know which field on which table to write, and
                                     * which record to write into it — none of which is
                                     * derivable from the value, because there is no
                                     * value on this side.
                                     *
                                     * ⚠️ `record?._id`, NOT A FLAG. While creating there
                                     * is no id, and the control says "save this first"
                                     * rather than offering a link it cannot make.
                                     */
                                    property={property}
                                    ownerTable={table}
                                    ownerRecordId={record ? String(record._id ?? "") || null : null}
                                    /*
                                      Children are written immediately and independently
                                      of this form, so the table underneath is already
                                      stale — refresh it without closing the form.
                                    */
                                    onChildrenChanged={onChildrenChanged}
                                    onCreateNew={
                                        onCreateLinked
                                            ? () => onCreateLinked(target, property.name, relation)
                                            : undefined
                                    }
                                />
                            </div>
                        );
                    }

                    const kind = editorKindFor(property);
                    const invalid = jsonFieldError(values[property.name] ?? "", kind);

                    return (
                        <div key={property.name} className="space-y-1.5">
                            <Label htmlFor={`field-${property.name}`} className="flex items-center gap-1.5 text-xs">
                                <span className="font-mono">{property.name}</span>
                                <span className="text-muted-foreground">({property.propertyType})</span>
                            </Label>

                            <FieldInput
                                id={`field-${property.name}`}
                                kind={kind}
                                property={property}
                                value={values[property.name] ?? ""}
                                invalid={invalid}
                                onChange={next => setValues(current => ({ ...current, [property.name]: next }))}
                            />

                            {invalid && (
                                <p className="text-destructive text-xs">{t("workspace.database.invalidJson")}</p>
                            )}
                            {property.description && (
                                <p className="text-muted-foreground text-xs">{property.description}</p>
                            )}
                        </div>
                    );
                })}

                {error && (
                    <p
                        role="alert"
                        className="border-destructive/40 bg-destructive-subtle text-destructive-subtle-foreground rounded-lg border p-2.5 text-xs"
                    >
                        {error}
                    </p>
                )}

                <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end">
                    {/*
                      ⭐ DELETE, FROM THE RECORD YOU HAVE OPEN.
                      ⚠️ `sm:mr-auto` — hard against the OPPOSITE end from Save. A
                      destructive action beside the confirming one is how a
                      mis-click destroys a row; the distance is the guard, and the
                      typed-free confirmation dialog behind it is the other one.
                    */}
                    {onDelete && (
                        <Button
                            type="button"
                            variant="ghost"
                            className="text-destructive hover:bg-destructive-subtle hover:text-destructive-subtle-foreground sm:mr-auto"
                            disabled={saving}
                            onClick={onDelete}
                        >
                            <Trash2Icon className="size-4" aria-hidden />
                            {t("common.delete")}
                        </Button>
                    )}

                    <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
                        {t("common.cancel")}
                    </Button>
                    <Button type="submit" disabled={saving || invalidJsonFields.length > 0}>
                        {saving && <LoaderIcon className="size-4 animate-spin" aria-hidden />}
                        {saving ? t("common.saving") : t("common.save")}
                    </Button>
                </div>
            </form>
        </Modal>
    );
}

/** The input for one property, chosen from its declared type. */
function FieldInput({
    id,
    kind,
    property,
    value,
    invalid,
    onChange,
}: {
    id: string;
    kind: EditorKind;
    property: DbProperty;
    value: string;
    invalid: boolean;
    onChange: (value: string) => void;
}) {
    const t = useT();
    const common = {
        id,
        value,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
            onChange(event.target.value),
        "aria-invalid": invalid,
    };

    if (kind === "boolean") {
        return (
            <Select value={value || "false"} onValueChange={onChange}>
                <SelectTrigger id={id} size="sm">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                </SelectContent>
            </Select>
        );
    }

    if (kind === "textarea" || kind === "json") {
        return (
            <Textarea
                {...common}
                rows={kind === "json" ? 4 : 3}
                spellCheck={kind !== "json"}
                className={cn("text-xs", kind === "json" && "font-mono", invalid && "border-destructive")}
                placeholder={kind === "json" ? "{ }" : undefined}
            />
        );
    }

    /**
     * ⭐ AN OPTIONS FIELD IS A TEXT BOX WITH SUGGESTIONS, NOT A SELECT.
     *
     * ⚠️ THE FREE TEXT IS THE POINT, AND A `<select>` WOULD TAKE IT AWAY. Totalum
     * does not enforce the declared list — a record can legitimately hold a value
     * that is not in it (data imported before the column was tightened, a value the
     * agent wrote), and a dropdown would silently rewrite it to the nearest legal
     * choice on the next save. `<datalist>` gives the same one-click convenience
     * while leaving the field exactly as typeable as it was.
     *
     * ⚠️ NATIVE `<datalist>`, NOT A CUSTOM POPOVER. It is keyboard- and
     * screen-reader-correct in every browser for free, it does not fight the
     * modal's focus trap, and it cannot end up rendered behind the dialog — three
     * bugs a hand-rolled combobox inside a `Dialog` reliably produces.
     */
    const options = optionsOf(property);
    const listId = options.length > 0 ? `${id}-options` : undefined;

    return (
        <>
            <Input
                {...common}
                list={listId}
                type={kind === "number" ? "number" : kind === "date" ? "date" : kind === "datetime" ? "datetime-local" : "text"}
                className={cn("h-8 text-xs", kind === "reference" && "font-mono")}
                placeholder={
                    kind === "reference" ? t("workspace.database.referencePlaceholder") : property.label || undefined
                }
            />
            {listId && (
                <datalist id={listId}>
                    {options.map(option => (
                        <option key={option.id || option.value} value={option.value} />
                    ))}
                </datalist>
            )}
        </>
    );
}
