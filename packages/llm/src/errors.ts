/**
 * The two error types the gateway throws (contract C2).
 *
 * What this file protects:
 * - Callers branch on `LlmError.code` and `retryable`, never on provider wording or HTTP
 *   status, so the orchestrator stays provider-agnostic.
 * - Messages never contain a key: they are built from the status, the provider/model ids
 *   and a trimmed slice of the provider's error body (providers do not echo credentials).
 * - `LlmConfigError` is an operator mistake (env, role requirements): it names exactly
 *   what is missing and is never retried.
 */

export type LlmErrorCode =
  | "auth"
  | "rate_limited"
  | "unavailable"
  | "bad_request"
  | "context_length"
  | "budget"
  | "aborted"
  | "timeout";

export interface LlmErrorOptions {
  retryable?: boolean;
  provider?: string;
  model?: string;
  /** HTTP status when the error came from a response. */
  status?: number;
  /** Parsed `Retry-After`, in milliseconds. */
  retryAfterMs?: number;
  cause?: unknown;
}

/** Codes that are worth retrying on the same model when nothing else says otherwise. */
const RETRYABLE_BY_DEFAULT: ReadonlySet<LlmErrorCode> = new Set(["rate_limited", "unavailable", "timeout"]);

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(code: LlmErrorCode, message: string, opts: LlmErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "LlmError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    if (opts.provider !== undefined) this.provider = opts.provider;
    if (opts.model !== undefined) this.model = opts.model;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmConfigError";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err instanceof LlmError && err.code === "aborted"));
}

/** Normalises anything thrown by an adapter into an `LlmError`. */
export function toLlmError(err: unknown, ctx: { provider?: string; model?: string } = {}): LlmError {
  if (err instanceof LlmError) return err;
  if (isAbortError(err)) return new LlmError("aborted", "generation aborted", { ...ctx, retryable: false, cause: err });
  const message = err instanceof Error ? err.message : String(err);
  // fetch() rejects with a TypeError on DNS/connection failures: transient by nature.
  return new LlmError("unavailable", `request failed: ${message}`, { ...ctx, retryable: true, cause: err });
}
