/**
 * Candidate ranking without vision.
 *
 * Protects: the choice is deterministic (same candidates, same query → same order) and
 * explainable from four signals only:
 *   1. orientation: the requested one matches the candidate's aspect ratio;
 *   2. width: at least `minWidth` (a hard preference, not a filter: a small image beats
 *      no image, but never beats a big-enough one with the right orientation);
 *   3. size: more pixels up to twice `minWidth`, then no further bonus (bigger is only
 *      heavier);
 *   4. relevance: share of the query's content words found in title, tags, description.
 * Ties break on the provider's own rank, then the provider id and candidate id.
 */
import type { ImageOrientation } from "@forja/contracts/media";
import type { ImageCandidate } from "./providers/types.js";

const STOPWORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with", "without",
  "photo", "photograph", "image", "picture", "stock", "high", "quality", "background",
]);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Crude singular form so "shops" matches "shop". */
const stem = (t: string): string => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t);

export function orientationOf(width: number, height: number): ImageOrientation | null {
  if (!width || !height) return null;
  const r = width / height;
  return r >= 1.15 ? "landscape" : r <= 0.87 ? "portrait" : "square";
}

export interface ScoredCandidate {
  candidate: ImageCandidate;
  score: number;
  /** Meets orientation (if asked) and min width, and matches at least one query word. */
  good: boolean;
  relevance: number;
}

export function scoreCandidate(c: ImageCandidate, query: string, opts: { orientation?: ImageOrientation; minWidth: number }): ScoredCandidate {
  const q = [...new Set(tokens(query).map(stem))];
  const have = new Set(tokens(c.text).map(stem));
  const relevance = q.length === 0 ? 0 : q.filter((t) => have.has(t)).length / q.length;

  const shape = orientationOf(c.width, c.height);
  const orientationOk = !opts.orientation || shape === opts.orientation;
  const widthOk = c.width >= opts.minWidth;

  let score = 0;
  score += orientationOk ? 3 : shape === null ? 0 : -3;
  score += widthOk ? 2 : -4 * (1 - c.width / Math.max(1, opts.minWidth));
  score += Math.min(c.width / Math.max(1, opts.minWidth), 2) * 0.5;
  score += relevance * 4;
  return { candidate: c, score, good: orientationOk && widthOk && relevance > 0, relevance };
}

export function rankCandidates(candidates: ImageCandidate[], query: string, opts: { orientation?: ImageOrientation; minWidth: number }): ScoredCandidate[] {
  return candidates
    .map((c) => scoreCandidate(c, query, opts))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.candidate.rank - b.candidate.rank ||
        a.candidate.provider.localeCompare(b.candidate.provider) ||
        a.candidate.id.localeCompare(b.candidate.id),
    );
}
