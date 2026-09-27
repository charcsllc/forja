/**
 * Error shapes of the engine HTTP API.
 *
 * v1 (Totalum-compatible, research/02 §2): `{errors: {errorCode, errorMessage, errorDetails?}, data: null}`.
 * v2: `{error: {code, message, details?}}`.
 *
 * ⭐ `errorCode` values are the engine's upstream codes: the ones in `ENGINE_ERROR_CODES`
 * (`@forja/contracts`) take their HTTP status from there; Totalum-named validation codes
 * (`INVALID_PROJECT_NAME`, `MISSING_PROMPT`, …) and engine-internal ones (`UNAUTHORIZED`,
 * `INVALID_TOKEN`, `NOT_FOUND`, `INTERNAL_ERROR`) pass an explicit status. The UI keeps any
 * 4xx as is and rewrites 5xx to 502, so state conflicts are 409 and missing things 404.
 */
import { ENGINE_ERROR_STATUS, isEngineErrorCode } from "@forja/contracts/v1";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorDetails = Record<string, unknown>;

export class EngineError extends HTTPException {
  readonly code: string;
  readonly details: ErrorDetails | undefined;
  constructor(status: ContentfulStatusCode, code: string, message: string, details?: ErrorDetails) {
    super(status, { message });
    this.code = code;
    this.details = details;
  }
}

/** An error whose status comes from `ENGINE_ERROR_STATUS` (400 for anything unlisted). */
export function engineError(code: string, message: string, details?: ErrorDetails): EngineError {
  const status = isEngineErrorCode(code) ? ENGINE_ERROR_STATUS[code] : 400;
  return new EngineError(status as ContentfulStatusCode, code, message, details);
}

export const notFound = (message = "Project not found"): EngineError =>
  new EngineError(404, "PROJECT_NOT_FOUND", message);

export const notImplemented = (what: string): EngineError =>
  new EngineError(501, "NOT_IMPLEMENTED", `${what} is not implemented yet in this engine version`);

export const serverNotReady = (message = "The project's server is starting; try again in a moment."): EngineError =>
  new EngineError(409, "SERVER_NOT_READY", message);

export interface V1ErrorEnvelope {
  errors: { errorCode: string; errorMessage: string; errorDetails?: ErrorDetails };
  data: null;
}

export interface V2Error {
  error: { code: string; message: string; details?: ErrorDetails };
}

export const v1Error = (errorCode: string, errorMessage: string, errorDetails?: ErrorDetails): V1ErrorEnvelope => ({
  errors: errorDetails ? { errorCode, errorMessage, errorDetails } : { errorCode, errorMessage },
  data: null,
});

export const v2Error = (code: string, message: string, details?: ErrorDetails): V2Error => ({
  error: details ? { code, message, details } : { code, message },
});

export const isV1Path = (path: string): boolean => path === "/v1" || path.startsWith("/v1/");
