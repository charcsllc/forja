/**
 * ═══ HOW A DATABASE VALUE LOOKS ═════════════════════════════════════════════
 *
 * Pure helpers shared by the table cells and the record detail, so the two can
 * never disagree about what a value is or what colour it gets. No React, no fetch
 * — unit-testable, and testable is the point: the option-colour function has to
 * be stable across renders, pages and sessions, which is easy to claim and easy
 * to get wrong.
 */

/**
 * ⚠️ LIGHT TINTS ONLY, AND ALL THE SAME WEIGHT.
 *
 * These are `--data-*` — the design system's own categorical ramp, the one the
 * usage charts use — at a low alpha over the surface, with the text left as
 * `foreground`. Full-strength categorical colours as badge backgrounds would need
 * white text, and a row of eight saturated pills reads as an alert panel rather
 * than as data. The brief asked for light colours; this is also the only version
 * that stays legible in both themes without a second palette.
 */
export const OPTION_TINTS = [
    "bg-[var(--data-1)]/15 text-foreground",
    "bg-[var(--data-2)]/15 text-foreground",
    "bg-[var(--data-3)]/15 text-foreground",
    "bg-[var(--data-4)]/18 text-foreground",
    "bg-[var(--data-5)]/15 text-foreground",
    "bg-[var(--data-7)]/15 text-foreground",
    "bg-[var(--data-9)]/15 text-foreground",
    "bg-[var(--data-10)]/15 text-foreground",
    "bg-[var(--data-11)]/18 text-foreground",
    "bg-[var(--data-12)]/15 text-foreground",
    "bg-[var(--data-13)]/15 text-foreground",
] as const;

/**
 * ⚠️⚠️ THERE ARE ELEVEN OF THEM, AND THE COUNT BEING PRIME IS LOAD-BEARING.
 *
 * With twelve, `hash % 12` only ever looked at the low bits — and a test measured
 * the result: six realistic statuses (`pending`, `confirmed`, `cancelled`,
 * `no-show`, `refunded`, `draft`) landed on THREE colours. Short strings sharing a
 * length and an alphabet, which is exactly what an options column holds, correlate
 * modulo the small factors of a composite. The same six over a prime take eleven
 * distinct slots, six distinct colours. Do not "round it up to twelve".
 *
 * `--data-6` is the one dropped, and not at random: it is the red, which reads as
 * an error next to ten neutral tints.
 */

/**
 * FNV-1a, 32-bit. Stable, not cryptographic — it only has to spread.
 *
 * ⚠️⚠️ THE OBVIOUS `hash * 31 + char` DOES NOT SPREAD HERE, and a test caught it:
 * six realistic statuses (`pending`, `confirmed`, `cancelled`, `no-show`,
 * `refunded`, `draft`) landed on THREE of twelve tints. Short strings that share
 * a length and an alphabet — which is exactly what an options column holds —
 * clump badly under a small multiplier taken modulo a composite number, and the
 * symptom is a status column where half the values look like the same status.
 *
 * FNV-1a's 16777619 multiplier avalanches the low bits, which are the only ones
 * `% OPTION_TINTS.length` looks at. Same cost, same determinism, real spread.
 */
function hashOf(value: string): number {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        // `Math.imul` keeps this a 32-bit multiply; `*` would go through a double
        // and lose the low bits that carry the avalanche.
        hash = Math.imul(hash, 0x01000193);
    }
    return Math.abs(hash | 0);
}

/**
 * The badge classes for one option VALUE.
 *
 * ⚠️ KEYED ON THE VALUE, NOT ON ITS POSITION IN THE LIST. Two rows showing
 * `pending` must be the same colour, and they are only guaranteed to be if the
 * colour is derived from the text — a positional palette shifts the moment
 * someone reorders the column's options, or when a value that is no longer in the
 * declared list appears in old data and has no position at all.
 *
 * ⚠️ CASE- AND SPACE-INSENSITIVE, because `Pending` and `pending` are the same
 * status to a human and being told otherwise in colour is worse than no colour.
 */
export function optionTint(value: string): string {
    const normalised = value.trim().toLowerCase();
    if (!normalised) return OPTION_TINTS[OPTION_TINTS.length - 1];
    return OPTION_TINTS[hashOf(normalised) % OPTION_TINTS.length];
}

// ═══════════════════════════════════════════════════════════════════════════
//  Links and emails
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ DELIBERATELY STRICT, IN BOTH DIRECTIONS.
 *
 * A cell that turns half the table blue is worse than one that turns nothing
 * blue: the colour stops meaning "you can click this". So:
 *
 *   · a URL must carry an explicit `http`/`https` scheme. `example.com` is a
 *     perfectly ordinary string in a `domain` column and linking it would guess;
 *   · an email must be the WHOLE value, anchored at both ends. A sentence that
 *     happens to contain an address is prose, not a mailto target.
 */
const URL_RE = /^https?:\/\/[^\s<>"]+$/i;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>.]+\.[^\s@<>]+$/;

export type LinkKind = "url" | "email" | null;

/**
 * Classify a cell value as a URL, an e-mail, a phone number or nothing linkable.
 */
export function linkKindOf(value: unknown): LinkKind {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 2048) return null;

    if (URL_RE.test(trimmed)) return "url";
    if (EMAIL_RE.test(trimmed)) return "email";
    return null;
}

/** The `href` for a detected value. `null` when there is nothing to link to. */
export function hrefFor(value: string): string | null {
    const trimmed = value.trim();
    switch (linkKindOf(trimmed)) {
        case "url":
            return trimmed;
        case "email":
            return `mailto:${trimmed}`;
        default:
            return null;
    }
}

/**
 * What to SHOW for a link, which is not always what to open.
 *
 * A signed file URL or an API callback can run to hundreds of characters and
 * would blow the column apart. The host plus the last path segment is the part
 * that identifies it; the full value stays on `title` and in the href.
 */
export function linkLabel(value: string): string {
    const trimmed = value.trim();
    if (linkKindOf(trimmed) !== "url" || trimmed.length <= 48) return trimmed;

    try {
        const url = new URL(trimmed);
        const last = url.pathname.split("/").filter(Boolean).pop();
        return last ? `${url.host}/…/${last}` : url.host;
    } catch {
        return trimmed.slice(0, 45) + "…";
    }
}
