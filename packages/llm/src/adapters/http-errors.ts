/**
 * HTTP failure → `LlmError` mapping shared by the adapters.
 *
 * What this file protects: the retry policy depends only on `code`/`retryable`, so every
 * adapter must classify a status the same way. Error text is a trimmed slice of the
 * provider's body (never request headers, so never a key).
 */
import { LlmError, type LlmErrorCode } from "../errors.js";

const CONTEXT_PATTERNS = [
  /context[_ ]length/i,
  /maximum context/i,
  /context window/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input is too long/i,
  /reduce the length/i,
];

/** `Retry-After` as seconds or HTTP date → milliseconds (undefined when absent/invalid). */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Extracts a human message from a JSON or text error body, trimmed to 300 chars. */
export function errorBodyMessage(body: string): string {
  let msg = body.trim();
  try {
    const json = JSON.parse(msg) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const candidate =
      typeof json.error === "string" ? json.error : typeof json.error?.message === "string" ? json.error.message : typeof json.message === "string" ? json.message : typeof json.detail === "string" ? json.detail : undefined;
    if (candidate) msg = candidate;
  } catch {
    // not JSON: keep the text
  }
  msg = msg.replace(/\s+/g, " ");
  return msg.length > 300 ? `${msg.slice(0, 300)}…` : msg;
}

export function classifyStatus(status: number, body: string): { code: LlmErrorCode; retryable: boolean } {
  if (status === 401 || status === 403) return { code: "auth", retryable: false };
  if (status === 402) return { code: "unavailable", retryable: false };
  if (status === 404) return { code: "bad_request", retryable: false };
  if (status === 408) return { code: "timeout", retryable: true };
  if (status === 413) return { code: "context_length", retryable: false };
  if (status === 429) return { code: "rate_limited", retryable: true };
  if (status === 400 || status === 422) {
    return CONTEXT_PATTERNS.some((p) => p.test(body)) ? { code: "context_length", retryable: false } : { code: "bad_request", retryable: false };
  }
  if (status >= 500) return { code: "unavailable", retryable: true };
  return { code: "unavailable", retryable: false };
}

export function httpError(status: number, body: string, ctx: { provider: string; model: string; retryAfterMs?: number }): LlmError {
  const { code, retryable } = classifyStatus(status, body);
  const detail = errorBodyMessage(body);
  const hint = status === 402 ? " (payment required: credits exhausted?)" : status === 404 ? " (unknown model or endpoint?)" : "";
  return new LlmError(code, `${ctx.provider}:${ctx.model} answered HTTP ${status}${hint}${detail ? `: ${detail}` : ""}`, {
    retryable,
    provider: ctx.provider,
    model: ctx.model,
    status,
    ...(ctx.retryAfterMs !== undefined ? { retryAfterMs: ctx.retryAfterMs } : {}),
  });
}
