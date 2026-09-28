/**
 * Shared helpers for provider adapters: gated JSON search, URL and HTML hygiene.
 *
 * Protects: a provider can only hand out absolute http(s) URLs in attribution fields
 * (the contract validates them as URLs, and an app renders them as links), text coming
 * from provider HTML is reduced to plain text, and rate limiting is applied the same way
 * for every provider.
 */
import type { AbortSignalLike } from "@forja/contracts/media";
import { getJson, type FetchFn } from "../http.js";
import type { RateGate } from "../rate-gate.js";

export function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

/** HTML (as Wikimedia's extmetadata carries it) → one line of plain text. */
export function htmlToText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e] ?? " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** First absolute link in an HTML fragment. */
export function firstHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const m = /href="([^"]+)"/.exec(value);
  const href = m?.[1]?.startsWith("//") ? `https:${m[1]}` : m?.[1];
  return safeHttpUrl(href);
}

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const posInt = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

export type GatedJson =
  | { ok: true; json: unknown; headers: Headers }
  | { ok: false; reason: string; rateLimited: boolean; skipped?: boolean };

/** One gated GET: refuses when the gate is closed, cools the gate down on 429. */
export async function gatedGet(
  gate: RateGate,
  fetchFn: FetchFn,
  url: string,
  opts: { headers?: Record<string, string>; signal: AbortSignalLike; now: () => number },
): Promise<GatedJson> {
  const blocked = gate.blockedReason();
  if (blocked || !gate.tryAcquire()) return { ok: false, reason: blocked ?? "rate limited", rateLimited: true, skipped: true };
  const res = await getJson(fetchFn, url, { headers: opts.headers, signal: opts.signal, now: opts.now });
  if (res.ok) return { ok: true, json: res.json, headers: res.headers };
  if (res.rateLimited) gate.coolDown(res.retryAfterMs ?? 60_000);
  return { ok: false, reason: res.error, rateLimited: res.rateLimited };
}
