/**
 * The one HTTP helper for search APIs.
 *
 * Protects: every request identifies Forja with a descriptive User-Agent (Wikimedia's
 * policy requires one, Openverse asks for one), has a timeout, follows no redirects
 * (search APIs answer directly), and honours the caller's abort signal. Rate-limit
 * answers become a typed result so the provider can cool down instead of retrying.
 */
import type { AbortSignalLike } from "@forja/contracts/media";

export const USER_AGENT = "Forja/0.1 (+https://github.com/charcsllc/forja; image search for generated apps)";

export type FetchFn = typeof fetch;

export interface MediaLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export const silentLogger: MediaLogger = { info: () => {}, warn: () => {} };

export type JsonResult =
  | { ok: true; status: number; json: unknown; headers: Headers }
  | { ok: false; status: number; rateLimited: boolean; retryAfterMs: number | null; error: string; headers: Headers | null };

/** An AbortSignal that fires on the caller's signal or after `timeoutMs`. */
export function linkedSignal(parent: AbortSignalLike | undefined, timeoutMs: number): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(new Error("aborted"));
  if (parent?.aborted) controller.abort(new Error("aborted"));
  else parent?.addEventListener("abort", onAbort);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onAbort);
    },
  };
}

/** `Retry-After` in ms (seconds or HTTP date), or null. */
export function retryAfterMs(headers: Headers | null, now: number): number | null {
  const raw = headers?.get("retry-after");
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export async function getJson(
  fetchFn: FetchFn,
  url: string,
  opts: { headers?: Record<string, string>; signal?: AbortSignalLike; timeoutMs?: number; now?: () => number } = {},
): Promise<JsonResult> {
  const { signal, dispose } = linkedSignal(opts.signal, opts.timeoutMs ?? 10_000);
  const now = opts.now ?? Date.now;
  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...opts.headers },
      redirect: "error",
      signal,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return {
        ok: false,
        status: res.status,
        rateLimited: res.status === 429,
        retryAfterMs: retryAfterMs(res.headers, now()),
        error: `HTTP ${res.status}`,
        headers: res.headers,
      };
    }
    const json: unknown = await res.json();
    return { ok: true, status: res.status, json, headers: res.headers };
  } catch (err) {
    const aborted = opts.signal?.aborted === true;
    return {
      ok: false,
      status: 0,
      rateLimited: false,
      retryAfterMs: null,
      error: aborted ? "aborted" : err instanceof Error ? err.message : String(err),
      headers: null,
    };
  } finally {
    dispose();
  }
}
