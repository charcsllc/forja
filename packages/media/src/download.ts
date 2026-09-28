/**
 * The safe downloader: bytes of one image from a URL a search API handed us.
 *
 * Protects (docs/architecture/07, SSRF and uploads rows):
 * - https only; every hop (the first URL and each redirect target) passes
 *   `publicUrlRejectionReason`, which resolves the name and refuses private, loopback,
 *   link-local/metadata, IPv4-mapped, NAT64 and internal-name targets;
 * - redirects are followed by hand (`redirect: "manual"`), at most 3;
 * - one timeout covers the whole download, and the caller's abort cancels it;
 * - at most 8 MB: a larger `content-length` is refused before reading, and the stream
 *   is cut as soon as it passes the limit when the length is absent or lies;
 * - the result must sniff as JPEG, PNG, WebP, AVIF or GIF (never SVG) with a parseable
 *   size; the server's `content-type` is ignored.
 * No cookies are sent, no credentials, only the identifying User-Agent.
 */
import type { AbortSignalLike } from "@forja/contracts/media";
import { linkedSignal, USER_AGENT, type FetchFn } from "./http.js";
import { publicUrlRejectionReason, type LookupFn } from "./safe-url.js";
import { sniffImage, type SniffedImage } from "./sniff.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REDIRECTS = 3;
export const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface DownloadOptions {
  fetch: FetchFn;
  lookup?: LookupFn;
  signal?: AbortSignalLike;
  timeoutMs?: number;
  maxBytes?: number;
}

export type DownloadResult =
  | { ok: true; bytes: Uint8Array; image: SniffedImage; finalUrl: string }
  | { ok: false; reason: string };

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function downloadImage(url: string, opts: DownloadOptions): Promise<DownloadResult> {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  const { signal, dispose } = linkedSignal(opts.signal, opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (signal.aborted) return { ok: false, reason: opts.signal?.aborted ? "aborted" : "timed out" };
      const rejected = await publicUrlRejectionReason(current, opts.lookup);
      if (rejected) return { ok: false, reason: `refused ${hop === 0 ? "URL" : "redirect"}: ${rejected}` };
      const res = await opts.fetch(current, {
        method: "GET",
        headers: { "user-agent": USER_AGENT, accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9" },
        redirect: "manual",
        credentials: "omit",
        signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!location) return { ok: false, reason: `HTTP ${res.status} without location` };
        if (hop === MAX_REDIRECTS) return { ok: false, reason: `more than ${MAX_REDIRECTS} redirects` };
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      const declared = Number(res.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        return { ok: false, reason: `too large (${declared} bytes)` };
      }
      const bytes = await readCapped(res, maxBytes);
      if (!bytes) return { ok: false, reason: `too large (over ${maxBytes} bytes)` };
      const image = sniffImage(bytes);
      if (!image) return { ok: false, reason: "not a JPEG, PNG, WebP, AVIF or GIF image" };
      return { ok: true, bytes, image, finalUrl: current };
    }
    return { ok: false, reason: "too many redirects" };
  } catch (err) {
    if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
    if (signal.aborted) return { ok: false, reason: "timed out" };
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    dispose();
  }
}
