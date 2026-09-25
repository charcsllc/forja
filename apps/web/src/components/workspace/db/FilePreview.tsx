"use client";

import * as React from "react";
import {
    FileArchiveIcon,
    FileAudioIcon,
    FileCodeIcon,
    FileIcon,
    FileSpreadsheetIcon,
    FileTextIcon,
    FileTypeIcon,
    FileVideoIcon,
    ImageIcon,
    PresentationIcon,
    Trash2Icon,
} from "lucide-react";
import { Modal } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import {
    extensionOf,
    fileTypeOf,
    galleryFiles,
    splitForPreview,
    type FileType,
} from "@/lib/db-files";
import { isImageFile, type StoredFile } from "@/lib/totalum-schema";
import { cn } from "@/lib/utils";

/**
 * ═══ ATTACHED FILES, VISIBLE WHERE THEY LIVE ════════════════════════════════
 *
 * One thumbnail component and one gallery, used by all three surfaces that show a
 * file field: the grid cell, the record detail, and the file editor. They were
 * three separate renderings before — a name in the grid, a 40px square in the
 * detail, a card in the editor — which meant a photo column looked like a column
 * of hex ids in the one place people scan.
 *
 * ── AN IMAGE IS ITS OWN THUMBNAIL; EVERYTHING ELSE GETS A TYPED TILE ────────
 *
 * A PDF, a Word document and a spreadsheet are told apart by icon AND colour AND
 * the extension printed on the tile. A single grey paperclip for all of them is
 * the version that makes you open files to find out what they are.
 *
 * ── WHY THESE IMAGES DO NOT MAKE THE TABLE SLOW ────────────────────────────
 *
 * ⚠️ THE URL CANNOT BE RESIZED, SO THE COST IS CONTROLLED ELSEWHERE. Totalum
 * returns a signed link to the ORIGINAL bytes — there is no width parameter to
 * add and no CDN of ours in front of it, so a 4 MB phone photo is a 4 MB photo.
 * Four things keep that from mattering:
 *
 *   · `loading="lazy"` — rows below the fold never request anything at all, which
 *     is what turns "450 possible thumbnails" into "the dozen you can see";
 *   · `decoding="async"` — a big JPEG decodes off the main thread, so scrolling
 *     does not jank while it happens;
 *   · fixed `width`/`height` — the row height never shifts as images arrive, and
 *     the browser can skip layout for them entirely;
 *   · the caller's row/column budgets in `@/lib/db-files`.
 *
 * ⚠️ A BROKEN IMAGE FALLS BACK TO THE TYPED TILE. A signed URL expires, and the
 * default broken-image glyph in a 28px box is indistinguishable from a bug.
 */

// ── Type → icon + tint ──────────────────────────────────────────────────────
//
// ⚠️ THE COLOURS ARE THE DESIGN SYSTEM'S `--data-*` RAMP, not raw palette
// classes: it is the one set of hues defined for BOTH themes, so a PDF stays
// legibly red on dark without a second table of overrides. The mapping is
// conventional on purpose — red PDF, blue document, green spreadsheet, orange
// deck — because those are the colours the same files have in every file manager
// the user has ever opened.
const TYPES: Record<FileType, { Icon: React.ElementType; tint: string }> = {
    image: { Icon: ImageIcon, tint: "var(--data-7)" },
    pdf: { Icon: FileTextIcon, tint: "var(--data-6)" },
    word: { Icon: FileTypeIcon, tint: "var(--data-1)" },
    excel: { Icon: FileSpreadsheetIcon, tint: "var(--data-3)" },
    powerpoint: { Icon: PresentationIcon, tint: "var(--data-5)" },
    video: { Icon: FileVideoIcon, tint: "var(--data-9)" },
    audio: { Icon: FileAudioIcon, tint: "var(--data-13)" },
    archive: { Icon: FileArchiveIcon, tint: "var(--data-4)" },
    code: { Icon: FileCodeIcon, tint: "var(--data-12)" },
    text: { Icon: FileTextIcon, tint: "var(--data-8)" },
    other: { Icon: FileIcon, tint: "var(--data-8)" },
};

