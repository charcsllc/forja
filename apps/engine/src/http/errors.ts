/**
 * Error shapes of the engine HTTP API.
 *
 * v1 (Totalum-compatible, research/02): `{errors: {errorCode, errorMessage}, data: null}`.
 * v2: `{error: {code, message}}`.
 *
 * TODO(contracts): the codes below are local until `@forja/contracts` ships a compiled
 * build with the engine codes (its exports point at .ts sources today, which `node dist/`
 * cannot load). Keep the names identical to `ENGINE_ERROR_CODES` there.
 */
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type EngineErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_TOKEN"
  | "NOT_FOUND"
  | "NOT_IMPLEMENTED"
  | "VALIDATION"
  | "PROJECT_NOT_FOUND"
  | "INTERNAL_ERROR";

export class EngineError extends HTTPException {
  readonly code: EngineErrorCode;
  constructor(status: ContentfulStatusCode, code: EngineErrorCode, message: string) {
    super(status, { message });
    this.code = code;
  }
}

export interface V1ErrorEnvelope {
  errors: { errorCode: string; errorMessage: string };
  data: null;
}

export interface V2Error {
  error: { code: string; message: string };
}

export const v1Error = (errorCode: string, errorMessage: string): V1ErrorEnvelope => ({
  errors: { errorCode, errorMessage },
  data: null,
});

export const v2Error = (code: string, message: string): V2Error => ({ error: { code, message } });

export const isV1Path = (path: string): boolean => path === "/v1" || path.startsWith("/v1/");
