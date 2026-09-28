/**
 * `public/images/credits.json`: what the generated app renders as image credits.
 *
 * Protects: one entry per slot, replaced when the slot is found again, so the file never
 * accumulates credits for images that are no longer used. Entries the file already had
 * and this code does not own (no `slot`) are kept as they are. Order is by slot, so the
 * file diffs cleanly between runs. `path` is the URL the app uses (`/images/hero.jpg`).
 */
import type { ImageAttribution } from "@forja/contracts/media";

export const IMAGES_DIR = "public/images";
export const CREDITS_PATH = `${IMAGES_DIR}/credits.json`;

export interface CreditEntry {
  slot: string;
  /** Public URL path, e.g. `/images/hero.jpg`. */
  path: string;
  alt: string;
  attribution: ImageAttribution;
}

/** Parses the current file content; anything unreadable counts as empty. */
export function parseCredits(bytes: Uint8Array | null | undefined): unknown[] {
  if (!bytes || bytes.byteLength === 0) return [];
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return Array.isArray(json) ? json.filter((e) => e !== null && typeof e === "object") : [];
  } catch {
    return [];
  }
}

export function mergeCredits(existing: unknown[], entry: CreditEntry): unknown[] {
  const slotOf = (e: unknown): string | null => {
    const s = (e as { slot?: unknown }).slot;
    return typeof s === "string" ? s : null;
  };
  const pathOf = (e: unknown): string | null => {
    const p = (e as { path?: unknown }).path;
    return typeof p === "string" ? p : null;
  };
  const kept = existing.filter((e) => slotOf(e) !== entry.slot && pathOf(e) !== entry.path);
  const owned = [...kept.filter((e) => slotOf(e) !== null), entry].sort((a, b) =>
    (slotOf(a) ?? "").localeCompare(slotOf(b) ?? ""),
  );
  return [...kept.filter((e) => slotOf(e) === null), ...owned];
}

export function serializeCredits(entries: unknown[]): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(entries, null, 2)}\n`);
}
