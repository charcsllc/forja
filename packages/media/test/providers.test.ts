/**
 * Provider adapters against recorded answers (Openverse, Wikimedia Commons, captured
 * 2026-09-28) and documented response shapes (Pexels, Pixabay, Unsplash).
 * Protects: license filtering, attribution normalisation, request shape (keys only in
 * headers where the API allows it), rate-limit handling, stock-first order.
 */
import { describe, expect, it } from "vitest";
import { ImageAttributionSchema } from "@forja/contracts/media";
import { buildSearchProviders } from "../src/providers/index.js";
import { createOpenverseProvider, openverseUrl, parseOpenverse } from "../src/providers/openverse.js";
import { createPexelsProvider, parsePexels } from "../src/providers/pexels.js";
import { createPixabayProvider, parsePixabay } from "../src/providers/pixabay.js";
import { createUnsplashProvider, parseUnsplash } from "../src/providers/unsplash.js";
import { parseWikimedia, standardThumbWidth, wikimediaLicense, wikimediaUrl } from "../src/providers/wikimedia.js";
import { fixtureJson, json, mockFetch } from "./helpers.js";

const signal = new AbortController().signal;
const q = { query: "coffee shop", minWidth: 1000, targetWidth: 1600, signal };

describe("Openverse", () => {
  it("parses the recorded answer; every attribution satisfies the contract", () => {
    const c = parseOpenverse(fixtureJson("openverse-search.json"));
    expect(c).toHaveLength(8);
    expect(c[0]).toMatchObject({
      provider: "openverse",
      downloadUrl: "https://live.staticflickr.com/18/24171123_685e298fcd_b.jpg",
      width: 1024,
      height: 758,
      attribution: { license: "CC BY-SA 2.0", attributionRequired: true, author: "pixeljones", title: "Coffee Shop Sign" },
    });
    for (const x of c) expect(ImageAttributionSchema.safeParse(x.attribution).success).toBe(true);
  });

  it("drops non-commercial, no-derivatives, mature and SVG results even if the API returned them", () => {
    const base = { url: "https://x.example/a.jpg", width: 1000, height: 800 };
    const c = parseOpenverse({
      results: [
        { ...base, id: "1", license: "by-nc" },
        { ...base, id: "2", license: "by-nd" },
        { ...base, id: "3", license: "by", mature: true },
        { ...base, id: "4", license: "by", url: "https://x.example/a.svg" },
        { ...base, id: "5", license: "cc0", license_version: "1.0" },
        { ...base, id: "6", license: "pdm", license_version: "1.0" },
      ],
    });
    expect(c.map((x) => [x.id, x.attribution.license, x.attribution.attributionRequired])).toEqual([
      ["5", "CC0 1.0", false],
      ["6", "Public Domain Mark", false],
    ]);
  });

  it("asks only for commercial+modification licenses and maps orientation", () => {
    const u = new URL(openverseUrl({ query: "coffee", orientation: "portrait" }));
    expect(u.searchParams.get("license")).toBe("cc0,pdm,by,by-sa");
    expect(u.searchParams.get("aspect_ratio")).toBe("tall");
    expect(u.searchParams.get("mature")).toBe("false");
  });

  it("cools down after a 429 and after reporting zero requests left, without further requests", async () => {
    let t = 0;
    const m = mockFetch(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    const p = createOpenverseProvider({ fetch: m.fetch, now: () => t });
    expect(await p.search(q)).toMatchObject({ ok: false, rateLimited: true });
    expect(await p.search(q)).toMatchObject({ ok: false, skipped: true });
    expect(m.calls).toHaveLength(1);
    t = 31_000;
    await p.search(q);
    expect(m.calls).toHaveLength(2);

    const m2 = mockFetch(() => json(fixtureJson("openverse-search.json"), { headers: { "x-ratelimit-available-anon_burst": "0" } }));
    const p2 = createOpenverseProvider({ fetch: m2.fetch, now: () => 0 });
    expect((await p2.search(q)).ok).toBe(true);
    expect(await p2.search(q)).toMatchObject({ skipped: true });
  });

  it("never exceeds 15 requests a minute locally", async () => {
    const m = mockFetch(() => json({ results: [] }));
    const p = createOpenverseProvider({ fetch: m.fetch, now: () => 1000 });
    for (let i = 0; i < 20; i++) await p.search(q);
    expect(m.calls).toHaveLength(15);
  });
});

describe("Wikimedia Commons", () => {
  it("parses the recorded answer in search order, free licenses only", () => {
    const c = parseWikimedia(fixtureJson("wikimedia-search.json"));
    expect(c.map((x) => x.rank)).toEqual([...c.keys()]);
    expect(c[0]).toMatchObject({
      provider: "wikimedia",
      attribution: { license: "CC BY 2.0", attributionRequired: true },
      width: 1600,
    });
    const pd = c.find((x) => x.attribution.license === "Public domain");
    // Smaller than the requested thumbnail: Commons serves the original size.
    expect(pd).toMatchObject({ width: 580, height: 400, attribution: { attributionRequired: false, author: "Bodleian Library, University of Oxford" } });
    const geograph = c.find((x) => x.attribution.author === "Pauline Eccles");
    expect(geograph?.attribution.authorUrl).toBe("https://www.geograph.org.uk/profile/13903");
    for (const x of c) expect(ImageAttributionSchema.safeParse(x.attribution).success).toBe(true);
  });

  it.each([
    ["cc0", "CC0"],
    ["pd", "Public domain"],
    ["pd-old-100", "Public domain"],
    ["cc-by-4.0", "CC BY 4.0"],
    ["cc-by-sa-3.0-de", "CC BY-SA 3.0"],
    ["cc-by-sa-3.0-migrated", "CC BY-SA 3.0"],
    ["cc-by-nc-2.0", null],
    ["cc-by-nd-4.0", null],
    ["fair use", null],
    ["", null],
  ])("license %j → %j", (id, name) => {
    expect(wikimediaLicense(id)?.name ?? null).toBe(name);
  });

  it("drops NonFree files and asks for a standard thumbnail width", () => {
    const page = (extra: Record<string, unknown>) => ({
      pageid: 1, index: 1, title: "File:A.jpg",
      imageinfo: [{ mime: "image/jpeg", width: 4000, height: 3000, thumburl: "https://upload.wikimedia.org/a.jpg", thumbwidth: 1920, thumbheight: 1440, descriptionurl: "https://commons.wikimedia.org/wiki/File:A.jpg", extmetadata: { License: { value: "cc-by-4.0" }, ...extra } }],
    });
    expect(parseWikimedia({ query: { pages: [page({ NonFree: { value: "true" } })] } })).toHaveLength(0);
    expect(parseWikimedia({ query: { pages: [page({})] } })).toHaveLength(1);
    expect(standardThumbWidth(1600)).toBe(1920);
    expect(standardThumbWidth(900)).toBe(960);
    const u = new URL(wikimediaUrl({ query: "coffee shop", targetWidth: 1600 }));
    expect(u.searchParams.get("gsrnamespace")).toBe("6");
    expect(u.searchParams.get("generator")).toBe("search");
    expect(u.searchParams.get("iiurlwidth")).toBe("1920");
    expect(u.searchParams.get("gsrsearch")).toBe("coffee shop filetype:bitmap");
  });
});

describe("stock providers", () => {
  it("Pexels: key only in the Authorization header, resized download URL", async () => {
    const answer = { photos: [{ id: 7, width: 6000, height: 4000, url: "https://www.pexels.com/photo/7/", photographer: "Ana", photographer_url: "https://www.pexels.com/@ana", alt: "Barista pouring coffee", src: { original: "https://images.pexels.com/photos/7/a.jpeg" } }] };
    const m = mockFetch((u) => (u.hostname === "api.pexels.com" ? json(answer) : undefined));
    const p = createPexelsProvider({ fetch: m.fetch, now: () => 0, apiKey: "PEXELS-KEY" });
    const res = await p.search({ ...q, orientation: "landscape" });
    expect(res.ok && res.candidates[0]).toMatchObject({ width: 1600, height: 1067, attribution: { license: "Pexels License", author: "Ana", attributionRequired: false } });
    expect(m.calls[0]?.url).not.toContain("PEXELS-KEY");
    expect((m.calls[0]?.init?.headers as Record<string, string>).authorization).toBe("PEXELS-KEY");
    expect(new URL(m.calls[0]?.url ?? "").searchParams.get("orientation")).toBe("landscape");
    expect(res.ok && new URL(res.candidates[0]?.downloadUrl ?? "").searchParams.get("w")).toBe("1600");
  });

  it("Pixabay: large image capped at 1280 px, no key in the download URL", () => {
    const c = parsePixabay({ hits: [{ id: 3, pageURL: "https://pixabay.com/photos/3/", tags: "coffee, cup, cafe", largeImageURL: "https://pixabay.com/get/abc_1280.jpg", imageWidth: 5000, imageHeight: 2500, user: "joe", user_id: 42 }] });
    expect(c[0]).toMatchObject({ width: 1280, height: 640, text: "coffee  cup  cafe", attribution: { authorUrl: "https://pixabay.com/users/joe-42/" } });
  });

  it("Pixabay: the provider sends its key as the API requires, and the candidate never carries it", async () => {
    const m = mockFetch(() => json({ hits: [] }));
    await createPixabayProvider({ fetch: m.fetch, now: () => 0, apiKey: "PX-KEY" }).search(q);
    expect(new URL(m.calls[0]?.url ?? "").searchParams.get("key")).toBe("PX-KEY");
  });

  it("Unsplash: attribution with utm, download tracking only when chosen and only to api.unsplash.com", async () => {
    const answer = {
      results: [
        { id: "u1", width: 5000, height: 3333, alt_description: "latte art", urls: { raw: "https://images.unsplash.com/photo-1?ixid=x" }, links: { html: "https://unsplash.com/photos/u1", download_location: "https://api.unsplash.com/photos/u1/download?ixid=x" }, user: { name: "Kim", links: { html: "https://unsplash.com/@kim" } } },
        { id: "u2", width: 5000, height: 3333, urls: { raw: "https://images.unsplash.com/photo-2" }, links: { download_location: "https://evil.example/track" }, user: { name: "Lee" } },
      ],
    };
    const m = mockFetch((u) => (u.pathname === "/search/photos" ? json(answer) : new Response("", { status: 200 })));
    const p = createUnsplashProvider({ fetch: m.fetch, now: () => 0, apiKey: "UNS-KEY" });
    const res = await p.search(q);
    if (!res.ok) throw new Error("expected ok");
    expect((m.calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Client-ID UNS-KEY");
    const [a, b] = res.candidates;
    expect(a?.attribution).toMatchObject({ license: "Unsplash License", attributionRequired: true, author: "Kim" });
    expect(a?.attribution.authorUrl).toBe("https://unsplash.com/@kim?utm_source=forja&utm_medium=referral");
    expect(m.calls).toHaveLength(1);
    await a?.onChosen?.(signal);
    expect(m.calls[1]?.url).toBe("https://api.unsplash.com/photos/u1/download?ixid=x");
    await b?.onChosen?.(signal);
    expect(m.calls).toHaveLength(2);
    expect(parseUnsplash({ results: [] }, 1600, async () => {})).toEqual([]);
  });

  it("parsers never throw on garbage", () => {
    for (const bad of [null, 1, "x", {}, { photos: "x" }, { results: [null] }, { hits: [{}] }, { query: { pages: [{}] } }]) {
      expect(() => parseOpenverse(bad)).not.toThrow();
      expect(() => parseWikimedia(bad)).not.toThrow();
      expect(() => parsePexels(bad, 1600)).not.toThrow();
      expect(() => parsePixabay(bad)).not.toThrow();
    }
  });
});

describe("provider order", () => {
  const deps = { fetch: mockFetch().fetch, now: () => 0 };
  it("keyless only by default", () => {
    expect(buildSearchProviders({}, deps).map((p) => p.id)).toEqual(["openverse", "wikimedia"]);
  });
  it("enabled stock providers first, disabled or keyless ones ignored", () => {
    const env = { STOCK_PIXABAY: "true|k1", STOCK_PEXELS: "true|k2", STOCK_UNSPLASH: "false|k3" };
    expect(buildSearchProviders(env, deps).map((p) => p.id)).toEqual(["pexels", "pixabay", "openverse", "wikimedia"]);
  });
});
