/**
 * Error codes of API v1.
 *
 * Protects: (1) the normalised `VcaasErrorCode` union the UI switches on
 * (`apps/web/src/lib/vcaas-errors.ts`), with the upstream → normalised mapping as data,
 * and (2) the engine's own upstream `errorCode` values and the HTTP status each one is
 * sent with. See docs/research/02-ui-backend-contract.md §2 and
 * docs/architecture/05-data-model-and-api.md §2.1.
 *
 * Mapping order (identical to the UI's `classify`): exact entry in `UPSTREAM_CODE_MAP`,
 * then the prefix rules of `UPSTREAM_PREFIX_RULES`, then the HTTP status fallback, then
 * `UNKNOWN`. The prefix rules generalise the research note's `PLAN_*`, `FREE_PLAN_*`,
 * `MISSING_*` and `INVALID_*` wildcards; every code the UI lists explicitly is in the map,
 * so an exact entry (e.g. `MISSING_PROJECT_ID` → `PROJECT_NOT_FOUND`) always wins.
 */
import { z } from "zod";

/** The stable union the UI receives in `code` (client envelope). */
export const VCAAS_ERROR_CODES = [
  "INSUFFICIENT_CREDITS",
  "PLAN_REQUIRED",
  "PROJECT_LIMIT_REACHED",
  "PROJECT_NOT_FOUND",
  "RATE_LIMITED",
  "VALIDATION",
  "UPLOAD_QUOTA_EXCEEDED",
  "UNKNOWN",
] as const;
export const VcaasErrorCodeSchema = z.enum(VCAAS_ERROR_CODES);
export type VcaasErrorCode = z.infer<typeof VcaasErrorCodeSchema>;

/** Canonical HTTP status per normalised code (copied from the UI's `STATUS_FOR`). */
export const STATUS_FOR: Readonly<Record<VcaasErrorCode, number>> = {
  INSUFFICIENT_CREDITS: 402,
  PLAN_REQUIRED: 403,
  PROJECT_LIMIT_REACHED: 403,
  PROJECT_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  VALIDATION: 400,
  UPLOAD_QUOTA_EXCEEDED: 429,
  UNKNOWN: 502,
};

/** Exact upstream `errorCode` → normalised code. Keys are upper case. */
export const UPSTREAM_CODE_MAP: Readonly<Record<string, VcaasErrorCode>> = {
  // Credits and quotas (402).
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  VCAAS_INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  PROJECT_CREDIT_LIMIT_REACHED: "INSUFFICIENT_CREDITS",
  PROJECT_EXPORT_LIMIT_REACHED: "INSUFFICIENT_CREDITS",
  PROJECT_IMPORT_LIMIT_REACHED: "INSUFFICIENT_CREDITS",
  // Project count limit (checked before plan codes upstream; both are 403).
  MAX_PROJECTS_REACHED: "PROJECT_LIMIT_REACHED",
  // Plan gates.
  PLAN_REQUIRED: "PLAN_REQUIRED",
  PLAN_NOT_API: "PLAN_REQUIRED",
  PROJECT_NOT_ALLOWED: "PLAN_REQUIRED",
  PLATFORM_FREE_PLAN_NO_SOURCE_DOWNLOAD: "PLAN_REQUIRED",
  PLATFORM_FREE_PLAN_NO_GITHUB: "PLAN_REQUIRED",
  PLATFORM_FREE_PLAN_NO_CUSTOM_DOMAIN: "PLAN_REQUIRED",
  FREE_PLAN_NO_SOURCE_EDITING: "PLAN_REQUIRED",
  PAID_PLAN_REQUIRED: "PLAN_REQUIRED",
  // Not found (also means "not yours"; there is deliberately no FORBIDDEN code).
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
  MISSING_PROJECT_ID: "PROJECT_NOT_FOUND",
  TABLE_NOT_FOUND: "PROJECT_NOT_FOUND",
  WEBHOOK_NOT_FOUND: "PROJECT_NOT_FOUND",
  NO_DEPLOYMENT: "PROJECT_NOT_FOUND",
  // Rate limits.
  RATE_LIMIT_EXCEEDED: "RATE_LIMITED",
  TOO_MANY_PROMPTS: "RATE_LIMITED",
  // Validation.
  MISSING_DATA: "VALIDATION",
  MISSING_FILE: "VALIDATION",
  MISSING_GITHUB_FIELDS: "VALIDATION",
  MISSING_HOSTNAME: "VALIDATION",
  MISSING_IMPORT_CODE: "VALIDATION",
  MISSING_LIMIT_FIELDS: "VALIDATION",
  MISSING_PROMPT: "VALIDATION",
  MISSING_RECORD_ID: "VALIDATION",
  MISSING_SECRET_FIELDS: "VALIDATION",
  MISSING_SECRET_ID: "VALIDATION",
  MISSING_TABLE_NAME: "VALIDATION",
  MISSING_VERSION_ID: "VALIDATION",
  MISSING_WEBHOOK_FIELDS: "VALIDATION",
  INVALID_LIMIT: "VALIDATION",
  INVALID_MULTI_PROMPT: "VALIDATION",
  INVALID_PROJECT_NAME: "VALIDATION",
  INVALID_PROJECT_NAME_LENGTH: "VALIDATION",
  INVALID_PROMPT_ITEM: "VALIDATION",
  INVALID_SECRET_KEY_NAME: "VALIDATION",
  INVALID_SYNC_DIRECTION: "VALIDATION",
  INVALID_WEBHOOK_EVENT: "VALIDATION",
  INVALID_WEBHOOK_URL: "VALIDATION",
  PROJECT_ALREADY_EXISTS: "VALIDATION",
  WEBHOOK_EVENT_ALREADY_EXISTS: "VALIDATION",
  PROMPT_SECURITY_VIOLATION: "VALIDATION",
  RESERVED_PROJECT_NAME: "VALIDATION",
  // Engine code with a UI-visible meaning: the engine's own validation failure.
  VALIDATION: "VALIDATION",
};

