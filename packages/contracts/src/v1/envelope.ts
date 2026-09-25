/**
 * The two envelopes of API v1.
 *
 * Protects: (1) the upstream wire format `{errors, data}` that the engine must emit so
 * the UI's catch-all proxy (`apps/web/src/app/api/vcaas/[...path]/route.ts`) keeps
 * working unchanged, and (2) the client envelope `VcaasResponse<T>` that the proxy hands
 * to the browser (`{ok, data}` or `{ok:false, error, code, upstreamCode, details, data:null}`).
 * See docs/research/02-ui-backend-contract.md §2.
 */
import { z } from "zod";
import { VcaasErrorCodeSchema } from "./errors";

/**
 * Extra detail some error codes carry. Every field is optional; unknown fields pass
 * through (`SANDBOX_NOT_REACHABLE` → `reason`, `MAX_PROJECTS_REACHED` → quota fields).
 */
export const VcaasErrorDetailsSchema = z
  .object({
    reason: z.string().optional(),
    httpStatus: z.number().int().optional(),
    maxProjects: z.union([z.number().int(), z.literal("unlimited")]).optional(),
    projectsUsed: z.number().int().optional(),
    plan: z.string().nullable().optional(),
    upgradePlan: z.string().nullable().optional(),
  })
  .passthrough();
export type VcaasErrorDetails = z.infer<typeof VcaasErrorDetailsSchema>;

/** `SANDBOX_NOT_REACHABLE.details.reason` values the UI branches on. */
export const SandboxNotReachableReasonSchema = z.enum(["starting", "app_error"]);
export type SandboxNotReachableReason = z.infer<typeof SandboxNotReachableReasonSchema>;

/** The upstream error object. `errorCode` is the raw (not normalised) code. */
export const UpstreamErrorSchema = z.object({
  errorCode: z.string(),
  errorMessage: z.string(),
  errorDetails: VcaasErrorDetailsSchema.optional(),
});
export type UpstreamError = z.infer<typeof UpstreamErrorSchema>;

/** Upstream envelope: `errors === null` means success, whatever the HTTP status. */
export function upstreamEnvelopeSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    errors: UpstreamErrorSchema.nullable(),
    data: data,
  });
}
export const UpstreamEnvelopeSchema = upstreamEnvelopeSchema(z.unknown());
export type UpstreamEnvelope<T = unknown> = { errors: UpstreamError | null; data: T };

/** Paging state; declared by the UI but never filled by the current proxy. */
export const VcaasPageMetaSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  skip: z.number().int(),
  hasMore: z.boolean(),
});
export type VcaasPageMeta = z.infer<typeof VcaasPageMetaSchema>;

/** Client envelope, success branch. */
export function vcaasSuccessSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    ok: z.literal(true),
    data: data,
    meta: VcaasPageMetaSchema.optional(),
  });
}

/**
 * Client envelope, failure branch. `code` is the stable normalised union; the raw
 * upstream name travels in `upstreamCode` (match `upstreamCode ?? code` for codes such
 * as `SERVER_NOT_READY` that normalise to `UNKNOWN`).
 */
export const VcaasErrorEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: VcaasErrorCodeSchema,
  upstreamCode: z.string().optional(),
  details: VcaasErrorDetailsSchema.optional(),
  data: z.null(),
  retryable: z.boolean().optional(),
});
export type VcaasErrorEnvelope = z.infer<typeof VcaasErrorEnvelopeSchema>;

/** `VcaasResponse<T>` as a schema: success or failure, discriminated on `ok`. */
export function vcaasResponseSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion("ok", [vcaasSuccessSchema(data), VcaasErrorEnvelopeSchema]);
}

export type VcaasSuccess<T> = { ok: true; data: T; meta?: VcaasPageMeta };
export type VcaasResponse<T> = VcaasSuccess<T> | VcaasErrorEnvelope;