/**
 * The icon and tint for one file — exported so the record editor's file cards
 * are the SAME red PDF and blue document as the grid and the gallery. Three
 * renderings of one file type is how a user learns the colour means nothing.
 */
export function fileGlyphFor(file: StoredFile): { Icon: React.ElementType; tint: string } {
    return TYPES[fileTypeOf(file)];
}

export type ThumbSize = "sm" | "md" | "lg";

const BOX: Record<ThumbSize, { className: string; pixels: number; icon: string; label: string }> = {
    // The grid: small enough that three of them plus a badge fit a narrow column
    // without changing the row height a text cell would have had.
    sm: { className: "size-7 rounded", pixels: 28, icon: "size-3.5", label: "text-[7px]" },
    md: { className: "size-10 rounded-md", pixels: 40, icon: "size-4", label: "text-[8px]" },
    lg: { className: "size-20 rounded-lg", pixels: 80, icon: "size-7", label: "text-[10px]" },
};

/**
 * One file as a clickable square.
 *
 * ⚠️ IT IS AN `<a target="_blank">`, WHICH IS ALSO WHAT KEEPS THE ROW CLICK OUT
 * OF THE WAY. The grid opens the record editor when a row is clicked and skips
 * anything inside `a, button` — so a plain `div` with an `onClick` here would open
 * the file AND the editor. The anchor is the feature and the guard at once.
 */
export function FileThumb({
    file,
    size = "sm",
    showName = false,
}: {
    file: StoredFile;
    size?: ThumbSize;
    /** Print the file name under the tile — for the gallery, not for a cell. */
    showName?: boolean;
}) {
    const t = useT();
    const [failed, setFailed] = React.useState(false);

    const box = BOX[size];
    const type = fileTypeOf(file);
    const { Icon, tint } = TYPES[type];
    const extension = extensionOf(file.name);
    const asImage = isImageFile(file) && !!file.url && !failed;

    const tile = asImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={file.url}
            alt={file.name}
            width={box.pixels}
            height={box.pixels}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className={cn("border-border/60 border object-cover", box.className)}
        />
    ) : (
        <span
            aria-hidden
            style={{ backgroundColor: `color-mix(in oklch, ${tint} 14%, transparent)`, color: tint }}
            className={cn(
                "border-border/50 flex flex-col items-center justify-center gap-px border leading-none",
                box.className
            )}
        >
            <Icon className={box.icon} />
            {/* The extension is the part that separates two files with the same
                icon — `.docx` from `.rtf`, `.csv` from `.xlsx`. */}
            {extension && size !== "sm" && (
                <span className={cn("font-semibold tracking-tight uppercase", box.label)}>
                    {extension.slice(0, 4)}
                </span>
            )}
        </span>
    );

    return (
        <a
            href={file.url}
            target="_blank"
            rel="noopener noreferrer"
            title={file.name}
            aria-label={t("workspace.database.files.preview", { file: file.name })}
            /* ⚠️ `relative z-10` + stopPropagation for the same reason a linked
               cell value has them: this must be the one thing in the row that is
               not the row. */
            onClick={event => event.stopPropagation()}
            className={cn(
                "focus-visible:ring-ring relative z-10 block shrink-0 rounded transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none",
                showName && "flex flex-col items-center gap-1"
            )}
        >
            {tile}
            {showName && (
                <span className="text-muted-foreground w-20 truncate text-center text-[10px]">
                    {file.name}
                </span>
            )}
        </a>
    );
}

/**
 * The `+X` that stands for the files not drawn.
 *
 * ⚠️ IT IS A BUTTON, NOT A LABEL. "+7" that cannot be opened tells you data
 * exists and then refuses to show it — which is the state this whole feature was
 * added to remove. Being a `<button>` also keeps it out of the grid's row-click
 * handler, which skips anything inside `a, button`.
 */
