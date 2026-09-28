/**
 * Pixabay (STOCK_PIXABAY). Used only when the operator enabled it with a key.
 *
 * Protects: Pixabay takes its key as a query parameter, so that URL is built here and
 * never logged or returned; the download URL (`largeImageURL`, up to 1280 px) carries no
 * key. Content License: free for commercial use and modification, no credit required;
 * the author is still recorded. Pixabay forbids hotlinking: the file is copied into the
 * project, which is what the downloader does anyway.
 */
import type { ImageAttribution, ImageOrientation } from "@forja/contracts/media";
import type { FetchFn } from "../http.js";
import { MINUTE, RateGate } from "../rate-gate.js";
import { gatedGet, posInt, safeHttpUrl, str } from "./common.js";
import type { ImageCandidate, SearchOutcome, SearchProvider, SearchQuery } from "./types.js";

export const PIXABAY_ENDPOINT = "https://pixabay.com/api/";
const LARGE_MAX = 1280;
const ORIENTATION: Record<ImageOrientation, string> = { landscape: "horizontal", portrait: "vertical", square: "all" };

interface PixabayHit {
  id?: unknown;
  pageURL?: unknown;
  tags?: unknown;
  largeImageURL?: unknown;
  imageWidth?: unknown;
  imageHeight?: unknown;
  user?: unknown;
  user_id?: unknown;
}

export function parsePixabay(json: unknown): ImageCandidate[] {
  const hits = (json as { hits?: PixabayHit[] } | null)?.hits;
  if (!Array.isArray(hits)) return [];
  const out: ImageCandidate[] = [];
  hits.forEach((h, rank) => {
    if (!h || typeof h !== "object") return;
    const downloadUrl = safeHttpUrl(h.largeImageURL);
    const w = posInt(h.imageWidth);
    const hh = posInt(h.imageHeight);
    if (!downloadUrl || !w || !hh) return;
    const scale = Math.min(1, LARGE_MAX / Math.max(w, hh));
    const attribution: ImageAttribution = {
      provider: "pixabay",
      license: "Pixabay Content License",
      licenseUrl: "https://pixabay.com/service/license-summary/",
      attributionRequired: false,
    };
    const user = str(h.user).trim();
    if (user) {
      attribution.author = user.slice(0, 200);
      const uid = posInt(h.user_id);
      if (uid && /^[A-Za-z0-9_.-]+$/.test(user)) attribution.authorUrl = `https://pixabay.com/users/${user}-${uid}/`;
    }
    const pageUrl = safeHttpUrl(h.pageURL);
    if (pageUrl) attribution.pageUrl = pageUrl;
    out.push({
      provider: "pixabay",
      id: String(posInt(h.id) || rank),
      downloadUrl,
      width: Math.round(w * scale),
      height: Math.round(hh * scale),
      text: str(h.tags).replace(/,/g, " "),
      attribution,
      rank,
    });
  });
  return out;
}

export function createPixabayProvider(deps: { fetch: FetchFn; now: () => number; apiKey: string }): SearchProvider {
  const gate = new RateGate([{ windowMs: MINUTE, max: 90 }], deps.now);
  return {
    id: "pixabay",
    async search(q: SearchQuery): Promise<SearchOutcome> {
      const url = new URL(PIXABAY_ENDPOINT);
      url.searchParams.set("key", deps.apiKey);
      url.searchParams.set("q", q.query.slice(0, 100));
      url.searchParams.set("image_type", "photo");
      url.searchParams.set("safesearch", "true");
      url.searchParams.set("per_page", "20");
      if (q.orientation) url.searchParams.set("orientation", ORIENTATION[q.orientation]);
      const res = await gatedGet(gate, deps.fetch, url.toString(), { signal: q.signal, now: deps.now });
      if (!res.ok) return res;
      return { ok: true, candidates: parsePixabay(res.json) };
    },
  };
}
