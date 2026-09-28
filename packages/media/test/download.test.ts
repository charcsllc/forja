/**
 * The safe downloader. Protects: each redirect hop is re-checked, at most 3 hops, http
 * and private targets refused, 8 MB cap enforced with or without content-length, only
 * sniffed images accepted, timeouts and aborts end the download.
 */
import { describe, expect, it } from "vitest";
import { downloadImage, MAX_IMAGE_BYTES } from "../src/download.js";
import { bytes, fakeLookup, jpeg, mockFetch, png, svg } from "./helpers.js";

const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

describe("downloadImage", () => {
  it("downloads and sniffs; sends the Forja User-Agent and manual redirects", async () => {
    const m = mockFetch((u) => (u.hostname === "img.example" ? bytes(png(1600, 900), { "content-type": "text/html" }) : undefined));
    const r = await downloadImage("https://img.example/a", { fetch: m.fetch, lookup: fakeLookup });
    expect(r).toMatchObject({ ok: true, image: { kind: "png", width: 1600, height: 900 } });
    const init = m.calls[0]?.init;
    expect(init?.redirect).toBe("manual");
    expect((init?.headers as Record<string, string>)["user-agent"]).toMatch(/^Forja\//);
  });

  it("follows up to 3 redirects, re-checking each hop", async () => {
    const m = mockFetch((u) => {
      const n = Number(u.pathname.slice(1));
      return n < 3 ? redirect(`/${n + 1}`) : bytes(jpeg(1200, 800));
    });
    const r = await downloadImage("https://img.example/0", { fetch: m.fetch, lookup: fakeLookup });
    expect(r.ok).toBe(true);
    expect(m.calls).toHaveLength(4);
  });

  it("refuses a 4th redirect", async () => {
    const m = mockFetch((u) => redirect(`/${Number(u.pathname.slice(1)) + 1}`));
    const r = await downloadImage("https://img.example/0", { fetch: m.fetch, lookup: fakeLookup });
    expect(r).toEqual({ ok: false, reason: "more than 3 redirects" });
    expect(m.calls).toHaveLength(4);
  });

  it("refuses a redirect to metadata, to http, or to a private name, without fetching it", async () => {
    for (const to of ["https://169.254.169.254/latest", "http://img.example/x.jpg", "https://evil.example/x.jpg", "https://localhost/x"]) {
      const m = mockFetch((u) => (u.pathname === "/start" ? redirect(to) : bytes(jpeg(10, 10))));
      const r = await downloadImage("https://img.example/start", { fetch: m.fetch, lookup: fakeLookup });
      expect(r.ok).toBe(false);
      expect(m.calls).toHaveLength(1);
    }
  });

  it("refuses an http first URL without any request", async () => {
    const m = mockFetch(() => bytes(jpeg(10, 10)));
    expect((await downloadImage("http://img.example/a.jpg", { fetch: m.fetch, lookup: fakeLookup })).ok).toBe(false);
    expect(m.calls).toHaveLength(0);
  });

  it("refuses a declared size over 8 MB and a stream that grows past it", async () => {
    const declared = mockFetch(() => bytes(jpeg(10, 10), { "content-length": String(MAX_IMAGE_BYTES + 1) }));
    expect(await downloadImage("https://img.example/a", { fetch: declared.fetch, lookup: fakeLookup })).toMatchObject({ ok: false, reason: /too large/ });

    const big = new Uint8Array(1024);
    big.set(jpeg(10, 10));
    const stream = mockFetch(() => new Response(new ReadableStream({
      start(c) {
        for (let i = 0; i < 5; i++) c.enqueue(big);
        c.close();
      },
    })));
    expect(await downloadImage("https://img.example/a", { fetch: stream.fetch, lookup: fakeLookup, maxBytes: 3000 })).toMatchObject({ ok: false, reason: /too large/ });
  });

  it("refuses SVG even when labelled image/*", async () => {
    const m = mockFetch(() => bytes(svg, { "content-type": "image/svg+xml" }));
    expect(await downloadImage("https://img.example/a.svg", { fetch: m.fetch, lookup: fakeLookup })).toMatchObject({ ok: false, reason: /not a JPEG/ });
  });

  it("reports HTTP errors and times out", async () => {
    const m404 = mockFetch(() => new Response("no", { status: 404 }));
    expect(await downloadImage("https://img.example/a", { fetch: m404.fetch, lookup: fakeLookup })).toEqual({ ok: false, reason: "HTTP 404" });

    const hang = (async (_u: unknown, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        if (init?.signal?.aborted) reject(new Error("aborted"));
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    expect(await downloadImage("https://img.example/a", { fetch: hang, lookup: fakeLookup, timeoutMs: 20 })).toEqual({ ok: false, reason: "timed out" });

    const ac = new AbortController();
    ac.abort();
    expect(await downloadImage("https://img.example/a", { fetch: hang, lookup: fakeLookup, signal: ac.signal })).toEqual({ ok: false, reason: "aborted" });
  });
});