export function MoreFilesBadge({
    hidden,
    total,
    size = "sm",
    onClick,
}: {
    hidden: number;
    /** The field's full count — what the accessible name should say. */
    total: number;
    size?: ThumbSize;
    onClick: () => void;
}) {
    const t = useT();

    return (
        <button
            type="button"
            onClick={event => {
                event.stopPropagation();
                onClick();
            }}
            aria-label={t("workspace.database.files.showAll", { count: total })}
            className={cn(
                "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring relative z-10 flex shrink-0 items-center justify-center border border-transparent font-medium tabular-nums transition-colors focus-visible:ring-2 focus-visible:outline-none",
                BOX[size].className,
                size === "sm" ? "text-[10px]" : "text-xs"
            )}
        >
            +{hidden}
        </button>
    );
}

/**
 * The first few files of a field, with a `+X` for the rest.
 *
 * ⚠️ THE BADGE IS A BUTTON, NOT A LABEL. "+7" that cannot be opened tells you
 * data exists and refuses to show it — which is the state this whole feature was
 * added to remove. It opens the gallery, and being a `<button>` it is also
 * ignored by the row-click handler.
 */
export function FilePreviewStrip({
    files,
    size = "sm",
    label,
    limit,
    onRemove,
    className,
}: {
    files: StoredFile[];
    size?: ThumbSize;
    /** The field name, used as the gallery's title. */
    label?: string;
    limit?: number;
    /** When present, the gallery offers to detach each file. */
    onRemove?: (file: StoredFile) => void;
    className?: string;
}) {
    const t = useT();
    const [galleryOpen, setGalleryOpen] = React.useState(false);

    if (files.length === 0) return null;

    const { shown, hidden } = splitForPreview(files, limit);

    return (
        <>
            <span className={cn("flex flex-wrap items-center gap-1", className)}>
                {shown.map((file, index) => (
                    <FileThumb key={`${file.name}-${index}`} file={file} size={size} />
                ))}

                {hidden > 0 && (
                    <MoreFilesBadge
                        hidden={hidden}
                        total={files.length}
                        size={size}
                        onClick={() => setGalleryOpen(true)}
                    />
                )}
            </span>

            <FileGalleryModal
                open={galleryOpen}
                onOpenChange={setGalleryOpen}
                files={files}
                label={label}
                onRemove={onRemove}
            />
        </>
    );
}

/**
 * Every file on the field, at a size you can actually recognise.
 *
 * ⚠️ IT STOPS AT 50 AND SAYS SO. A record holding 500 attachments would otherwise
 * turn one click into 500 image requests; a footnote naming the number that were
 * not drawn is honest, and silently rendering 50 of 500 as if that were all of
 * them is not.
 */
export function FileGalleryModal({
    open,
    onOpenChange,
    files,
    label,
    onRemove,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    files: StoredFile[];
    label?: string;
    onRemove?: (file: StoredFile) => void;
}) {
    const t = useT();
    const { shown, dropped } = galleryFiles(files);

    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            size="lg"
            title={label || t("workspace.database.files.galleryTitle")}
            description={t("workspace.database.files.galleryCount", { count: files.length })}
        >
            <ul className="grid grid-cols-3 gap-3 sm:grid-cols-5">
                {shown.map((file, index) => (
                    <li key={`${file.name}-${index}`} className="group relative">
                        <FileThumb file={file} size="lg" showName />
                        {onRemove && (
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="text-destructive bg-card/90 absolute top-0.5 right-0.5 size-6 opacity-0 shadow-2xs transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                                onClick={() => onRemove(file)}
                                aria-label={t("workspace.database.files.remove")}
                            >
                                <Trash2Icon className="size-3" aria-hidden />
                            </Button>
                        )}
                    </li>
                ))}
            </ul>

            {dropped > 0 && (
                <p className="text-muted-foreground mt-3 text-xs">
                    {t("workspace.database.files.galleryTruncated", {
                        shown: shown.length,
                        total: files.length,
                    })}
                </p>
            )}
        </Modal>
    );
}
