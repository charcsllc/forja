/**
 * Openverse (https://api.openverse.org/v1/images/), keyless.
 *
 * Protects: only licenses that allow commercial use AND modification are requested and,
 * again, accepted from the answer: CC0, Public Domain Mark, CC BY, CC BY-SA. Mature
 * results are excluded. SVG results are dropped (the downloader would refuse them anyway).
 * Anonymous limits (20/min burst, 200/day sustained, reported in `x-ratelimit-*`
 * headers) are mirrored locally with a margin, and a header saying zero requests are
 * left cools the provider down until the window has passed.
 */
import type { ImageAttribution, ImageOrientation } from "@forja/contracts/media";
import type { FetchFn } from "../http.js";
import { DAY, HOUR, MINUTE, RateGate } from "../rate-gate.js";
import { gatedGet, posInt, safeHttpUrl, str } from "./common.js";
import type { ImageCandidate, SearchOutcome, SearchProvider, SearchQuery } from "./types.js";

export const OPENVERSE_ENDPOINT = "https://api.openverse.org/v1/images/";

const LICENSES: Record<string, { name: string; attributionRequired: boolean }> = {
  cc0: { name: "CC0", attributionRequired: false },
  pdm: { name: "Public Domain Mark", attributionRequired: false },
  by: { name: "CC BY", attributionRequired: true },
  "by-sa": { name: "CC BY-SA", attributionRequired: true },
};

const ASPECT: Record<ImageOrientation, string> = { landscape: "wide", portrait: "tall", square: "square" };
const BITMAP_TYPES = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

interface OpenverseResult {
  id?: unknown;
  title?: unknown;
  foreign_landing_url?: unknown;
  url?: unknown;
  creator?: unknown;
  creator_url?: unknown;
  license?: unknown;
  license_version?: unknown;
  license_url?: unknown;
  filetype?: unknown;
  mature?: unknown;
  width?: unknown;
  height?: unknown;
  tags?: Array<{ name?: unknown }> | null;
}

export function parseOpenverse(json: unknown): ImageCandidate[] {
  const results = (json as { results?: OpenverseResult[] } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: ImageCandidate[] = [];
  results.forEach((r, rank) => {
    if (!r || typeof r !== "object") return;
    const license = LICENSES[str(r.license)];
    const downloadUrl = safeHttpUrl(r.url);
    if (!license || !downloadUrl || r.mature === true) return;
    const filetype = str(r.filetype).toLowerCase();
    const ext = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(new URL(downloadUrl).pathname)?.[1]?.toLowerCase() ?? "";
    if ((filetype && !BITMAP_TYPES.has(filetype)) || ext === "svg") return;
    const version = str(r.license_version);
    const attribution: ImageAttribution = {
      provider: "openverse",
      license: version && str(r.license) !== "pdm" ? `${license.name} ${version}` : license.name,
      attributionRequired: license.attributionRequired,
    };
    const title = str(r.title).trim();
    if (title) attribution.title = title.slice(0, 200);
    const author = str(r.creator).trim();
    if (author) attribution.author = author.slice(0, 200);
    const authorUrl = safeHttpUrl(r.creator_url);
    if (authorUrl) attribution.authorUrl = authorUrl;
    const pageUrl = safeHttpUrl(r.foreign_landing_url);
    if (pageUrl) attribution.pageUrl = pageUrl;
    const licenseUrl = safeHttpUrl(r.license_url);
    if (licenseUrl) attribution.licenseUrl = licenseUrl;
    const tags = Array.isArray(r.tags) ? r.tags.map((t) => str(t?.name)).filter(Boolean) : [];
    out.push({
      provider: "openverse",
      id: str(r.id) || String(rank),
      downloadUrl,
      width: posInt(r.width),
      height: posInt(r.height),
      text: [title, ...tags].join(" "),
      attribution,
      rank,
    });
  });
  return out;
}

export function openverseUrl(q: Pick<SearchQuery, "query" | "orientation">): string {
  const url = new URL(OPENVERSE_ENDPOINT);
  url.searchParams.set("q", q.query);
  url.searchParams.set("license", "cc0,pdm,by,by-sa");
  url.searchParams.set("mature", "false");
  url.searchParams.set("page_size", "20");
  if (q.orientation) url.searchParams.set("aspect_ratio", ASPECT[q.orientation]);
  return url.toString();
}

export function createOpenverseProvider(deps: { fetch: FetchFn; now: () => number }): SearchProvider {
  // Margins under the published anonymous limits (20/min, 200/day).
  const gate = new RateGate(
    [
      { windowMs: MINUTE, max: 15 },
      { windowMs: DAY, max: 180 },
    ],
    deps.now,
  );
  return {
    id: "openverse",
    async search(q: SearchQuery): Promise<SearchOutcome> {
      const res = await gatedGet(gate, deps.fetch, openverseUrl(q), { signal: q.signal, now: deps.now });
      if (!res.ok) return res;
      if (res.headers.get("x-ratelimit-available-anon_sustained") === "0") gate.coolDown(HOUR);
      else if (res.headers.get("x-ratelimit-available-anon_burst") === "0") gate.coolDown(MINUTE);
      return { ok: true, candidates: parseOpenverse(res.json) };
    },
  };
}
