/**
 * `createImageSourcing` end to end over mocked HTTP and DNS.
 * Protects: the strategy (env default, UI override, generate → web fallback, a real
 * generator used only in `generate` mode), provider order and stop-at-first-good,
 * falling through rate limits and bad downloads, the file and credits.json written per
 * slot, media calls recorded, abort and invalid input.
 */
import { describe, expect, it, vi } from "vitest";
import { ImageFindResultSchema, type ImageSourceMode } from "@forja/contracts/media";
import { CREDITS_PATH } from "../src/credits.js";
import { ImageSourcingError } from "../src/errors.js";
import type { ImageGenerator } from "../src/generator.js";
import { createImageSourcing, type MediaCallRecord } from "../src/sourcing.js";
import { bytes, fakeLookup, fixture, fixtureJson, jpeg, json, makeCtx, mockFetch, png, type Route } from "./helpers.js";

const REQ = { slot: "hero", query: "coffee shop", alt: "Una cafetería por dentro", orientation: "landscape" as const, minWidth: 1000 };

const openverse: Route = (u) => (u.hostname === "api.openverse.org" ? json(fixtureJson("openverse-search.json")) : undefined);
const wikimedia: Route = (u) => (u.hostname === "commons.wikimedia.org" ? json(fixtureJson("wikimedia-search.json")) : undefined);
const flickrOk: Route = (u) => (u.hostname === "live.staticflickr.com" ? bytes(new Uint8Array(fixture("flickr-500x333.jpg"))) : undefined);
const uploadOk: Route = (u) => (u.hostname === "upload.wikimedia.org" ? bytes(jpeg(1600, 1315)) : undefined);

const store = (mode: ImageSourceMode | null) => ({ storedImageMode: async () => mode });
const decode = (b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b)) as unknown;

describe("setting()", () => {
  it.each([
    [{}, null, { mode: "generate", source: "env", envDefault: "generate" }],
    [{ IMAGES_FROM_WEB_SEARCH: "true" }, null, { mode: "web-search", source: "env", envDefault: "web-search" }],
    [{ IMAGES_FROM_WEB_SEARCH: "on" }, "generate", { mode: "generate", source: "ui", envDefault: "web-search" }],
    [{ IMAGES_FROM_WEB_SEARCH: "no" }, "web-search", { mode: "web-search", source: "ui", envDefault: "generate" }],
  ] as const)("env %j + override %j", async (env, override, expected) => {
    const s = createImageSourcing({ env, settings: store(override), providers: [] });
    expect(await s.setting()).toEqual({ ...expected, generationAvailable: false });
  });

  it("an unreadable override falls back to the env default", async () => {
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "1" }, settings: { storedImageMode: async () => { throw new Error("db down"); } }, providers: [] });
    expect(await s.setting()).toMatchObject({ mode: "web-search", source: "env" });
  });

  it("an enabled IMAGE_* provider without an adapter does not make generation available", async () => {
    const warn = vi.fn();
    const s = createImageSourcing({ env: { IMAGE_FAL: "true|k" }, providers: [], logger: { info: () => {}, warn } });
    expect((await s.setting()).generationAvailable).toBe(false);
    expect(warn).toHaveBeenCalledWith({ providers: ["fal"] }, expect.stringMatching(/no generator adapter/));
  });
});

