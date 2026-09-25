/**
 * Custom domain shapes of API v1 (`project.customDomain`, `PUT/DELETE P/domain`).
 *
 * Protects: the domain lifecycle strings the UI renders. Both enums are open: an
 * unknown value must parse so the UI shows "still settling" instead of failing.
 */
import { z } from "zod";
import { openEnum } from "./known";

export const KNOWN_DOMAIN_STATUSES = [
  "pending_validation",
  "pending_deployment",
  "active",
  "blocked",
  "pending_deletion",
] as const;
export const DomainStatusSchema = openEnum(KNOWN_DOMAIN_STATUSES);
export type DomainStatus = z.infer<typeof DomainStatusSchema>;

export const KNOWN_DOMAIN_SSL_STATUSES = [
  "initializing",
  "authorizing",
  "issuing",
  "active",
  "expired",
  "timing_out",
  "validation_timed_out",
] as const;
export const DomainSslStatusSchema = openEnum(KNOWN_DOMAIN_SSL_STATUSES);
export type DomainSslStatus = z.infer<typeof DomainSslStatusSchema>;

export const DnsRecordSchema = z.object({
  type: z.string(),
  name: z.string(),
  value: z.string(),
});
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

export const VcaasDomainSchema = z.object({
  hostname: z.string(),
  status: DomainStatusSchema,
  sslStatus: DomainSslStatusSchema,
  dnsRecordsToAdd: z.array(DnsRecordSchema).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type VcaasDomain = z.infer<typeof VcaasDomainSchema>;

/** `PUT P/domain`. The response is ignored; the UI re-reads `project.customDomain`. */
export const DomainSetRequestSchema = z.object({ hostname: z.string().min(1) });
export type DomainSetRequest = z.infer<typeof DomainSetRequestSchema>;
