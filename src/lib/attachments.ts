/**
 * ═══ THE ATTACHMENT MODEL ═══════════════════════════════════════════════════
 *
 * Everything the prompt composers need to know about a picked file BEFORE it is
 * uploaded: what it is, what to call it in ~14 characters of chip, how big it is
 * and whether it is the same file the user already dropped twice.
 *
 * ⚠️ PURE, AND HERE RATHER THAN IN THE COMPONENT, so the classification is
 * unit-tested (`__tests__/attachments.test.ts`) instead of only ever exercised by
 * eye. `AttachmentTray` maps a kind to an icon and a colour and does nothing else.
 *
 * ⚠️ `support.ts` HAS ITS OWN, NARROWER `fileKind`, and that is deliberate: the
 * support chat accepts exactly seven MIME types (the server refuses the rest), so
 * it only ever needs image/pdf/sheet/file. This module is for the AGENT composers,
 * where anything goes — see the size note below. `formatBytes` and `isSameFile`
 * live here and are re-exported there, so there is one implementation of each.
 */

// ─────────────────────────────────────────────────────────────────────────────
//  Limits
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many files may ride on ONE prompt, on both surfaces.
 *
 * ⚠️ THE TWO COMPOSERS USED TO DISAGREE (4 on the hero, 5 in the chat) for no
 * reason a user could discover: the same drop of six screenshots silently kept
 * four on `/projects` and five in a workspace. One number, imported by both.
 */
export const MAX_ATTACHMENTS = 15;

/**
 * ⚠️ 12 MB BECAUSE THAT IS WHERE THE UPLOAD ACTUALLY DIES, not because it is a
 * round number. `totalum-account-backend`'s VCaaS route mounts
 * `fileUpload({ limits: { fileSize: 12 * 1024 * 1024 }, abortOnLimit: true })`, so
 * a 20 MB file is TRUNCATED mid-stream and the request fails — after the user has
 * waited for the whole body to go up.
 *
 * ⚠️ THE PROXY'S OWN CEILING IS HIGHER (25 MB in `api/vcaas/upload/[projectId]`)
 * and stays higher on purpose: it is a memory guard on `req.formData()`, not a
 * product rule, and lowering a defensive limit to match a product one makes the
 * next change to the product rule a security question.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/** For the copy: `12`, never `12.0`. */
export const MAX_ATTACHMENT_MB = Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024);

// ─────────────────────────────────────────────────────────────────────────────
//  Kinds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an attachment *is*, for the icon and the accent colour.
 *
 * ⚠️ THE LIST IS AS LONG AS IT IS BECAUSE THE ICON IS THE ONLY THING A USER READS.
 * A wall of identical grey paperclips makes "did I attach the right zip?"
 * unanswerable without opening every chip; a red PDF plate next to a green
 * spreadsheet next to a violet video answers it at a glance.
 */
export type AttachmentKind =
    | "image"
    | "video"
    | "audio"
    | "pdf"
    | "sheet"
    | "doc"
    | "slides"
    | "text"
    | "code"
    | "data"
    | "archive"
    | "model3d"
    | "font"
    | "design"
    | "file";

/**
 * Extension → kind. The primary signal, because it is the one that is ALWAYS
 * there: browsers hand back `application/octet-stream` (or `""`) for most of the
 * interesting cases — `.glb`, `.zip` on Windows, `.md`, `.csv` from some tools —
 * and a `.md` file that arrives as a generic grey chip looks broken next to a
 * `.txt` one that does not.
 */
