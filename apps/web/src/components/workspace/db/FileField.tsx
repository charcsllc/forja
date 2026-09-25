"use client";

import * as React from "react";
import {
    DownloadIcon,
    LinkIcon,
    LoaderIcon,
    Trash2Icon,
    UploadCloudIcon,
    XIcon,
} from "lucide-react";
import { ConfirmDialog } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";
import { toast } from "@/lib/toast";
import { splitForPreview } from "@/lib/db-files";
import { filesOf, isImageFile, type StoredFile } from "@/lib/totalum-schema";
import { cn } from "@/lib/utils";
import { fileGlyphFor, FileGalleryModal, MoreFilesBadge } from "./FilePreview";

/**
 * ═══ ATTACHED FILES (Feature H3) ════════════════════════════════════════════
 *
 * Add, replace and remove files on a `file` / `multipleFile` field.
 *
 * ── WHAT A FILE VALUE ACTUALLY IS ───────────────────────────────────────────
 *
 * ⚠️ THE READ SHAPE AND THE WRITE SHAPE ARE DIFFERENT, and mixing them up is the
 * classic Totalum file bug. On READ a field holds `{ name, url }` — `url` is a
 * SIGNED, EXPIRING link. On WRITE you send only `{ name }`: the id you got back
 * from the upload. Writing the whole read object back would persist a signed URL
 * that is dead within the hour.
 *
 * ⚠️ NEVER BUILD A FILE URL BY HAND. The docs are explicit about this. The only
 * valid source of a URL is the one the record came back with, or the one the
 * upload endpoint returned.
 *
 * ── UPLOADS COST A CREDIT, SO NOTHING UPLOADS BY ACCIDENT ────────────────────
 *
 * `UPLOAD_FILE` is 0.5 credits per file. The drop zone only fires on a real drop
 * or a real file choice, and a failed upload is reported rather than retried in a
 * loop.
 */

export interface FileFieldProps {
    projectId: string;
    /** The current field value, in whatever shape it arrived. */
    value: unknown;
    multiple: boolean;
    disabled?: boolean;
    /**
     * Called with the value to STORE — `{ name }` objects only, never a signed
     * url. A single-file field gets an object (or `null`), a multiple-file field
     * an array.
     */
    onChange: (next: unknown) => void;
    label?: string;
}

interface Uploading {
    id: string;
    fileName: string;
    /** 0–100. Real progress from XHR, not a fake animation. */
    progress: number;
}

let uploadSequence = 0;

const MAX_BYTES = 12 * 1024 * 1024; // Matches the VCaaS route's own limit.