describe("find() with web search", () => {
  it("writes the file and credits.json from the first good Openverse result; Wikimedia is never asked", async () => {
    const calls: MediaCallRecord[] = [];
    const m = mockFetch(openverse, wikimedia, (u) => (u.hostname === "live.staticflickr.com" ? bytes(jpeg(1024, 758)) : undefined));
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "true" }, fetch: m.fetch, lookup: fakeLookup, onCall: (c) => void calls.push(c) });
    expect(s.searchProviders).toEqual(["openverse", "wikimedia"]);
    const ctx = makeCtx();
    const r = await s.find(REQ, ctx);

    expect(ImageFindResultSchema.parse(r)).toEqual({
      path: "public/images/hero.jpg",
      publicUrl: "/images/hero.jpg",
      width: 1024,
      height: 758,
      mediaType: "image/jpeg",
      alt: REQ.alt,
      mode: "web-search",
      attribution: expect.objectContaining({ provider: "openverse", license: "CC BY-SA 2.0", author: "pixeljones" }),
    });
    expect(ctx.files.get("public/images/hero.jpg")?.byteLength).toBeGreaterThan(0);
    expect(decode(ctx.files.get(CREDITS_PATH))).toEqual([{ slot: "hero", path: "/images/hero.jpg", alt: REQ.alt, attribution: r.attribution }]);
    expect(m.calls.some((c) => c.url.includes("wikimedia"))).toBe(false);
    expect(calls).toEqual([expect.objectContaining({ provider: "openverse", kind: "search", costUsd: 0, outcome: "ok", projectId: "proj-1", runId: "run-1", query: "coffee shop" })]);
  });

  it("uses the real size of the file, not what the API said", async () => {
    const m = mockFetch(openverse, flickrOk);
    const s = createImageSourcing({ env: {}, settings: store("web-search"), fetch: m.fetch, lookup: fakeLookup });
    const r = await s.find(REQ, makeCtx());
    expect([r.width, r.height]).toEqual([500, 333]);
  });

  it("falls through a rate-limited Openverse to Wikimedia and records both calls", async () => {
    const calls: MediaCallRecord[] = [];
    const m = mockFetch((u) => (u.hostname === "api.openverse.org" ? new Response("", { status: 429, headers: { "retry-after": "60" } }) : undefined), wikimedia, uploadOk);
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "true" }, fetch: m.fetch, lookup: fakeLookup, onCall: (c) => void calls.push(c) });
    const r = await s.find(REQ, makeCtx());
    expect(r.attribution.provider).toBe("wikimedia");
    expect(calls.map((c) => [c.provider, c.outcome])).toEqual([["openverse", "rate_limited"], ["wikimedia", "ok"]]);
    // Second call: Openverse is cooling down, so it is skipped without a request or a record.
    calls.length = 0;
    await s.find({ ...REQ, slot: "hero-2", query: "espresso machine" }, makeCtx());
    expect(calls.map((c) => c.provider)).toEqual(["wikimedia"]);
  });

  it("skips candidates whose download fails (SSRF, SVG, 404) and tries the next", async () => {
    const answer = {
      results: [
        { id: "1", license: "cc0", url: "https://evil.example/a.jpg", width: 1600, height: 1000, title: "coffee shop" },
        { id: "2", license: "cc0", url: "https://img.example/b.jpg", width: 1600, height: 1000, title: "coffee shop" },
        { id: "3", license: "cc0", url: "https://img.example/c.jpg", width: 1600, height: 1000, title: "coffee shop interior" },
      ],
    };
    const m = mockFetch(
      (u) => (u.hostname === "api.openverse.org" ? json(answer) : undefined),
      (u) => (u.pathname === "/b.jpg" ? new Response("gone", { status: 404 }) : undefined),
      (u) => (u.pathname === "/c.jpg" ? bytes(png(1600, 1000)) : undefined),
    );
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "true" }, fetch: m.fetch, lookup: fakeLookup, providers: undefined });
    const r = await s.find(REQ, makeCtx());
    expect(r).toMatchObject({ path: "public/images/hero.png", mediaType: "image/png" });
    expect(m.calls.some((c) => c.url.startsWith("https://evil.example"))).toBe(false);
  });

  it("prefers an enabled stock provider (Pexels) over Openverse", async () => {
    const pexels = { photos: [{ id: 1, width: 4000, height: 2500, url: "https://www.pexels.com/photo/1/", photographer: "Ana", alt: "coffee shop counter", src: { original: "https://images.pexels.com/photos/1/a.jpeg" } }] };
    const m = mockFetch((u) => (u.hostname === "api.pexels.com" ? json(pexels) : undefined), (u) => (u.hostname === "images.pexels.com" ? bytes(jpeg(1600, 1000)) : undefined), openverse);
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "true", STOCK_PEXELS: "true|pk" }, fetch: m.fetch, lookup: fakeLookup });
    expect(s.searchProviders).toEqual(["pexels", "openverse", "wikimedia"]);
    const r = await s.find(REQ, makeCtx());
    expect(r.attribution).toMatchObject({ provider: "pexels", license: "Pexels License" });
    expect(m.calls.some((c) => c.url.includes("openverse"))).toBe(false);
  });

  it("replaces the slot's credit on re-find and keeps other slots and foreign entries", async () => {
    const m = mockFetch(openverse, (u) => (u.hostname === "live.staticflickr.com" ? bytes(u.pathname.includes("24171123") ? jpeg(1024, 758) : png(1024, 683)) : undefined));
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "true" }, fetch: m.fetch, lookup: fakeLookup });
    const ctx = makeCtx(new Map([[CREDITS_PATH, new TextEncoder().encode(JSON.stringify([{ path: "/logo.png", alt: "Logo", attribution: { license: "own" } }]))]]));
    await s.find({ ...REQ, slot: "team-1" }, ctx);
    await s.find(REQ, ctx);
    await s.find({ ...REQ, alt: "Otra" }, ctx);
    const credits = decode(ctx.files.get(CREDITS_PATH)) as Array<{ slot?: string; alt: string }>;
    expect(credits.map((c) => c.slot ?? "(foreign)")).toEqual(["(foreign)", "hero", "team-1"]);
    expect(credits.find((c) => c.slot === "hero")?.alt).toBe("Otra");
  });

  it("without readFile, merges with what this process wrote for the project", async () => {
    const m = mockFetch(openverse, (u) => (u.hostname === "live.staticflickr.com" ? bytes(jpeg(1024, 758)) : undefined));
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "true" }, fetch: m.fetch, lookup: fakeLookup });
    const files = new Map<string, Uint8Array>();
    await Promise.all([s.find(REQ, makeCtx(files, false)), s.find({ ...REQ, slot: "about" }, makeCtx(files, false))]);
    expect((decode(files.get(CREDITS_PATH)) as Array<{ slot: string }>).map((c) => c.slot)).toEqual(["about", "hero"]);
  });

  it("caches search answers per query", async () => {
    const m = mockFetch(openverse, (u) => (u.hostname === "live.staticflickr.com" ? bytes(jpeg(1024, 758)) : undefined));
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "true" }, fetch: m.fetch, lookup: fakeLookup });
    await s.find(REQ, makeCtx());
    await s.find({ ...REQ, slot: "hero-b" }, makeCtx());
    expect(m.calls.filter((c) => c.url.includes("api.openverse.org"))).toHaveLength(1);
  });

  it("throws not_found with the reasons when nothing works", async () => {
    const m = mockFetch((u) => (u.hostname.startsWith("api.") || u.hostname.startsWith("commons.") ? json({ results: [], query: { pages: [] } }) : undefined));
    const s = createImageSourcing({ env: { IMAGES_FROM_WEB_SEARCH: "true" }, fetch: m.fetch, lookup: fakeLookup });
    const err = await s.find(REQ, makeCtx()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImageSourcingError);
    expect(err).toMatchObject({ code: "not_found", attempts: ["openverse: no usable results", "wikimedia: no usable results"] });
  });

  it("rejects an invalid request and an aborted context", async () => {
    const s = createImageSourcing({ env: {}, providers: [] });
    await expect(s.find({ ...REQ, slot: "../etc/passwd" }, makeCtx())).rejects.toMatchObject({ code: "invalid_request" });
    const ctx = makeCtx();
    const ac = new AbortController();
    ac.abort();
    await expect(s.find(REQ, { ...ctx, abortSignal: ac.signal })).rejects.toMatchObject({ code: "aborted" });
  });
});