/** Prefix fallbacks applied only when there is no exact entry. First match wins. */
export const UPSTREAM_PREFIX_RULES: ReadonlyArray<{ prefix: string; code: VcaasErrorCode }> = [
  { prefix: "PLAN_", code: "PLAN_REQUIRED" },
  { prefix: "FREE_PLAN_", code: "PLAN_REQUIRED" },
  { prefix: "PLATFORM_FREE_PLAN_", code: "PLAN_REQUIRED" },
  { prefix: "MISSING_", code: "VALIDATION" },
  { prefix: "INVALID_", code: "VALIDATION" },
];

/** Normalise an upstream `errorCode` (+ HTTP status) exactly like the UI does. */
export function classifyUpstreamCode(
  upstreamCode: string | null | undefined,
  httpStatus: number,
): VcaasErrorCode {
  const code = (upstreamCode ?? "").toUpperCase();
  if (code) {
    const exact = UPSTREAM_CODE_MAP[code];
    if (exact) return exact;
    const rule = UPSTREAM_PREFIX_RULES.find((r) => code.startsWith(r.prefix));
    if (rule) return rule.code;
  }
  if (httpStatus === 402) return "INSUFFICIENT_CREDITS";
  if (httpStatus === 429) return "RATE_LIMITED";
  if (httpStatus === 404) return "PROJECT_NOT_FOUND";
  if (httpStatus === 400 || httpStatus === 422) return "VALIDATION";
  return "UNKNOWN";
}

/**
 * The `errorCode` values the engine emits, with the HTTP status of each.
 *
 * Statuses not fixed by the design docs were chosen so the UI keeps the 4xx as is
 * (it rewrites any 5xx to 502): state conflicts are 409, missing things 404.
 */
export const ENGINE_ERROR_CODES = [
  { code: "NO_PROVIDER_ENABLED", status: 503 },
  { code: "STALE_WRITE", status: 409 },
  { code: "ROLLBACK_NEEDS_DB", status: 409 },
  { code: "FORBIDDEN_PATH", status: 403 },
  { code: "AGENT_RUNNING", status: 409 },
  { code: "SERVER_NOT_READY", status: 409 },
  { code: "SANDBOX_NOT_REACHABLE", status: 409 },
  { code: "NO_DEPLOYMENT", status: 404 },
  { code: "NO_DIFF_CONTENT", status: 404 },
  { code: "NO_ACTIVE_SANDBOX", status: 409 },
  { code: "PROJECT_ALREADY_EXISTS", status: 400 },
  { code: "RESERVED_PROJECT_NAME", status: 400 },
  { code: "NOT_IMPLEMENTED", status: 501 },
  { code: "INSUFFICIENT_CREDITS", status: 402 },
  { code: "RATE_LIMIT_EXCEEDED", status: 429 },
  { code: "PROJECT_NOT_FOUND", status: 404 },
  { code: "FILE_TOO_LARGE", status: 413 },
  { code: "VALIDATION", status: 400 },
] as const;

export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number]["code"];

const engineCodeValues = ENGINE_ERROR_CODES.map((e) => e.code) as [
  EngineErrorCode,
  ...EngineErrorCode[],
];
export const EngineErrorCodeSchema = z.enum(engineCodeValues);

/** HTTP status the engine sends with each of its codes. */
export const ENGINE_ERROR_STATUS: Readonly<Record<EngineErrorCode, number>> = Object.fromEntries(
  ENGINE_ERROR_CODES.map((e) => [e.code, e.status]),
) as Record<EngineErrorCode, number>;

export function isVcaasErrorCode(value: unknown): value is VcaasErrorCode {
  return VcaasErrorCodeSchema.safeParse(value).success;
}

export function isEngineErrorCode(value: unknown): value is EngineErrorCode {
  return EngineErrorCodeSchema.safeParse(value).success;
}