export function FileField({
    projectId,
    value,
    multiple,
    disabled,
    onChange,
    label,
}: FileFieldProps) {
    const t = useT();

    const files = React.useMemo(() => filesOf(value), [value]);
    const [uploading, setUploading] = React.useState<Uploading[]>([]);
    const [dragging, setDragging] = React.useState(false);
    /** ⭐ The "attach from a URL" row: closed, or open with a draft in it. */
    const [urlDraft, setUrlDraft] = React.useState<string | null>(null);
    const [fetchingUrl, setFetchingUrl] = React.useState(false);
    const [removing, setRemoving] = React.useState<StoredFile | null>(null);
    const [lightbox, setLightbox] = React.useState<StoredFile | null>(null);
    /** ⭐ "See all of them" — every file on the field, up to the gallery's cap. */
    const [galleryOpen, setGalleryOpen] = React.useState(false);

    /** The cards that are drawn, and how many the `+X` stands for. */
    const { shown, hidden } = splitForPreview(files);

    const inputRef = React.useRef<HTMLInputElement>(null);
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    /**
     * Upload one file with REAL progress.
     *
     * ⚠️ `XMLHttpRequest`, not `fetch`, and deliberately: `fetch` still cannot
     * report upload progress in any browser. A fake progress bar on a slow
     * connection is worse than none — it tells the user a lie about whether it is
     * safe to navigate away.
     */
    function uploadOne(file: File): Promise<{ name: string; url?: string } | null> {
        return new Promise(resolve => {
            const id = `u${(uploadSequence += 1)}`;
            setUploading(list => [...list, { id, fileName: file.name, progress: 0 }]);

            const finish = (result: { name: string; url?: string } | null) => {
                if (mounted.current) setUploading(list => list.filter(item => item.id !== id));
                resolve(result);
            };

            const body = new FormData();
            body.append("file", file);

            const request = new XMLHttpRequest();
            request.open("POST", `/api/vcaas/upload/${encodeURIComponent(projectId)}`);

            request.upload.onprogress = event => {
                if (!event.lengthComputable || !mounted.current) return;
                const progress = Math.round((event.loaded / event.total) * 100);
                setUploading(list =>
                    list.map(item => (item.id === id ? { ...item, progress } : item))
                );
            };

            request.onload = () => {
                let payload: { ok?: boolean; data?: { fileNameId?: string; url?: string }; error?: string } | null =
                    null;
                try {
                    payload = JSON.parse(request.responseText);
                } catch {
                    payload = null;
                }

                if (request.status >= 200 && request.status < 300 && payload?.ok && payload.data?.fileNameId) {
                    finish({ name: payload.data.fileNameId, url: payload.data.url });
                    return;
                }

                toast.error(t("workspace.database.files.uploadFailed", { file: file.name }), {
                    description: payload?.error || undefined,
                });
                finish(null);
            };

            request.onerror = () => {
                toast.error(t("workspace.database.files.uploadFailed", { file: file.name }));
                finish(null);
            };

            request.send(body);
        });
    }

    /**
     * ⭐ ATTACH FROM A URL.
     *
     * ⚠️ THE DOWNLOAD HAPPENS ON THE SERVER, not here. A cross-origin `fetch` of
     * an arbitrary image is blocked by CORS for almost every host anyone would
     * paste, so doing it in the browser would produce a feature that works
     * against the few permissive origins you test with and fails everywhere else.
     * The upload proxy takes `{ url }`, fetches it, and forwards the bytes as an
     * ordinary multipart upload — see `api/vcaas/upload/[projectId]`.
     *
     * ⚠️ IT COSTS THE SAME 0.5 CREDITS as any other upload, because it IS one:
     * the file ends up in the project's storage with its own id. Pasting a link
     * does not store the link.
     */
    async function attachFromUrl(rawUrl: string) {
        const url = rawUrl.trim();
        if (!url || disabled || fetchingUrl) return;

        setFetchingUrl(true);
        try {
            const response = await fetch(`/api/vcaas/upload/${encodeURIComponent(projectId)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ url }),
            });

            const payload = (await response.json().catch(() => null)) as
                | { ok?: boolean; data?: { fileNameId?: string; url?: string }; error?: string }
                | null;

            if (!response.ok || !payload?.ok || !payload.data?.fileNameId) {
                toast.error(t("workspace.database.files.urlFailed"), {
                    description: payload?.error || undefined,
                });
                return;
            }

            const stored: StoredFile = { name: payload.data.fileNameId, url: payload.data.url };
            onChange(multiple ? [...files, stored] : stored);
            setUrlDraft(null);
            toast.success(t("workspace.database.files.uploaded"));
        } catch {
            toast.error(t("workspace.database.files.urlFailed"));
        } finally {
            if (mounted.current) setFetchingUrl(false);
        }
    }

    async function handleFiles(list: FileList | null) {
        if (!list || list.length === 0 || disabled) return;

        const chosen = Array.from(list);

        // A single-file field takes the first one; saying so is kinder than
        // silently dropping the rest.
        const accepted = multiple ? chosen : chosen.slice(0, 1);
        if (!multiple && chosen.length > 1) {
            toast.info(t("workspace.database.files.singleOnly"));
        }

        const withinLimit = accepted.filter(file => {
            if (file.size <= MAX_BYTES) return true;
            toast.error(t("workspace.database.files.tooLarge", { file: file.name }));
            return false;
        });
        if (withinLimit.length === 0) return;

        const uploaded: StoredFile[] = [];
        for (const file of withinLimit) {
            const result = await uploadOne(file);
            if (result) uploaded.push(result);
        }
        if (uploaded.length === 0) return;

        /**
         * ⚠️ ONLY `{ name }` IS STORED. The `url` we just received is signed and
         * expiring; it is kept in local state purely so the thumbnail can render
         * before the record is re-fetched.
         */
        const next = multiple ? [...files, ...uploaded] : uploaded[0];
        onChange(next);
        toast.success(
            uploaded.length === 1
                ? t("workspace.database.files.uploaded")
                : t("workspace.database.files.uploadedMany", { count: String(uploaded.length) })
        );
    }

    function removeFile(file: StoredFile) {
        const next = multiple
            ? files.filter(item => item.name !== file.name)
            : null;
        onChange(next);
        setRemoving(null);
        toast.success(t("workspace.database.files.removed"));
    }

    const busy = uploading.length > 0;
    const canAdd = !disabled && (multiple || files.length === 0);

    return (
        <div className="space-y-2">
            {label && <p className="text-xs font-medium">{label}</p>}

            {/* ── Existing files ─────────────────────────────────────────── */}
            {/*
              ⭐ THE FIRST THREE, THEN A `+X` INTO THE GALLERY.

              ⚠️ IT DREW EVERY FILE IN THE FIELD BEFORE. A `multipleFile` holding
              sixty photographs turned the record form into a wall of full-size
              originals — sixty requests, before you had typed anything — and
              pushed Save off the bottom of a modal that scrolls.

              ⚠️ REMOVING A HIDDEN FILE STILL WORKS, which is why the gallery gets
              `onRemove` rather than being a read-only lightbox: collapsing the
              list must not make the fourth attachment impossible to detach.
            */}
            {shown.length > 0 && (
                <>
                    <ul
                        className={cn(
                            "gap-2",
                            // Images read as a grid of thumbnails; documents as a list.
                            shown.every(isImageFile) ? "grid grid-cols-3 sm:grid-cols-4" : "flex flex-col"
                        )}
                    >
                        {shown.map(file => (
                            <li key={file.name}>
                                <FileCard
                                    file={file}
                                    disabled={disabled}
                                    onOpenImage={() => setLightbox(file)}
                                    onRemove={() => setRemoving(file)}
                                />
                            </li>
                        ))}
                    </ul>

                    {hidden > 0 && (
                        <div className="flex items-center gap-2">
                            <MoreFilesBadge
                                hidden={hidden}
                                total={files.length}
                                size="md"
                                onClick={() => setGalleryOpen(true)}
                            />
                            <button
                                type="button"
                                onClick={() => setGalleryOpen(true)}
                                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded text-xs hover:underline focus-visible:ring-2 focus-visible:outline-none"
                            >
                                {t("workspace.database.files.showAll", { count: files.length })}
                            </button>
                        </div>
                    )}
                </>
            )}

            {/*
              ⚠️ THE CONFIRMATION IS OPENED *AFTER* THE GALLERY CLOSES. Three
              stacked dialogs (record form → gallery → confirm) fight over one
              focus trap, and the confirm ends up behind the thing that opened it —
              the same trap the record form's own Delete button documents.
            */}
            <FileGalleryModal
                open={galleryOpen}
                onOpenChange={setGalleryOpen}
                files={files}
                label={label}
                onRemove={
                    disabled
                        ? undefined
                        : file => {
                              setGalleryOpen(false);
                              setRemoving(file);
                          }
                }
            />

            {/* ── In-flight uploads, with real progress ──────────────────── */}
            {uploading.map(item => (
                <div
                    key={item.id}
                    className="border-border bg-muted/40 space-y-1.5 rounded-lg border p-2.5"
                >
                    <div className="flex items-center gap-2">
                        <LoaderIcon className="text-muted-foreground size-3.5 shrink-0 animate-spin" aria-hidden />
                        <span className="min-w-0 flex-1 truncate text-xs">{item.fileName}</span>
                        <span className="text-muted-foreground text-xs tabular-nums">{item.progress}%</span>
                    </div>
                    <div
                        className="bg-border h-1 overflow-hidden rounded-full"
                        role="progressbar"
                        aria-valuenow={item.progress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={t("workspace.database.files.uploading", { file: item.fileName })}
                    >
                        <div
                            className="bg-primary h-full rounded-full transition-[width] duration-200"
                            style={{ width: `${item.progress}%` }}
                        />
                    </div>
                </div>
            ))}

            {/* ── Drop zone ─────────────────────────────────────────────── */}
            {canAdd && (
                <div
                    /* Keeps the chat composer's page-wide drop out of this field —
                       see `useWindowFileDrag` in `PromptComposer`. */
                    data-dropzone="db-file-field"
                    onDragOver={event => {
                        event.preventDefault();
                        setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={event => {
                        event.preventDefault();
                        setDragging(false);
                        void handleFiles(event.dataTransfer.files);
                    }}
                    className={cn(
                        "rounded-lg border border-dashed p-4 text-center transition-colors",
                        dragging ? "border-primary bg-primary-subtle" : "border-border bg-muted/30"
                    )}
                >
                    <UploadCloudIcon className="text-muted-foreground mx-auto mb-1.5 size-5" aria-hidden />
                    <p className="text-xs">
                        {/* The click target is a real button so it is keyboard-reachable —
                            a bare div with onClick is not. */}
                        <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="h-auto p-0 text-xs"
                            disabled={busy}
                            onClick={() => inputRef.current?.click()}
                        >
                            {t("workspace.database.files.choose")}
                        </Button>{" "}
                        <span className="text-muted-foreground">
                            {t("workspace.database.files.orDrop")}
                        </span>
                    </p>
                    <p className="text-muted-foreground mt-1 text-[11px]">
                        {t("workspace.database.files.limit")}
                    </p>

                    {/*
                      ⭐ THE THIRD WAY IN. Choose · drop · paste a URL — the three
                      ways a file actually arrives. It is a DISCLOSURE rather than a
                      permanently open field: an input sitting under every file
                      column would make the common case (drag something in) read as
                      the secondary one.
                    */}
                    {urlDraft === null ? (
                        <Button
                            type="button"
                            variant="link"
                            size="sm"
                            className="text-muted-foreground mt-1 h-auto p-0 text-[11px]"
                            disabled={busy}
                            onClick={() => setUrlDraft("")}
                        >
                            <LinkIcon className="size-3" aria-hidden />
                            {t("workspace.database.files.fromUrl")}
                        </Button>
                    ) : (
                        <div className="mt-2 flex items-center gap-1.5">
                            <Input
                                autoFocus
                                type="url"
                                inputMode="url"
                                value={urlDraft}
                                disabled={fetchingUrl}
                                onChange={event => setUrlDraft(event.target.value)}
                                onKeyDown={event => {
                                    if (event.key === "Enter") {
                                        // ⚠️ The field lives inside the record FORM;
                                        // without this, Enter submits the record.
                                        event.preventDefault();
                                        void attachFromUrl(urlDraft);
                                    } else if (event.key === "Escape") {
                                        setUrlDraft(null);
                                    }
                                }}
                                placeholder={t("workspace.database.files.urlPlaceholder")}
                                aria-label={t("workspace.database.files.fromUrl")}
                                className="h-7 text-xs"
                            />
                            <Button
                                type="button"
                                size="sm"
                                className="h-7 shrink-0 text-xs"
                                disabled={fetchingUrl || !urlDraft.trim()}
                                onClick={() => void attachFromUrl(urlDraft)}
                            >
                                {fetchingUrl ? (
                                    <LoaderIcon className="size-3.5 animate-spin" aria-hidden />
                                ) : null}
                                {t("workspace.database.files.attach")}
                            </Button>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-7 shrink-0"
                                disabled={fetchingUrl}
                                onClick={() => setUrlDraft(null)}
                                aria-label={t("common.cancel")}
                            >
                                <XIcon className="size-3.5" aria-hidden />
                            </Button>
                        </div>
                    )}

                    <input
                        ref={inputRef}
                        type="file"
                        multiple={multiple}
                        className="sr-only"
                        onChange={event => {
                            void handleFiles(event.target.files);
                            // Reset so choosing the SAME file twice still fires.
                            event.target.value = "";
                        }}
                    />
                </div>
            )}

            {files.length === 0 && !canAdd && (
                <p className="text-muted-foreground text-xs">{t("workspace.database.files.none")}</p>
            )}

            {/* ── Lightbox ──────────────────────────────────────────────── */}
            {lightbox && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={lightbox.name}
                    className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
                    onClick={() => setLightbox(null)}
                    onKeyDown={event => {
                        if (event.key === "Escape") setLightbox(null);
                    }}
                    tabIndex={-1}
                    ref={node => node?.focus()}
                >
                    <Button
                        variant="ghost"
                        size="icon"
                        className="absolute top-3 right-3 text-white hover:bg-white/15 hover:text-white"
                        aria-label={t("common.close")}
                        onClick={() => setLightbox(null)}
                    >
                        <XIcon className="size-5" aria-hidden />
                    </Button>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        src={lightbox.url}
                        alt={lightbox.name}
                        className="max-h-full max-w-full rounded-lg object-contain"
                        onClick={event => event.stopPropagation()}
                    />
                </div>
            )}

            <ConfirmDialog
                open={removing !== null}
                onOpenChange={open => setRemoving(open ? removing : null)}
                tone="danger"
                title={t("workspace.database.files.removeTitle")}
                description={t("workspace.database.files.removeBody")}
                confirmLabel={t("workspace.database.files.remove")}
                onConfirm={() => {
                    if (removing) removeFile(removing);
                }}
            />
        </div>
    );
}

function FileCard({
    file,
    disabled,
    onOpenImage,
    onRemove,
}: {
    file: StoredFile;
    disabled?: boolean;
    onOpenImage: () => void;
    onRemove: () => void;
}) {
    const t = useT();
    const isImage = isImageFile(file);
    /* ⚠️ THE SHARED GLYPH, not a second extension table. This card used to draw
       its own grey icon while the gallery two clicks away drew a red PDF. */
    const { Icon, tint } = fileGlyphFor(file);

    if (isImage && file.url) {
        return (
            <div className="group border-border relative aspect-square overflow-hidden rounded-lg border">
                <button
                    type="button"
                    onClick={onOpenImage}
                    className="focus-visible:ring-ring block size-full focus-visible:ring-2 focus-visible:outline-none"
                    aria-label={t("workspace.database.files.preview", { file: file.name })}
                >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={file.url} alt={file.name} className="size-full object-cover" />
                </button>

                <div className="absolute inset-x-0 bottom-0 flex justify-end gap-0.5 bg-gradient-to-t from-black/70 to-transparent p-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-white hover:bg-white/20 hover:text-white"
                        asChild
                    >
                        <a href={file.url} download={file.name} target="_blank" rel="noopener noreferrer"
                           aria-label={t("workspace.database.files.download")}>
                            <DownloadIcon className="size-3" aria-hidden />
                        </a>
                    </Button>
                    {!disabled && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 text-white hover:bg-white/20 hover:text-white"
                            onClick={onRemove}
                            aria-label={t("workspace.database.files.remove")}
                        >
                            <Trash2Icon className="size-3" aria-hidden />
                        </Button>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="border-border flex items-center gap-2 rounded-lg border p-2">
            <span
                style={{
                    backgroundColor: `color-mix(in oklch, ${tint} 14%, transparent)`,
                    color: tint,
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded"
            >
                <Icon className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs" title={file.name}>
                {file.name}
            </span>
            {file.url && (
                <Button variant="ghost" size="icon" className="size-7 shrink-0" asChild>
                    <a href={file.url} download={file.name} target="_blank" rel="noopener noreferrer"
                       aria-label={t("workspace.database.files.download")}>
                        <DownloadIcon className="size-3.5" aria-hidden />
                    </a>
                </Button>
            )}
            {!disabled && (
                <Button
                    variant="ghost"
                    size="icon"
                    className="text-destructive hover:text-destructive size-7 shrink-0"
                    onClick={onRemove}
                    aria-label={t("workspace.database.files.remove")}
                >
                    <Trash2Icon className="size-3.5" aria-hidden />
                </Button>
            )}
        </div>
    );
}