describe("find() in generate mode", () => {
  it("with no generator: logs the reason and searches the web", async () => {
    const info = vi.fn();
    const m = mockFetch(openverse, flickrOk);
    const s = createImageSourcing({ env: {}, fetch: m.fetch, lookup: fakeLookup, logger: { info, warn: () => {} } });
    const r = await s.find(REQ, makeCtx());
    expect(r.mode).toBe("web-search");
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ slot: "hero", reason: "no IMAGE_* provider enabled" }), expect.stringMatching(/searching the web/));
  });

  it("with a runnable generator: generates, records cost; web-search mode never calls it", async () => {
    const generate = vi.fn(async () => ({ bytes: png(1536, 1024), model: "img-1", costUsd: 0.04 }));
    const gen: ImageGenerator = { id: "fal", available: () => true, generate };
    const calls: MediaCallRecord[] = [];
    const m = mockFetch(openverse, flickrOk);
    const gs = createImageSourcing({ env: {}, generators: [gen], fetch: m.fetch, lookup: fakeLookup, onCall: (c) => void calls.push(c) });
    expect((await gs.setting()).generationAvailable).toBe(true);
    const r = await gs.find(REQ, makeCtx());
    expect(r).toMatchObject({ mode: "generate", path: "public/images/hero.png", attribution: { provider: "fal", license: "generated" } });
    expect(calls).toEqual([expect.objectContaining({ kind: "generate", provider: "fal", model: "img-1", costUsd: 0.04, outcome: "ok" })]);
    expect(m.calls).toHaveLength(0);

    const ws = createImageSourcing({ env: {}, settings: store("web-search"), generators: [gen], fetch: m.fetch, lookup: fakeLookup });
    expect((await ws.find(REQ, makeCtx())).mode).toBe("web-search");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("a failing generator falls back to the web", async () => {
    const gen: ImageGenerator = { id: "fal", available: () => true, generate: async () => { throw new Error("quota"); } };
    const m = mockFetch(openverse, flickrOk);
    const s = createImageSourcing({ env: {}, generators: [gen], fetch: m.fetch, lookup: fakeLookup });
    expect((await s.find(REQ, makeCtx())).mode).toBe("web-search");
  });
});
