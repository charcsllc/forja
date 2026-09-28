/**
 * Shared defaults for provider definitions.
 *
 * What this file protects: every OpenAI-shaped vendor starts from the same request
 * shape (`max_tokens`, usage in the stream) and the same timeouts, so a provider file only
 * states what differs, and the research date/source is written once.
 */
import type { ProviderLimits, ProviderQuirks } from "./types.js";

export const RESEARCH_DATE = "2026-09-25";

export const OPENAI_COMPATIBLE_QUIRKS: ProviderQuirks = { maxTokensParam: "max_tokens", streamUsage: true };

/** Hosted APIs: reasoning models can think for minutes before the first token. */
export const HOSTED_LIMITS: ProviderLimits = { firstByteTimeoutMs: 180_000, idleTimeoutMs: 120_000 };

/** Local runtimes load weights on the first call and run on modest hardware. */
export const LOCAL_LIMITS: ProviderLimits = { firstByteTimeoutMs: 600_000, idleTimeoutMs: 300_000 };
