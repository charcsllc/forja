/**
 * Secret shapes of API v1 (`project.secrets`, `POST P/secrets`, `DELETE P/secrets/{_id}`).
 *
 * Protects: secret values are write-only. No response shape carries `secretValue`.
 */
import { z } from "zod";

export const SecretEnvironmentSchema = z.enum(["development", "production", "both"]);
export type SecretEnvironment = z.infer<typeof SecretEnvironmentSchema>;

/** A secret as listed on the project: name and scope, never the value. */
export const VcaasSecretSchema = z.object({
  _id: z.string(),
  secretName: z.string(),
  environment: SecretEnvironmentSchema,
});
export type VcaasSecret = z.infer<typeof VcaasSecretSchema>;

export const SecretCreateRequestSchema = z.object({
  secretName: z.string().min(1),
  secretValue: z.string(),
  environment: SecretEnvironmentSchema,
});
export type SecretCreateRequest = z.infer<typeof SecretCreateRequestSchema>;
