/**
 * Typed errors of `@forja/sandbox`.
 * Protects: the engine maps sandbox failures by code (e.g. `DB_NOT_READY` → keep the
 * project in `Starting`, `IMAGE_MISSING` → an operator problem), never by message text.
 */
export const SANDBOX_ERROR_CODES = [
  "APPS_NETWORK_MISSING",
  "WORK_MISSING",
  "IMAGE_MISSING",
  "NOT_PROVISIONED",
  "DB_NOT_READY",
  "DB_SCRIPT_FAILED",
  "HOST_PATH_MISMATCH",
  "VOLUME_INIT_FAILED",
] as const;
export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

export class SandboxError extends Error {
  override readonly name = "SandboxError";
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
