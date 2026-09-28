/**
 * Wikimedia Commons (MediaWiki Action API), keyless.
 *
 * Protects: only free licenses that allow commercial use and modification are kept,
 * judged from `extmetadata.License` (CC0, public domain `pd*`, CC BY and CC BY-SA in any
 * version or port); anything marked `NonFree`, and any NC/ND variant, is dropped. The
 * file is fetched at a standard thumbnail width (Commons pre-renders 960/1280/1920/3840
 * and discourages arbitrary widths); when the original is smaller, Commons serves the
 * original and the candidate's size says so. Author credit comes from `Artist`, which is
 * HTML: it is reduced to text and its first link.
 */
import type { ImageAttribution } from "@forja/contracts/media";
import type { FetchFn } from "../http.js";
import { MINUTE, RateGate } from "../rate-gate.js";
import { firstHref, gatedGet, htmlToText, posInt, safeHttpUrl, str } from "./common.js";
import type { ImageCandidate, SearchOutcome, SearchProvider, SearchQuery } from "./types.js";

export const WIKIMEDIA_ENDPOINT = "https://commons.wikimedia.org/w/api.php";
const STANDARD_WIDTHS = [960, 1280, 1920, 3840] as const;
const MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff"]);
const EXT_FIELDS = ["LicenseShortName", "LicenseUrl", "License", "UsageTerms", "AttributionRequired", "Artist", "ObjectName", "ImageDescription", "NonFree", "Copyrighted"];

export function standardThumbWidth(target: number): number {
  return STANDARD_WIDTHS.find((w) => w >= target) ?? 3840;
}

/** `{name, attributionRequired}` for a free license id, or null. */
export function wikimediaLicense(id: string): { name: string; attributionRequired: boolean } | null {
  const v = id.trim().toLowerCase();
  if (!v || /(^|-)nc(-|$)|(^|-)nd(-|$)/.test(v)) return null;
  if (v === "cc0" || v.startsWith("cc-zero")) return { name: "CC0", attributionRequired: false };
  if (v === "pd" || v.startsWith("pd-") || v === "public domain") return { name: "Public domain", attributionRequired: false };
  const m = /^cc-by(-sa)?(?:-(\d(?:\.\d)?))?(?:-[a-z]{2,}(?:-[a-z]+)*)?$/.exec(v);
  if (m) return { name: `CC BY${m[1] ? "-SA" : ""}${m[2] ? ` ${m[2]}` : ""}`, attributionRequired: true };
  return null;
}

type Meta = Record<string, { value?: unknown } | undefined>;

interface WikiPage {
  pageid?: unknown;
  title?: unknown;
  index?: unknown;
  imageinfo?: Array<{
    width?: unknown;
    height?: unknown;
    thumburl?: unknown;
    thumbwidth?: unknown;
    thumbheight?: unknown;
    url?: unknown;
    descriptionurl?: unknown;
    mime?: unknown;
    extmetadata?: Meta;
  }>;
}

export function parseWikimedia(json: unknown): ImageCandidate[] {
  const pages = (json as { query?: { pages?: WikiPage[] } } | null)?.query?.pages;
  if (!Array.isArray(pages)) return [];
  const sorted = pages.filter((p) => p && typeof p === "object").sort((a, b) => posInt(a.index) - posInt(b.index));
  const out: ImageCandidate[] = [];
  sorted.forEach((p, rank) => {
    if (!p || typeof p !== "object") return;
    const info = p.imageinfo?.[0];
    if (!info || !MIMES.has(str(info.mime))) return;
    const meta: Meta = info.extmetadata ?? {};
    const value = (k: string) => meta[k]?.value;
    if (str(value("NonFree")).toLowerCase() === "true") return;
    const license = wikimediaLicense(htmlToText(value("License")));
    if (!license) return;
    const downloadUrl = safeHttpUrl(info.thumburl) ?? safeHttpUrl(info.url);
    if (!downloadUrl) return;
    const origW = posInt(info.width);
    const origH = posInt(info.height);
    const thumbW = posInt(info.thumbwidth);
    const upscaled = !thumbW || thumbW >= origW;
    const width = upscaled ? origW : thumbW;
    const height = upscaled ? origH : posInt(info.thumbheight);

    const shortName = htmlToText(value("LicenseShortName"));
    const attrRequired = str(value("AttributionRequired")).toLowerCase();
    const attribution: ImageAttribution = {
      provider: "wikimedia",
      license: shortName || license.name,
      attributionRequired: attrRequired === "false" ? false : attrRequired === "true" ? true : license.attributionRequired,
    };
    const title = htmlToText(value("ObjectName")) || str(p.title).replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "");
    if (title) attribution.title = title.slice(0, 200);
    const author = htmlToText(value("Artist"));
    if (author) attribution.author = author.slice(0, 200);
    const authorUrl = firstHref(value("Artist"));
    if (authorUrl) attribution.authorUrl = authorUrl;
    const pageUrl = safeHttpUrl(info.descriptionurl);
    if (pageUrl) attribution.pageUrl = pageUrl;
    const licenseUrl = safeHttpUrl(htmlToText(value("LicenseUrl")));
    if (licenseUrl) attribution.licenseUrl = licenseUrl;

    out.push({
      provider: "wikimedia",
      id: String(posInt(p.pageid) || rank),
      downloadUrl,
      width,
      height,
      text: [title, htmlToText(value("ImageDescription"))].join(" "),
      attribution,
      rank,
    });
  });
  return out;
}

export function wikimediaUrl(q: Pick<SearchQuery, "query" | "targetWidth">): string {
  const url = new URL(WIKIMEDIA_ENDPOINT);
  const p = url.searchParams;
  p.set("action", "query");
  p.set("format", "json");
  p.set("formatversion", "2");
  p.set("generator", "search");
  p.set("gsrsearch", `${q.query} filetype:bitmap`);
  p.set("gsrnamespace", "6");
  p.set("gsrlimit", "20");
  p.set("prop", "imageinfo");
  p.set("iiprop", "url|size|mime|extmetadata");
  p.set("iiurlwidth", String(standardThumbWidth(q.targetWidth)));
  p.set("iiextmetadatafilter", EXT_FIELDS.join("|"));
  p.set("iiextmetadatalanguage", "en");
  return url.toString();
}

export function createWikimediaProvider(deps: { fetch: FetchFn; now: () => number }): SearchProvider {
  // Wikimedia asks for serial, identified requests; no published hard limit for reads.
  const gate = new RateGate([{ windowMs: MINUTE, max: 30 }], deps.now);
  return {
    id: "wikimedia",
    async search(q: SearchQuery): Promise<SearchOutcome> {
      const res = await gatedGet(gate, deps.fetch, wikimediaUrl(q), { signal: q.signal, now: deps.now });
      if (!res.ok) return res;
      return { ok: true, candidates: parseWikimedia(res.json) };
    },
  };
}
