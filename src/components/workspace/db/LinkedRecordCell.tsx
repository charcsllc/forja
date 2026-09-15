"use client";

import * as React from "react";
import { useT } from "@/i18n";
import { labelForRecord, type LinkedEntry } from "@/lib/totalum-schema";
import type { DbTable } from "@/lib/vcaas-types";
import { cn } from "@/lib/utils";

/**
 * ═══ A RELATION, AS THE RECORD IT POINTS AT ═════════════════════════════════
 *
 * ⚠️ THIS COLUMN USED TO PRINT `6a6ce62157721914df2d2955`. A `manyToOne` stores
 * an id, so the grid showed the id — which tells you a link EXISTS and nothing
 * whatsoever about what it points at. In a CMS the whole reason to look at an
 * `order` row is to see WHICH client placed it, and that was the one thing the
 * table could not say.
 *
 * The label comes from `labelForRecord`, the same "best available field" rule the
 * record picker uses, so the client called "Acme" is "Acme" everywhere in the
 * panel rather than a name here and an id there.
 *
 * ⚠️ IT NEEDS THE FIELD TO HAVE BEEN EXPANDED. `buildLinkExpansion` asks for the
 * first three relation columns; anything else — an unexpanded column, or a query
 * that fell back after an expansion error — still arrives as a bare id, and this
 * renders that id rather than an empty cell. A relation column never goes blank.
 */

/** How many linked records a single cell names before collapsing to `+X`. */
const CELL_LIMIT = 3;

export function LinkedRecordCell({
    entries,
    table,
    onOpen,
    className,
}: {
    entries: LinkedEntry[];
    /** The table on the other side. Absent ⇒ ids only, nothing to open. */
    table: DbTable | undefined;
    /** Show this linked record. Absent ⇒ the labels are plain text. */
    onOpen?: (entry: LinkedEntry) => void;
    className?: string;
}) {
    const t = useT();

    if (entries.length === 0) {
        return <span className="text-muted-foreground/50 italic">{t("workspace.database.nullValue")}</span>;
    }

    const shown = entries.slice(0, CELL_LIMIT);
    const hidden = entries.length - shown.length;

    return (
        <span className={cn("flex flex-wrap items-center gap-1", className)}>
            {shown.map((entry, index) => (
                <LinkedRecordChip
                    key={`${entry.id}-${index}`}
                    entry={entry}
                    table={table}
                    onOpen={onOpen}
                />
            ))}
            {hidden > 0 && (
                <span className="text-muted-foreground text-[11px] tabular-nums">+{hidden}</span>
            )}
        </span>
    );
}

/**
 * One linked record, as a button that opens it.
 *
 * ⚠️ A `<button>`, WHICH IS ALSO WHAT KEEPS THE ROW CLICK OUT OF THE WAY. The
 * grid opens the record editor when a row is clicked and skips anything inside
 * `a, button`; without that, clicking the client's name would open the ORDER for
 * editing instead of showing the client.
 *
 * ⚠️ THE ID STAYS ON `title`. This is a database browser — the id is sometimes
 * the answer, and replacing it with a name everywhere would take that away. It is
 * one hover from the label and always visible in the record editor.
 */
export function LinkedRecordChip({
    entry,
    table,
    onOpen,
}: {
    entry: LinkedEntry;
    table: DbTable | undefined;
    onOpen?: (entry: LinkedEntry) => void;
}) {
    const t = useT();

    const label = entry.record ? labelForRecord(table, entry.record) : "";
    /** No expansion ⇒ no label. The id is the honest thing to show. */
    const text = label || entry.id;
    const isId = text === entry.id;

    if (!onOpen) {
        return (
            <span className={cn("truncate", isId && "font-mono text-[11px]")} title={entry.id}>
                {text}
            </span>
        );
    }

    return (
        <button
            type="button"
            onClick={event => {
                event.stopPropagation();
                onOpen(entry);
            }}
            title={entry.id}
            aria-label={t("workspace.database.detail.openRecord", { record: text })}
            className={cn(
                "text-primary focus-visible:ring-ring relative z-10 max-w-full truncate rounded text-left hover:underline focus-visible:ring-2 focus-visible:outline-none",
                isId && "font-mono text-[11px]"
            )}
        >
            {text}
        </button>
    );
}
