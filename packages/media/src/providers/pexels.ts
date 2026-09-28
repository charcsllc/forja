/**
 * Pexels (STOCK_PEXELS). Used only when the operator enabled it with a key.
 *
 * Protects: the key travels only in the `Authorization` header to api.pexels.com, never
 * in a URL, a log line or an attribution. Photos are under the Pexels License (free for
 * commercial use and modification, credit appreciated, not required); the photographer
 * is still recorded. The file is requested at the target width through Pexels' own
 * resizer on the original URL.
 */
import type { ImageAttribution, ImageOrientation } from "@forja/contracts/media";
import type { FetchFn } from "../http.js";
import { HOUR, RateGate } from "../rate-gate.js";
import { gatedGet, posInt, safeHttpUrl, str } from "./common.js";
import type { ImageCandidate, SearchOutcome, SearchProvider, SearchQuery } from "./types.js";

export const PEXELS_ENDPOINT = "https://api.pexels.com/v1/search";
const ORIENTATION: Record<ImageOrientation, string> = { landscape: "landscape", portrait: "portrait", square: "square" };

interface PexelsPhoto {
  id?: unknown;
  width?: unknown;
  height?: unknown;
  url?: unknown;
  photographer?: unknown;
  photographer_url?: unknown;
  alt?: unknown;
  src?: { original?: unknown };
}

export function parsePexels(json: unknown, targetWidth: number): ImageCandidate[] {
  const photos = (json as { photos?: PexelsPhoto[] } | null)?.photos;
  if (!Array.isArray(photos)) return [];
  const out: ImageCandidate[] = [];
  photos.forEach((p, rank) => {
    if (!p || typeof p !== "object") return;
    const original = safeHttpUrl(p.src?.original);
    const w = posInt(p.width);
    const h = posInt(p.height);
    if (!original || !w || !h) return;
    const url = new URL(original);
    url.searchParams.set("auto", "compress");
    url.searchParams.set("cs", "tinysrgb");
    const width = Math.min(w, targetWidth);
    url.searchParams.set("w", String(width));
    const attribution: ImageAttribution = {
      provider: "pexels",
      license: "Pexels License",
      licenseUrl: "https://www.pexels.com/license/",
      attributionRequired: false,
    };
    const alt = str(p.alt).trim();
    if (alt) attribution.title = alt.slice(0, 200);
    const author = str(p.photographer).trim();
    if (author) attribution.author = author.slice(0, 200);
    const authorUrl = safeHttpUrl(p.photographer_url);
    if (authorUrl) attribution.authorUrl = authorUrl;
    const pageUrl = safeHttpUrl(p.url);
    if (pageUrl) attribution.pageUrl = pageUrl;
    out.push({
      provider: "pexels",
      id: String(posInt(p.id) || rank),
      downloadUrl: url.toString(),
      width,
      height: Math.round((h * width) / w),
      text: alt,
      attribution,
      rank,
    });
  });
  return out;
}

export function createPexelsProvider(deps: { fetch: FetchFn; now: () => number; apiKey: string }): SearchProvider {
  const gate = new RateGate([{ windowMs: HOUR, max: 180 }], deps.now);
  return {
    id: "pexels",
    async search(q: SearchQuery): Promise<SearchOutcome> {
      const url = new URL(PEXELS_ENDPOINT);
      url.searchParams.set("query", q.query);
      url.searchParams.set("per_page", "20");
      if (q.orientation) url.searchParams.set("orientation", ORIENTATION[q.orientation]);
      const res = await gatedGet(gate, deps.fetch, url.toString(), {
        headers: { authorization: deps.apiKey },
        signal: q.signal,
        now: deps.now,
      });
      if (!res.ok) return res;
      return { ok: true, candidates: parsePexels(res.json, q.targetWidth) };
    },
  };
}