const BY_EXTENSION: Record<string, AttachmentKind> = {
    // Images (raster + vector). SVG is an image to a user and to the agent.
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    webp: "image",
    avif: "image",
    bmp: "image",
    ico: "image",
    tif: "image",
    tiff: "image",
    heic: "image",
    heif: "image",
    svg: "image",

    // Video
    mp4: "video",
    mov: "video",
    webm: "video",
    avi: "video",
    mkv: "video",
    m4v: "video",
    mpg: "video",
    mpeg: "video",

    // Audio
    mp3: "audio",
    wav: "audio",
    ogg: "audio",
    m4a: "audio",
    aac: "audio",
    flac: "audio",

    // Documents
    pdf: "pdf",
    doc: "doc",
    docx: "doc",
    odt: "doc",
    rtf: "doc",
    pages: "doc",

    // Spreadsheets. ⚠️ CSV IS A SHEET, NOT DATA: people attach it meaning "here is
    // the table", and it opens in Excel on almost every machine that has one.
    xls: "sheet",
    xlsx: "sheet",
    xlsm: "sheet",
    ods: "sheet",
    csv: "sheet",
    tsv: "sheet",
    numbers: "sheet",

    // Slides
    ppt: "slides",
    pptx: "slides",
    odp: "slides",
    key: "slides",

    // Prose
    txt: "text",
    md: "text",
    mdx: "text",
    log: "text",

    // Code
    js: "code",
    mjs: "code",
    cjs: "code",
    jsx: "code",
    ts: "code",
    tsx: "code",
    html: "code",
    htm: "code",
    css: "code",
    scss: "code",
    sass: "code",
    less: "code",
    py: "code",
    rb: "code",
    php: "code",
    java: "code",
    kt: "code",
    swift: "code",
    go: "code",
    rs: "code",
    c: "code",
    h: "code",
    cpp: "code",
    cs: "code",
    sh: "code",
    bash: "code",
    zsh: "code",
    sql: "code",
    vue: "code",
    svelte: "code",

    // Structured data
    json: "data",
    yaml: "data",
    yml: "data",
    toml: "data",
    xml: "data",
    env: "data",

    // Archives
    zip: "archive",
    rar: "archive",
    "7z": "archive",
    tar: "archive",
    gz: "archive",
    tgz: "archive",
    bz2: "archive",
    xz: "archive",

    // 3D
    glb: "model3d",
    gltf: "model3d",
    obj: "model3d",
    stl: "model3d",
    fbx: "model3d",
    dae: "model3d",
    "3ds": "model3d",
    blend: "model3d",
    usdz: "model3d",
    ply: "model3d",

    // Fonts
    ttf: "font",
    otf: "font",
    woff: "font",
    woff2: "font",

    // Design files — the ones people hand a builder as "make it look like this".
    fig: "design",
    sketch: "design",
    xd: "design",
    psd: "design",
    ai: "design",
};

/** MIME → kind, for the files whose extension we do not recognise (or lack). */
function kindFromMime(mime: string): AttachmentKind | null {
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime.startsWith("font/")) return "font";
    if (mime === "application/pdf") return "pdf";
    if (mime.includes("spreadsheet") || mime.includes("excel") || mime === "text/csv") return "sheet";
    if (mime.includes("presentation") || mime.includes("powerpoint")) return "slides";
    if (mime.includes("word") || mime === "application/rtf") return "doc";
    if (mime === "application/json" || mime.endsWith("+json") || mime.includes("xml")) return "data";
    if (mime.includes("zip") || mime.includes("compressed") || mime.includes("tar")) return "archive";
    if (mime === "model/gltf-binary" || mime.startsWith("model/")) return "model3d";
    if (mime.startsWith("text/")) return "text";
    return null;
}

/** The lower-cased extension of a filename, or `""`. Never includes the dot. */
export function fileExtension(name?: string): string {
    if (!name) return "";
    const base = name.split(/[\\/]/).pop() || "";
    const dot = base.lastIndexOf(".");
    // `dot <= 0` covers both "no extension" and dotfiles (`.env` → handled below).
    if (dot < 0) return "";
    return base.slice(dot + 1).toLowerCase();
}

/**
 * What this file is.
 *
 * ⚠️ EXTENSION FIRST, MIME SECOND — the opposite of `support.ts`, and the reason
 * is the source of the files. Support attachments come from a picker restricted to
 * seven types the browser knows well; these come from anywhere, including drops
 * from a terminal and pastes from a design tool, where the MIME is routinely
 * `application/octet-stream` and the name is the only truth.
 */
export function attachmentKind(name?: string, mime?: string): AttachmentKind {
    const extension = fileExtension(name);
    const byExtension = extension ? BY_EXTENSION[extension] : undefined;
    if (byExtension) return byExtension;

    const byMime = mime ? kindFromMime(mime.toLowerCase()) : null;
    if (byMime) return byMime;

    return "file";
}

/** `true` for the kinds we can show a real thumbnail of. */
export function isPreviewableImage(file: { name: string; type: string }): boolean {
    // ⚠️ THE MIME MUST AGREE. `attachmentKind` calls an `.svg` an image so it gets
    // the picture icon, but a same-origin `blob:` SVG rendered in an `<img>` is
    // still a document we did not write — and a file NAMED `.png` that is not one
    // renders as a broken-image glyph. Both cases fall back to the icon plate.
    return file.type.startsWith("image/") && file.type !== "image/svg+xml";
}

