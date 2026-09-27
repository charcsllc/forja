/**
 * Small helpers shared by the v1 routes: the success envelope, lenient JSON bodies, and the
 * mapping of `@forja/git` errors to wire codes.
 *
 * Protects: every v1 answer is `{errors, data}` JSON (research/02 §2). A git refusal keeps
 * its meaning on the wire: FORBIDDEN_PATH 403, STALE_WRITE 409, NO_DIFF_CONTENT 404,
 * NOT_FOUND 404, TOO_LARGE → FILE_TOO_LARGE 413, INVALID_PATH 400.
 */
import { isGitError } from "@forja/git";
import type { Context } from "hono";
import { EngineError, engineError } from "./errors.js";

export function ok<T>(c: Context, data: T, status: 200 | 201 = 200): Response {
  c.header("Cache-Control", "no-store");
  return c.json({ errors: null, data }, status);
}

/** The JSON body as an object; `{}` when absent or not an object (the UI sometimes sends none). */
export async function body(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text().catch(() => "");
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new EngineError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function intParam(v: string | undefined, { min = 0, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {}): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new EngineError(400, "INVALID_LIMIT", `Invalid number: ${v}`);
  return n;
}

/** Runs a repository call and translates `GitError`s. */
export async function git<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isGitError(err)) throw err;
    switch (err.code) {
      case "FORBIDDEN_PATH":
        throw engineError("FORBIDDEN_PATH", err.message);
      case "STALE_WRITE":
        throw engineError("STALE_WRITE", err.message, { headSha: err.details.headSha ?? null });
      case "NO_DIFF_CONTENT":
        throw engineError("NO_DIFF_CONTENT", err.message);
      case "NOT_FOUND":
        throw new EngineError(404, "FILE_NOT_FOUND", err.message);
      case "TOO_LARGE":
        throw engineError("FILE_TOO_LARGE", err.message, { limit: err.details.limit, size: err.details.size });
      case "INVALID_PATH":
        throw new EngineError(400, "INVALID_PATH", err.message);
      case "INVALID_STATE":
        throw new EngineError(409, "SERVER_NOT_READY", "The project's files are not ready yet.");
      default:
        throw err;
    }
  }
}
