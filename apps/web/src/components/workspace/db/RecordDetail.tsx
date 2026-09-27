"use client";

import * as React from "react";
import {
    ExternalLinkIcon,
    LinkIcon,
    LoaderIcon,
    PencilIcon,
    PlusIcon,
    Unlink2Icon,
} from "lucide-react";
import { ConfirmDialog, ErrorState, StatusPill } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { useLocale, useT } from "@/i18n";
import { hrefFor, linkKindOf, linkLabel, optionTint } from "@/lib/db-cell";
import { formatDate, formatDateTime, isIsoDateString, isoHasTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { vcaasApi } from "@/lib/vcaas";
import {
    fieldKindOf,
    filesOf,
    labelForRecord,
    labelForTable,
    linkedIdsOf,
    relatedViewsFor,
    scalarFieldsOf,
    SYSTEM_FIELDS,
    type RelatedView,
} from "@/lib/totalum-schema";
import type { DbTable } from "@/lib/vcaas-types";
import { cn } from "@/lib/utils";
import { FilePreviewStrip } from "./FilePreview";

/**
 * ═══ RECORD DETAIL — THE CMS VIEW (Feature H3) ══════════════════════════════
 *
 * A record's own fields AND its related records **from every direction**, inline.
 *
 * ⚠️ "FROM EVERY DIRECTION" IS THE WHOLE POINT. A `client` may declare no link
 * fields at all and still be the parent of a hundred `order` rows, because it is
 * `order` that declares `client_id`. Showing only the fields this table declares
 * would hide exactly the relationships a CMS exists to manage. `relatedViewsFor`
 * walks both sides.
 *
 * ⚠️ RELATED RECORDS ARE FETCHED LAZILY, PER SECTION. A record with eight
 * relations would otherwise fire eight queries on open, most of which nobody
 * looks at. Each section loads when it is first expanded.
 *
 * ── UNLINK IS NOT DELETE, AND THE COPY SAYS SO ──────────────────────────────
 *
 * Unlinking a `manyToMany` drops a junction row; unlinking a `manyToOne` clears a
 * field. Neither deletes the record on the other side, and the confirmation makes
 * that explicit — "remove the link" is a very different act from "delete the
 * order", and a CMS that blurs them loses data.
 */

const RELATED_PAGE = 10;

export interface RecordDetailProps {
    projectId: string;
    tables: DbTable[];
    table: DbTable;
    record: Record<string, unknown>;
    onEdit: () => void;
    /** Open another record (a related one) in this same detail view. */
    onOpenRecord: (table: DbTable, record: Record<string, unknown>) => void;
    /** Create a new record in `table`, pre-linked to this one where possible. */
    onCreateRelated: (view: RelatedView) => void;
    /** Something changed upstream — the parent should re-read. */
    onChanged: () => void;
}

export function RecordDetail({
    projectId,
    tables,
    table,
    record,
    onEdit,
    onOpenRecord,
    onCreateRelated,
    onChanged,
}: RecordDetailProps) {
    const t = useT();

    const views = React.useMemo(() => relatedViewsFor(tables, table), [tables, table]);
    const fields = React.useMemo(() => scalarFieldsOf(table), [table]);
    const recordId = String(record._id ?? "");

    return (
        <div className="space-y-4">
            {/* ── Header ────────────────────────────────────────────────── */}
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h3 className="font-display truncate text-sm font-semibold">
                        {labelForRecord(table, record)}
                    </h3>
                    <code className="text-muted-foreground font-mono text-[11px]">{recordId}</code>
                </div>
                <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={onEdit}>
                    <PencilIcon className="size-3.5" aria-hidden />
                    {t("workspace.database.edit")}
                </Button>
            </div>

            {/* ── Fields ────────────────────────────────────────────────── */}
            <section>
                <h4 className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wide uppercase">
                    {t("workspace.database.detail.fields")}
                </h4>
                <dl className="divide-border/60 divide-y">
                    {fields.map(property => (
                        <div key={property.name} className="grid grid-cols-3 gap-2 py-1.5">
                            <dt className="text-muted-foreground truncate text-xs" title={property.label || property.name}>
                                {property.label || property.name}
                            </dt>
                            <dd className="col-span-2 min-w-0 text-xs">
                                <FieldValue property={property} value={record[property.name]} />
                            </dd>
                        </div>
                    ))}
                    {fields.length === 0 && (
                        <p className="text-muted-foreground py-2 text-xs">
                            {t("workspace.database.detail.noFields")}
                        </p>
                    )}
                </dl>
            </section>

            {/* ── Related records, every direction ──────────────────────── */}
            {views.length > 0 && (
                <section className="space-y-2">
                    <h4 className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                        {t("workspace.database.detail.related")}
                    </h4>
                    {views.map(view => (
                        <RelatedSection
                            key={`${view.table.type}:${view.expandKey}`}
                            projectId={projectId}
                            parentTable={table}
                            parentRecord={record}
                            view={view}
                            onOpenRecord={onOpenRecord}
                            onCreate={() => onCreateRelated(view)}
                            onChanged={onChanged}
                        />
                    ))}
                </section>
            )}
        </div>
    );
}

/** One collapsible relation, loading its rows the first time it opens. */
function RelatedSection({
    projectId,
    parentTable,
    parentRecord,
    view,
    onOpenRecord,
    onCreate,
    onChanged,
}: {
    projectId: string;
    parentTable: DbTable;
    parentRecord: Record<string, unknown>;
    view: RelatedView;
    onOpenRecord: (table: DbTable, record: Record<string, unknown>) => void;
    onCreate: () => void;
    onChanged: () => void;
}) {
    const t = useT();

    const [open, setOpen] = React.useState(false);
    const [rows, setRows] = React.useState<Record<string, unknown>[] | null>(null);
    const [loading, setLoading] = React.useState(false);
    const [failed, setFailed] = React.useState(false);
    const [unlinking, setUnlinking] = React.useState<Record<string, unknown> | null>(null);

    const parentId = String(parentRecord._id ?? "");
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    /**
     * Which records are on the other side?
     *
     * ⚠️ THE QUERY DEPENDS ON WHICH SIDE HOLDS THE ID — this is where getting the
     * relation direction wrong produces a silently empty list:
     *
     *  · the OTHER table declares the link (`foreignProperty`) → filter that table
     *    by `<field> = parentId`;
     *  · WE declare it and hold ids (`manyToOne`/`manyToMany`) → fetch by `_id in
     *    [...]` from our own field value.
     */
    const load = React.useCallback(async () => {
        setLoading(true);
        setFailed(false);

        let queryOptions: Record<string, unknown> | null = null;
        let tableName = view.table.type;

        if (view.foreignProperty) {
            queryOptions = {
                _filter: { [view.foreignProperty.name]: parentId },
                _limit: RELATED_PAGE,
                _sort: { createdAt: "desc" },
            };
        } else if (view.ownProperty) {
            const ids = linkedIdsOf(parentRecord[view.ownProperty.name]);
            if (ids.length === 0) {
                setRows([]);
                setLoading(false);
                return;
            }
            queryOptions = { _filter: { _id: { in: ids } }, _limit: RELATED_PAGE };
        }

        if (!queryOptions) {
            setRows([]);
            setLoading(false);
            return;
        }

        const response = await vcaasApi.database.query(projectId, { tableName, queryOptions });
        if (!mounted.current) return;
        setLoading(false);

        if (!response.ok || !response.data) {
            setFailed(true);
            return;
        }
        setRows((response.data.results || []) as Record<string, unknown>[]);
    }, [projectId, view, parentId, parentRecord]);

    React.useEffect(() => {
        if (open && rows === null && !loading) void load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    async function unlink(row: Record<string, unknown>) {
        const rowId = String(row._id ?? "");

        /**
         * ⚠️ THREE DIFFERENT WRITES, ONE BUTTON. Using the wrong one silently
         * does nothing:
         *  · manyToMany → the drop-reference endpoint (Totalum owns the junction);
         *  · the other side holds the id → clear THAT record's field;
         *  · we hold the id → clear OUR field.
         */
        let response;

        if (view.relation === "manyToMany" && (view.ownProperty || view.foreignProperty)) {
            const property = view.ownProperty ?? view.foreignProperty!;
            response = await vcaasApi.database.unlinkRecord(projectId, parentId, {
                tableName: parentTable.type,
                propertyId: property.name,
                referenceId: rowId,
            });
        } else if (view.foreignProperty) {
            response = await vcaasApi.database.updateRecord(projectId, rowId, {
                tableName: view.table.type,
                data: { [view.foreignProperty.name]: null },
            });
        } else if (view.ownProperty) {
            const remaining = linkedIdsOf(parentRecord[view.ownProperty.name]).filter(id => id !== rowId);
            response = await vcaasApi.database.updateRecord(projectId, parentId, {
                tableName: parentTable.type,
                data: { [view.ownProperty.name]: remaining.length > 0 ? remaining : null },
            });
        }

        setUnlinking(null);

        if (!response?.ok) {
            toast.error(t("workspace.database.detail.unlinkFailed"), {
                description: response?.error || undefined,
            });
            return;
        }

        // Optimistic: drop it locally, then let the parent re-read the truth.
        setRows(current => (current ? current.filter(item => String(item._id) !== rowId) : current));
        toast.success(t("workspace.database.detail.unlinked"));
        onChanged();
    }

    return (
        <div className="border-border rounded-lg border">
            <button
                type="button"
                onClick={() => setOpen(current => !current)}
                aria-expanded={open}
                className="hover:bg-muted/40 focus-visible:ring-ring flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left focus-visible:ring-2 focus-visible:outline-none"
            >
                <LinkIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {labelForTable(view.table)}
                </span>
                <StatusPill tone="outline">{t(`workspace.database.relation.${view.relation}` as never)}</StatusPill>
                <span className="text-muted-foreground text-[11px]">{open ? "−" : "+"}</span>
            </button>

            {open && (
                <div className="border-border/60 space-y-1.5 border-t p-2">
                    {loading && (
                        <div className="grid place-items-center py-3">
                            <LoaderIcon className="text-muted-foreground size-4 animate-spin" aria-hidden />
                        </div>
                    )}

                    {!loading && failed && (
                        <ErrorState
                            variant="panel"
                            description={t("workspace.database.detail.loadFailed")}
                            onRetry={() => void load()}
                        />
                    )}

                    {!loading && !failed && rows?.length === 0 && (
                        <p className="text-muted-foreground py-2 text-center text-xs">
                            {t("workspace.database.detail.noRelated", {
                                table: labelForTable(view.table),
                            })}
                        </p>
                    )}

                    {!loading && !failed && rows && rows.length > 0 && (
                        <ul className="space-y-0.5">
                            {rows.map(row => (
                                <li
                                    key={String(row._id)}
                                    className="hover:bg-muted/40 flex items-center gap-1.5 rounded px-1.5 py-1"
                                >
                                    <button
                                        type="button"
                                        onClick={() => onOpenRecord(view.table, row)}
                                        className="focus-visible:ring-ring min-w-0 flex-1 truncate rounded text-left text-xs hover:underline focus-visible:ring-2 focus-visible:outline-none"
                                    >
                                        {labelForRecord(view.table, row)}
                                    </button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-6 shrink-0"
                                        onClick={() => onOpenRecord(view.table, row)}
                                        aria-label={t("workspace.database.detail.open")}
                                    >
                                        <ExternalLinkIcon className="size-3" aria-hidden />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="text-muted-foreground hover:text-destructive size-6 shrink-0"
                                        onClick={() => setUnlinking(row)}
                                        aria-label={t("workspace.database.detail.unlink")}
                                    >
                                        <Unlink2Icon className="size-3" aria-hidden />
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}

                    {!loading && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 gap-1 text-[11px]"
                            onClick={onCreate}
                        >
                            <PlusIcon className="size-3" aria-hidden />
                            {t("workspace.database.detail.addRelated", {
                                table: labelForTable(view.table),
                            })}
                        </Button>
                    )}
                </div>
            )}

            <ConfirmDialog
                open={unlinking !== null}
                onOpenChange={open => setUnlinking(open ? unlinking : null)}
                tone="danger"
                title={t("workspace.database.detail.unlinkTitle")}
                /* ⚠️ Says explicitly that the record is NOT deleted. */
                description={t("workspace.database.detail.unlinkBody", {
                    table: labelForTable(view.table),
                })}
                confirmLabel={t("workspace.database.detail.unlink")}
                onConfirm={async () => {
                    if (unlinking) await unlink(unlinking);
                }}
            />
        </div>
    );
}

/** One field's value, rendered for its kind. */
function FieldValue({
    property,
    value,
}: {
    property: { name: string; label: string; propertyType: string; typeExtras?: Record<string, unknown> | null };
    value: unknown;
}) {
    const t = useT();
    const { locale } = useLocale();
    const kind = fieldKindOf(property as never);

    if (value === null || value === undefined || value === "") {
        return <span className="text-muted-foreground/60">—</span>;
    }

    /**
     * ⭐ THE FIRST THREE FILES, THEN A `+X` INTO THE GALLERY.
     *
     * ⚠️ IT USED TO DRAW EVERY FILE IN THE FIELD, at 40px each, with documents
     * rendered as a bare filename rather than as anything you could recognise. A
     * record with sixty photographs made this section the whole screen and fired
     * sixty requests for full-size originals. Three is what a detail view needs to
     * answer "what is attached here?"; the rest are one click away.
     */
    if (kind === "file" || kind === "multipleFile") {
        const files = filesOf(value);
        if (files.length === 0) return <span className="text-muted-foreground/60">—</span>;

        return <FilePreviewStrip files={files} size="md" label={property.label || property.name} />;
    }

    /*
      ⚠️ THE SAME COLOURS AS THE TABLE, from the same function. A `pending` badge
      that is amber in the grid and grey in the detail teaches the user that the
      colour means nothing.
    */
    if (kind === "multipleOptions" && Array.isArray(value)) {
        return (
            <span className="flex flex-wrap gap-1">
                {value.map((option, index) => (
                    <OptionBadge key={`${String(option)}-${index}`} value={String(option)} />
                ))}
            </span>
        );
    }

    if (kind === "options") {
        return <OptionBadge value={String(value)} />;
    }

    /*
      ⚠️ THE APP'S LOCALE, NOT THE RUNTIME'S. This was a bare `toLocaleString()`,
      which reads the OS setting in the browser and the container's (`en-US`) on
      the server — so a Spanish user saw `3/15/2026, 2:32:11 PM` and the same
      value rendered differently before and after hydration. `formatDateTime`
      takes the locale the user actually chose. See `@/lib/format`.
    */
    if (kind === "date" || kind === "datetime") {
        const text =
            kind === "datetime"
                ? formatDateTime(String(value), locale)
                : formatDate(String(value), locale);
        if (text) return <span data-tabular>{text}</span>;
    }

    // Same fallback as the table: `createdAt`/`updatedAt` have no schema entry.
    if (isIsoDateString(value)) {
        const text = isoHasTime(value)
            ? formatDateTime(value, locale)
            : formatDate(value, locale);
        if (text) return <span data-tabular>{text}</span>;
    }

    if (typeof value === "object") {
        return (
            <code className="bg-muted/60 block overflow-x-auto rounded px-1.5 py-1 font-mono text-[11px]">
                {JSON.stringify(value)}
            </code>
        );
    }

    // Detected URLs and emails are actionable here too — same rule as the grid.
    const link = hrefFor(String(value));
    if (link) {
        const text = String(value);
        return (
            <a
                href={link}
                target={linkKindOf(text) === "url" ? "_blank" : undefined}
                rel="noopener noreferrer"
                title={text}
                className="text-primary break-words hover:underline"
            >
                {linkLabel(text)}
            </a>
        );
    }

    return <span className="break-words">{String(value)}</span>;
}

/** One option value, tinted by `optionTint` — shared with the table. */
function OptionBadge({ value }: { value: string }) {
    return (
        <span
            className={cn(
                "text-2xs inline-flex max-w-full items-center rounded-full px-2 py-0.5 font-medium",
                optionTint(value)
            )}
        >
            <span className="truncate">{value}</span>
        </span>
    );
}
