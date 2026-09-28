/**
 * Unsplash (STOCK_UNSPLASH). Used only when the operator enabled it with a key.
 *
 * Protects the API terms the operator accepted with the key:
 * - the key goes only in `Authorization: Client-ID …` to api.unsplash.com;
 * - when a photo is actually used, its `download_location` is called (download
 *   tracking is mandatory), and only if it points at api.unsplash.com over https;
 * - credit is required by the API guidelines: author and links carry the
 *   `utm_source=forja&utm_medium=referral` parameters Unsplash asks for.
 * The file itself is served by images.unsplash.com (imgix) at the target width.
 */
import type { AbortSignalLike, ImageAttribution, ImageOrientation } from "@forja/contracts/media";
import { linkedSignal, USER_AGENT, type FetchFn } from "../http.js";
import { HOUR, RateGate } from "../rate-gate.js";
import { gatedGet, posInt, safeHttpUrl, str } from "./common.js";
import type { ImageCandidate, SearchOutcome, SearchProvider, SearchQuery } from "./types.js";

export const UNSPLASH_ENDPOINT = "https://api.unsplash.com/search/photos";
const ORIENTATION: Record<ImageOrientation, string> = { landscape: "landscape", portrait: "portrait", square: "squarish" };

function withUtm(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const u = new URL(url);
  u.searchParams.set("utm_source", "forja");
  u.searchParams.set("utm_medium", "referral");
  return u.toString();
}

interface UnsplashPhoto {
  id?: unknown;
  width?: unknown;
  height?: unknown;
  description?: unknown;
  alt_description?: unknown;
  urls?: { raw?: unknown };
  links?: { html?: unknown; download_location?: unknown };
  user?: { name?: unknown; links?: { html?: unknown } };
  tags?: Array<{ title?: unknown }>;
}

export function parseUnsplash(
  json: unknown,
  targetWidth: number,
  track: (downloadLocation: string, signal: AbortSignalLike) => Promise<void>,
): ImageCandidate[] {
  const results = (json as { results?: UnsplashPhoto[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: ImageCandidate[] = [];
  results.forEach((p, rank) => {
    if (!p || typeof p !== "object") return;
    const raw = safeHttpUrl(p.urls?.raw);
    const w = posInt(p.width);
    const h = posInt(p.height);
    if (!raw || !w || !h) return;
    const url = new URL(raw);
    const width = Math.min(w, targetWidth);
    url.searchParams.set("w", String(width));
    url.searchParams.set("fit", "max");
    url.searchParams.set("q", "80");
    url.searchParams.set("fm", "jpg");
    const attribution: ImageAttribution = {
      provider: "unsplash",
      license: "Unsplash License",
      licenseUrl: "https://unsplash.com/license",
      attributionRequired: true,
    };
    const title = (str(p.alt_description) || str(p.description)).trim();
    if (title) attribution.title = title.slice(0, 200);
    const author = str(p.user?.name).trim();
    if (author) attribution.author = author.slice(0, 200);
    const authorUrl = withUtm(safeHttpUrl(p.user?.links?.html));
    if (authorUrl) attribution.authorUrl = authorUrl;
    const pageUrl = withUtm(safeHttpUrl(p.links?.html));
    if (pageUrl) attribution.pageUrl = pageUrl;
    const location = safeHttpUrl(p.links?.download_location);
    const tags = Array.isArray(p.tags) ? p.tags.map((t) => str(t?.title)).filter(Boolean) : [];
    out.push({
      provider: "unsplash",
      id: str(p.id) || String(rank),
      downloadUrl: url.toString(),
      width,
      height: Math.round((h * width) / w),
      text: [title, str(p.description), ...tags].join(" "),
      attribution,
      rank,
      onChosen: location ? (signal) => track(location, signal) : undefined,
    });
  });
  return out;
}

export function createUnsplashProvider(deps: { fetch: FetchFn; now: () => number; apiKey: string }): SearchProvider {
  // Demo applications get 50 requests/hour; searches and download pings share it.
  const gate = new RateGate([{ windowMs: HOUR, max: 45 }], deps.now);
  const auth = { authorization: `Client-ID ${deps.apiKey}`, "accept-version": "v1" };

  const track = async (location: string, signal: AbortSignalLike): Promise<void> => {
    const u = new URL(location);
    if (u.protocol !== "https:" || u.hostname !== "api.unsplash.com") return;
    gate.tryAcquire(); // counted, but never skipped: the terms require it
    const { signal: s, dispose } = linkedSignal(signal, 10_000);
    try {
      const res = await deps.fetch(u.toString(), { headers: { ...auth, "user-agent": USER_AGENT }, redirect: "error", signal: s });
      await res.body?.cancel().catch(() => {});
    } finally {
      dispose();
    }
  };

  return {
    id: "unsplash",
    async search(q: SearchQuery): Promise<SearchOutcome> {
      const url = new URL(UNSPLASH_ENDPOINT);
      url.searchParams.set("query", q.query);
      url.searchParams.set("per_page", "20");
      url.searchParams.set("content_filter", "high");
      if (q.orientation) url.searchParams.set("orientation", ORIENTATION[q.orientation]);
      const res = await gatedGet(gate, deps.fetch, url.toString(), { headers: auth, signal: q.signal, now: deps.now });
      if (!res.ok) return res;
      return { ok: true, candidates: parseUnsplash(res.json, q.targetWidth, track) };
    },
  };
}
