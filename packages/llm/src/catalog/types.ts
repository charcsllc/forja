/**
 * Catalog shapes (docs/architecture/02 §2).
 *
 * What this file protects:
 * - A model enters the catalog only with `verifiedAt` + `verifiedFrom`: every number and
 *   capability below was read from a vendor page or a captured response, or is the
 *   conservative default (`false`, smaller context) when it could not be verified.
 * - `adapterReady` is the single switch that tells the router whether a provider can be
 *   called today. An enabled provider without a ready adapter is skipped with one warning,
 *   never a boot failure.
 * - Provider quirks are data (plus pure functions of the request), so the one
 *   `openai-compatible` adapter serves every OpenAI-shaped vendor without branching on ids.
 */
import type { LlmProviderId } from "../env.js";
import type { Effort } from "../types.js";

export type ProviderId = LlmProviderId;

export type AdapterKind = "anthropic" | "openai-responses" | "google" | "openai-compatible";

/** Model family: picks the family prompt note for aggregators and local runtimes. */
export type ModelFamily =
  | "anthropic" | "openai" | "google" | "glm" | "qwen" | "deepseek" | "kimi" | "minimax" | "mistral"
  | "llama" | "grok" | "gpt-oss" | "nemotron";

export type ModelTier = "frontier" | "strong" | "fast" | "local";

export interface TokenUsage {
  /** Uncached prompt tokens. */
  input: number;
  /** Completion tokens, reasoning included. */
  output: number;
  cachedInput: number;
  cacheWrite: number;
}

/** Cost in USD of one call. `at` lets peak/off-peak tariffs price by the UTC hour. */
export type PriceFn = (usage: TokenUsage, at: Date) => number;

export type ReasoningEcho = "none" | "thinking-blocks" | "reasoning_content" | "thought_signature" | "encrypted" | "reasoning_details";

export interface ModelCapabilities {
  nativeTools: boolean;
  parallelTools: boolean;
  forcedToolChoice: boolean;
  jsonSchema: boolean;
  vision: boolean;
  thinking: "none" | "optional" | "always";
  /** What must travel back in the assistant message for the next turn to be accepted. */
  reasoningEcho: ReasoningEcho;
  /** Tool-call arguments arrive as incremental deltas (vs one complete delta). */
  streamingToolCalls: boolean;
}

export interface ModelDefinition {
  id: string;
  tier: ModelTier;
  family?: ModelFamily;
  contextTokens: number;
  maxOutputTokens: number;
  price: PriceFn;
  /** Human note about the price (free tier, conservative bound, unverified threshold...). */
  priceNote?: string;
  capabilities: ModelCapabilities;
  /** ISO date the facts were checked. */
  verifiedAt: string;
  /** Where they were checked (URL, or the captured fixture). */
  verifiedFrom: string;
  notes?: string;
}

export interface ExtraBodyContext {
  model: ModelDefinition;
  effort?: Effort;
  hasTools: boolean;
}

export interface ProviderQuirks {
  /** Name of the output-limit field in Chat Completions. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";
  /** Send `stream_options: { include_usage: true }`. */
  streamUsage: boolean;
  /** Hard cap on tools per request, when the vendor has one. */
  maxTools?: number;
  /** Vendor-specific body fields (thinking toggles, tool streaming, effort names). */
  extraBody?: (ctx: ExtraBodyContext) => Record<string, unknown>;
  /** The vendor reports the call's cost in `usage.cost` (USD): use it instead of `price`. */
  usageCost?: boolean;
}

export interface ProviderLimits {
  /** Requests per minute when `LLM_<P>_RPM` is unset. Absent = no client-side limit. */
  rpm?: number;
  /** Concurrent requests when `LLM_<P>_MAX_CONCURRENCY` is unset. Absent = unlimited. */
  maxConcurrency?: number;
  /** Time allowed until the first body byte (`LLM_<P>_TIMEOUT_MS` overrides it). */
  firstByteTimeoutMs: number;
  /** Time allowed between two body chunks once streaming started. */
  idleTimeoutMs: number;
}

export interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  adapter: AdapterKind;
  /** False while the adapter is not implemented: the router skips the provider with a warning. */
  adapterReady: boolean;
  /** Family of the provider's own models (first-party vendors). */
  family?: ModelFamily;
  /** Undefined when the operator must supply `LLM_<P>_BASE_URL` (vLLM). */
  defaultBaseUrl?: string;
  local: boolean;
  /** Aggregators and local runtimes: the prompt assembler appends the model family note. */
  appendFamilyNote: boolean;
  models: ModelDefinition[];
  quirks: ProviderQuirks;
  limits: ProviderLimits;
  verifiedAt: string;
  verifiedFrom: string;
  notes?: string;
}
