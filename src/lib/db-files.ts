/**
 * ═══ HOW AN ATTACHED FILE LOOKS IN THE DATABASE BROWSER ═════════════════════
 *
 * Pure helpers shared by the grid cell, the record detail and the file editor, so
 * the three can never disagree about what a file IS or how many of them a surface
 * is allowed to draw. No React, no fetch — and the budgets below are the whole
 * reason this file exists as data rather than as three magic numbers sprinkled
 * through the components.
 *
 * ── THE BUDGETS ARE A PERFORMANCE CONTRACT, NOT A STYLE CHOICE ──────────────
 *
 * A thumbnail is a real network request against a signed, uncached URL. The grid
 * can hold 100 rows of a table with six file columns holding twenty files each —
 * drawn naively that is twelve thousand image requests for a screen that shows
 * about fifteen. So three limits, each cutting a different dimension:
 *
 *   · `FILE_PREVIEW_MAX_ROWS`    — 50 rows or fewer, or the grid shows text only.
 *     Above that you are scanning, not looking, and the page size can go to 100.
 *   · `FILE_PREVIEW_MAX_COLUMNS` — the first 3 file columns only. A table with
 *     eight of them would push every other column off screen.
 *   · `FILE_PREVIEW_LIMIT`       — 3 files per cell, the rest behind a `+X`.
 *
 * Worst case is therefore 50 × 3 × 3 = 450 thumbnails, all of them `loading=lazy`
 * so only the visible rows actually fetch. `FILE_GALLERY_LIMIT` then caps the
 * "see everything" modal at 50: a record holding 500 receipts must not turn one
 * click into 500 requests.
 */

import { isImageFile, type StoredFile } from "./totalum-schema";

/** Files drawn inline in a cell / a field before the rest collapse into `+X`. */
export const FILE_PREVIEW_LIMIT = 3;

/** Files drawn in the "all files" modal. Beyond this they are not rendered. */
export const FILE_GALLERY_LIMIT = 50;

/** Above this many rows on the page, file columns render as text again. */
export const FILE_PREVIEW_MAX_ROWS = 50;

/** How many file columns of one table get thumbnails. */
export const FILE_PREVIEW_MAX_COLUMNS = 3;

/**
 * The broad family of a file, from its extension.
 *
 * ⚠️ EXTENSION, NOT MIME. The read shape Totalum returns is `{ name, url }` and a
 * `type` that is only ever the coarse `"image"`; there is no content type to
 * switch on. The name is what we have, and it is what a file manager uses too.
 */
export type FileType =
    | "image"
    | "pdf"
    | "word"
    | "excel"
    | "powerpoint"
    | "video"
    | "audio"
    | "archive"
    | "code"
    | "text"
    | "other";

const BY_EXTENSION: Record<string, FileType> = {
    pdf: "pdf",

    doc: "word",
    docx: "word",
    odt: "word",
    rtf: "word",
    pages: "word",

    xls: "excel",
    xlsx: "excel",
    xlsm: "excel",
    ods: "excel",
    csv: "excel",
    tsv: "excel",
    numbers: "excel",

    ppt: "powerpoint",
    pptx: "powerpoint",
    odp: "powerpoint",
    key: "powerpoint",

    mp4: "video",
    mov: "video",
    webm: "video",
    avi: "video",
    mkv: "video",
    m4v: "video",

    mp3: "audio",
    wav: "audio",
    ogg: "audio",
    m4a: "audio",
    flac: "audio",
    aac: "audio",

    zip: "archive",
    rar: "archive",
    "7z": "archive",
    tar: "archive",
    gz: "archive",
    bz2: "archive",

    json: "code",
    xml: "code",
    yml: "code",
    yaml: "code",
    html: "code",
    css: "code",
    js: "code",
    ts: "code",
    tsx: "code",
    jsx: "code",
    py: "code",
    sql: "code",
    sh: "code",

    txt: "text",
    md: "text",
    log: "text",
};

/**
 * The extension, lowercased and without the dot. `""` when there is none.
 *
 * ⚠️ THE STORED NAME IS AN ID, NOT A FILENAME — Totalum hands back things like
 * `a91f…-invoice.pdf`, and query strings can ride along on a URL-derived name. The
 * extension is still the last dot-segment, but it must be cut at `?` and `#` first
 * or `photo.jpg?X-Amz-Signature=…` classifies as `other`.
 */
export function extensionOf(name: string): string {
    const clean = String(name ?? "")
        .split(/[?#]/)[0]
        .trim();
    const base = clean.split("/").pop() ?? clean;
    const dot = base.lastIndexOf(".");
    if (dot <= 0 || dot === base.length - 1) return "";
    return base.slice(dot + 1).toLowerCase();
}

/**
 * What KIND of file this is.
 *
 * ⚠️ `isImageFile` WINS. It is the same predicate that decides whether a
 * thumbnail is drawn at all, and a file classified `image` here but not there
 * (or the reverse) would show a picture icon next to a picture.
 */
export function fileTypeOf(file: StoredFile): FileType {
    if (isImageFile(file)) return "image";
    return BY_EXTENSION[extensionOf(file.name)] ?? "other";
}

/**
 * Split a list into what is drawn and how many are hidden.
 *
 * ⚠️ THE COUNT IS OF WHAT IS HIDDEN, NOT OF THE WHOLE FIELD. `+2` on a field of
 * five means "two more", and a badge that read `+5` next to three visible
 * thumbnails would be claiming eight files exist.
 */
export function splitForPreview(
    files: StoredFile[],
    limit: number = FILE_PREVIEW_LIMIT
): { shown: StoredFile[]; hidden: number } {
    if (files.length <= limit) return { shown: files, hidden: 0 };
    return { shown: files.slice(0, limit), hidden: files.length - limit };
}

/** The files the gallery modal renders, and how many it silently drops. */
export function galleryFiles(files: StoredFile[]): { shown: StoredFile[]; dropped: number } {
    if (files.length <= FILE_GALLERY_LIMIT) return { shown: files, dropped: 0 };
    return { shown: files.slice(0, FILE_GALLERY_LIMIT), dropped: files.length - FILE_GALLERY_LIMIT };
}

/** Does a page of this many rows get thumbnails at all? */
export function canPreviewFiles(rowCount: number): boolean {
    return rowCount > 0 && rowCount <= FILE_PREVIEW_MAX_ROWS;
}

/**
 * Which file columns get thumbnails: the first `FILE_PREVIEW_MAX_COLUMNS`, in the
 * order the schema declares them.
 *
 * ⚠️ SCHEMA ORDER, NOT "THE ONES WITH FILES IN THEM". Picking by content would
 * move the pictures to a different column as you page, which is worse than a
 * column that is sometimes empty.
 */
export function previewFileColumns(fileColumnNames: string[]): Set<string> {
    return new Set(fileColumnNames.slice(0, FILE_PREVIEW_MAX_COLUMNS));
}