// ─────────────────────────────────────────────────────────────────────────────
//  Names and sizes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `1.4 MB`. Sizes only ever come from a `File` the user just picked.
 *
 * ⚠️ THE ONE IMPLEMENTATION — `support.ts` re-exports this rather than keeping the
 * copy it used to have.
 */
export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Two files are "the same" when the browser cannot tell them apart. Dropping the
 * same screenshot twice is a slip, not an intention.
 */
export function isSameFile(a: File, b: File): boolean {
    return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

/**
 * Shorten a filename FROM THE MIDDLE, keeping the extension.
 *
 * ⚠️ CSS `truncate` ALONE IS NOT ENOUGH HERE, and this is the whole reason this
 * function exists: it cuts the END, which is precisely the part that says what the
 * file is. `Q3-2026-revenue-by-region-final-v4.xlsx` becomes
 * `Q3-2026-revenu….xlsx` — you can still tell it is the spreadsheet. Truncated by
 * CSS it becomes `Q3-2026-revenue-by-region-fin…`, which is indistinguishable from
 * the `.pdf` and the `.csv` next to it.
 *
 * The `truncate` class stays on the element regardless: this bounds the string at a
 * sane character count, CSS bounds it at the actual pixel width, and a name made of
 * wide glyphs needs both.
 */
export function truncateFileName(name: string, max = 26): string {
    if (name.length <= max) return name;

    const extension = fileExtension(name);
    // No extension (or an absurd one) — a plain tail ellipsis is all we can do.
    if (!extension || extension.length > 8) return `${name.slice(0, Math.max(1, max - 1))}…`;

    const stem = name.slice(0, name.length - extension.length - 1);
    const room = max - extension.length - 2; // the "…" and the "."
    if (room < 4) return `${name.slice(0, Math.max(1, max - 1))}…`;

    return `${stem.slice(0, room)}….${extension}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Admission
// ─────────────────────────────────────────────────────────────────────────────

export type AttachmentRejection = "TOO_LARGE" | "EMPTY" | "DUPLICATE" | "NO_ROOM";

// ─────────────────────────────────────────────────────────────────────────────
//  The clipboard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The bits of `DataTransfer` this needs. Declared structurally so the rules can be
 * unit-tested — `DataTransfer` and `DataTransferItem` do not exist in Node.
 */
export interface ClipboardLike {
    files?: ArrayLike<File> | null;
    items?: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }> | null;
    types?: ReadonlyArray<string> | null;
    getData?: (format: string) => string;
}

/**
 * The name a clipboard image gets when it has none worth keeping.
 *
 * ⚠️ CLIPBOARD IMAGES ARRIVE CALLED `image.png`, OR CALLED NOTHING AT ALL. Chrome
 * hands every pasted screenshot the identical name; Firefox's `getAsFile()` often
 * hands back an empty one. Both are a problem the tray makes visible: three pastes
 * become three cards labelled `image.png` (or three blank labels), and the user
 * cannot tell which is the one they meant to remove. `attachmentKind` reads the
 * EXTENSION first, so an empty name also loses the picture icon.
 */
const GENERIC_CLIPBOARD_NAMES = new Set(["", "image", "image.png", "unknown", "blob"]);

function clipboardImageName(file: File, ordinal: number): string {
    const current = (file.name || "").trim();
    if (!GENERIC_CLIPBOARD_NAMES.has(current.toLowerCase())) return current;

    // `image/svg+xml` → `svg`, `image/jpeg` → `jpeg`. Never empty.
    const extension = file.type.split("/")[1]?.split("+")[0]?.toLowerCase() || "png";
    return `pasted-image-${ordinal}.${extension}`;
}

/**
 * The files carried by a paste, ready to attach — `[]` when the paste is just text.
 *
 * ⚠️ TWO SOURCES, AND THE SECOND ONE IS THE POINT. `clipboardData.files` is the
 * documented path and it is what the composer used to read, alone. It is empty more
 * often than it looks: a screenshot pasted in Safari, and an image copied out of
 * some Linux/GTK apps, arrive ONLY as a `clipboardData.items` entry with
 * `kind === "file"`. On those paths a Ctrl+V did visibly nothing — no card, no
 * toast, no error — which is exactly the bug this closes.
 *
 * ⚠️ THE `items` FALLBACK IS IMAGES-ONLY AND TEXT-GATED, AND BOTH GUARDS ARE LEAD.
 * Copying a range of cells out of Excel, or a rich-text selection out of Word, puts
 * a RENDERED PNG of that selection on the clipboard next to the text. Scanning
 * `items` unconditionally would attach that screenshot AND — because taking files
 * means calling `preventDefault()` — swallow the text the user was actually pasting.
 * So the fallback only runs when the clipboard has no meaningful `text/plain`, which
 * is precisely the "this paste IS an image" case. `clipboardData.files` stays
 * unconditional: it is populated only by a real file paste, and it was never the
 * source of that ambiguity.
 *
 * ⚠️ IT DOES NOT CHECK THE SIZE. `admitFiles` owns every rule about what may be
 * attached, so a pasted 40 MB PNG is rejected there and gets the same "over 12 MB"
 * toast a dropped one gets. Two places deciding that is two answers to the same
 * question.
 */
export function filesFromClipboard(clipboard: ClipboardLike | null | undefined): File[] {
    if (!clipboard) return [];

    const direct = Array.from(clipboard.files || []);
    if (direct.length) {
        return direct.map((file, index) =>
            renameIfGeneric(file, clipboardImageName(file, index + 1))
        );
    }

    if (hasMeaningfulText(clipboard)) return [];

    const fromItems: File[] = [];
    for (const item of Array.from(clipboard.items || [])) {
        if (item.kind !== "file") continue;
        if (!item.type.toLowerCase().startsWith("image/")) continue;

        const file = item.getAsFile();
        if (file) fromItems.push(file);
    }

    return fromItems.map((file, index) =>
        renameIfGeneric(file, clipboardImageName(file, index + 1))
    );
}

/** `true` when the clipboard carries text the user plausibly meant to paste. */
function hasMeaningfulText(clipboard: ClipboardLike): boolean {
    const types = Array.from(clipboard.types || []);
    if (!types.includes("text/plain")) return false;

    // A `text/plain` of pure whitespace is what some apps attach beside an image;
    // it is not something anyone meant to type into the prompt.
    return (clipboard.getData?.("text/plain") || "").trim().length > 0;
}

/**
 * The same file under a better name, or the same object when the name already is
 * one.
 *
 * ⚠️ IT RETURNS THE ORIGINAL OBJECT WHEN NOTHING CHANGES, which keeps `isSameFile`
 * (name + size + lastModified) working on the ordinary picker and drop paths — a
 * needless `new File()` there would still compare equal, but this way there is
 * nothing to reason about.
 */
function renameIfGeneric(file: File, name: string): File {
    if (name === file.name) return file;
    return new File([file], name, { type: file.type, lastModified: file.lastModified });
}

/**
 * Which of these files may be attached, and why the rest may not.
 *
 * ⚠️ ONE PASS OVER THE WHOLE DROP, NOT A FILTER PER RULE. A 20-file drop onto a
 * composer that has room for three, containing two duplicates and one 40 MB video,
 * has to produce ONE coherent explanation — "3 added, 15 over the limit of 15, 1
 * too large" — rather than a stack of toasts in whatever order the filters ran.
 *
 * ⚠️ THE `NO_ROOM` CHECK COMES LAST for a reason: a duplicate or an oversized file
 * must not consume one of the remaining slots and push a good file out.
 */
export function admitFiles(
    incoming: File[],
    existing: File[],
    max = MAX_ATTACHMENTS
): { accepted: File[]; rejected: { file: File; reason: AttachmentRejection }[] } {
    const accepted: File[] = [];
    const rejected: { file: File; reason: AttachmentRejection }[] = [];
    let room = Math.max(0, max - existing.length);

    for (const file of incoming) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
            rejected.push({ file, reason: "TOO_LARGE" });
            continue;
        }
        // A 0-byte file is almost always a folder dropped by mistake, or a file the
        // OS could not read. Uploading it spends credits on nothing.
        if (file.size === 0) {
            rejected.push({ file, reason: "EMPTY" });
            continue;
        }
        if (
            existing.some(other => isSameFile(other, file)) ||
            accepted.some(other => isSameFile(other, file))
        ) {
            rejected.push({ file, reason: "DUPLICATE" });
            continue;
        }
        if (room <= 0) {
            rejected.push({ file, reason: "NO_ROOM" });
            continue;
        }

        accepted.push(file);
        room -= 1;
    }

    return { accepted, rejected };
}
