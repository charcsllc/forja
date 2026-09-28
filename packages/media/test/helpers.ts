/**
 * Test helpers: synthetic image headers, a routing fetch mock, a fake DNS, recorded
 * fixtures. Protects: no test ever touches the network or real DNS.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ImageSourcingContext } from "@forja/contracts/media";

export const fixture = (name: string): Buffer => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
export const fixtureJson = (name: string): unknown => JSON.parse(fixture(name).toString("utf8"));

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const asc = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function png(width: number, height: number): Uint8Array {
  return new Uint8Array([...asc("\x89PNG\r\n\x1a\n"), 0, 0, 0, 13, ...asc("IHDR"), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 0, 0, 0, 0]);
}

export function gif(width: number, height: number): Uint8Array {
  return new Uint8Array([...asc("GIF89a"), ...le16(width), ...le16(height), 0, 0, 0]);
}

/** JPEG: SOI, optional APP1 Exif with orientation, SOF0 with the size, EOI. */
export function jpeg(width: number, height: number, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  if (orientation) {
    // TIFF (big-endian): header + IFD0 with one entry (0x0112, SHORT, 1, value)
    const tiff = [...asc("MM"), 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
    const payload = [...asc("Exif"), 0, 0, ...tiff];
    const len = payload.length + 2;
    parts.push(0xff, 0xe1, (len >> 8) & 255, len & 255, ...payload);
  }
  parts.push(0xff, 0xc0, 0, 17, 8, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  parts.push(0xff, 0xd9);
  return new Uint8Array(parts);
}

export function webpVp8x(width: number, height: number): Uint8Array {
  return new Uint8Array([...asc("RIFF"), 0, 0, 0, 0, ...asc("WEBP"), ...asc("VP8X"), 10, 0, 0, 0, 0, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)]);
}

export function webpVp8l(width: number, height: number): Uint8Array {
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  return new Uint8Array([...asc("RIFF"), 0, 0, 0, 0, ...asc("WEBP"), ...asc("VP8L"), 5, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255, 0, 0, 0, 0, 0]);
}

export function webpVp8(width: number, height: number): Uint8Array {
  return new Uint8Array([...asc("RIFF"), 0, 0, 0, 0, ...asc("WEBP"), ...asc("VP8 "), 10, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height), 0, 0]);
}

export function avif(width: number, height: number): Uint8Array {
  const ftyp = [0, 0, 0, 20, ...asc("ftyp"), ...asc("avif"), 0, 0, 0, 0, ...asc("mif1")];
  const ispe = [0, 0, 0, 20, ...asc("ispe"), 0, 0, 0, 0, ...be32(width), ...be32(height)];
  return new Uint8Array([...ftyp, 0, 0, 0, 8, ...asc("meta"), ...ispe]);
}

export const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');

// ── fetch mock ───────────────────────────────────────────────────────────────

export type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

export interface MockFetch {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
}

export function mockFetch(...routes: Route[]): MockFetch {
  const calls: MockFetch["calls"] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    calls.push({ url: url.toString(), init });
    for (const r of routes) {
      const res = await r(url, init);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) }, ...init });

export const bytes = (b: Uint8Array, headers: Record<string, string> = {}) =>
  new Response(b, { status: 200, headers: { "content-type": "image/jpeg", ...headers } });

/** Every public-looking host resolves to a public address; `evil.example` to metadata. */
export const fakeLookup = async (host: string): Promise<string[]> => {
  if (host === "evil.example") return ["169.254.169.254"];
  if (host === "mapped.example") return ["::ffff:127.0.0.1"];
  if (host === "nxdomain.example") throw new Error("ENOTFOUND");
  return ["93.184.216.34"];
};

export function makeCtx(files = new Map<string, Uint8Array>(), withRead = true): ImageSourcingContext & { files: Map<string, Uint8Array> } {
  const controller = new AbortController();
  return {
    files,
    projectId: "proj-1",
    runId: "run-1",
    abortSignal: controller.signal,
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    ...(withRead ? { readFile: async (path: string) => files.get(path) ?? null } : {}),
  };
}
