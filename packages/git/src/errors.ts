/**
 * Typed errors of `@forja/git`.
 *
 * Protects: every refusal the files API and the versions API must map to a stable wire
 * code carries one of these codes, so the engine never string-matches git's (localized)
 * stderr. The API mapping lives in `@forja/contracts` (`v1/errors.ts`): FORBIDDEN_PATH 403,
 * STALE_WRITE 409, NO_DIFF_CONTENT 404, NOT_FOUND 404, TOO_LARGE 413, INVALID_PATH 400.
 * `CONFLICT`, `INVALID_STATE` and `GIT_FAILED` are engine-internal (500 unless mapped).
 */

export const GIT_ERROR_CODES = [
  "FORBIDDEN_PATH",
  "STALE_WRITE",
  "NO_DIFF_CONTENT",
  "NOT_FOUND",
  "TOO_LARGE",
  "INVALID_PATH",
  "CONFLICT",
  "INVALID_STATE",
  "GIT_FAILED",
] as const;
export type GitErrorCode = (typeof GIT_ERROR_CODES)[number];

export interface GitErrorDetails {
  path?: string;
  headSha?: string | null;
  baseCommitSha?: string;
  args?: readonly string[];
  exitCode?: number | null;
  stderr?: string;
  size?: number;
  limit?: number;
}

export class GitError extends Error {
  override readonly name = "GitError";
  readonly code: GitErrorCode;
  readonly details: GitErrorDetails;

  constructor(code: GitErrorCode, message: string, details: GitErrorDetails = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function isGitError(value: unknown, code?: GitErrorCode): value is GitError {
  return value instanceof GitError && (code === undefined || value.code === code);
}
