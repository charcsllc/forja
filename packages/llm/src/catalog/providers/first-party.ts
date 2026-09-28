/**
 * First-party vendor catalogs (docs/research/03 §A.2, checked 2026-09-25).
 *
 * What this file protects:
 * - Only models whose id, context and price the research recorded; anything marked
 *   unverified there is either left out (operators add it with `LLM_<P>_EXTRA_MODELS`) or
 *   carries a conservative figure and a `priceNote`/`notes` saying so.
 * - Vendors that need their own protocol for tools with reasoning (Anthropic Messages,
 *   OpenAI and xAI Responses with encrypted reasoning, Gemini `thought_signature`) are
 *   `adapterReady: false` until those adapters land; the router skips them with a warning.
 * - Everything OpenAI-shaped uses the one `openai-compatible` adapter; vendor switches
 *   (thinking, effort names, tool streaming) live in `quirks.extraBody`.
 */
import { caps, flatPrice, peakPrice, promptTieredPrice } from "../price.js";
import type { ExtraBodyContext, ModelDefinition, ProviderDefinition } from "../types.js";
import { HOSTED_LIMITS, OPENAI_COMPATIBLE_QUIRKS, RESEARCH_DATE } from "../defaults.js";
import type { Effort } from "../../types.js";

type Entry = Omit<ModelDefinition, "verifiedAt" | "verifiedFrom">;
const verified = (from: string) => (m: Entry): ModelDefinition => ({ ...m, verifiedAt: RESEARCH_DATE, verifiedFrom: from });

/** Vendors whose effort scale is low|high|max (GLM, Kimi). */
const LOW_HIGH_MAX: Record<Effort, string> = { low: "low", medium: "high", high: "high", xhigh: "max" };
/** Vendors whose scale stops at high. */
const LOW_MEDIUM_HIGH: Record<Effort, string> = { low: "low", medium: "medium", high: "high", xhigh: "high" };

function thinks(ctx: ExtraBodyContext): boolean {
  return ctx.model.capabilities.thinking !== "none";
}

// ── Adapters not implemented yet ───────────────────────────────────────────

export const anthropic: ProviderDefinition = {
  id: "anthropic",
  displayName: "Anthropic",
  adapter: "anthropic",
  adapterReady: false,
  family: "anthropic",
  defaultBaseUrl: "https://api.anthropic.com/v1",
  local: false,
  appendFamilyNote: false,
  quirks: { maxTokensParam: "max_tokens", streamUsage: false },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://platform.claude.com/docs/en/about-claude/models/overview",
  models: [
    { id: "claude-fable-5-1", tier: "frontier", contextTokens: 1_000_000, maxOutputTokens: 128_000, price: flatPrice({ input: 10, output: 50 }), thinking: "always" as const },
    { id: "claude-opus-5-5", tier: "frontier", contextTokens: 1_000_000, maxOutputTokens: 128_000, price: flatPrice({ input: 4, output: 20 }), thinking: "always" as const },
    { id: "claude-sonnet-5", tier: "strong", contextTokens: 1_000_000, maxOutputTokens: 128_000, price: flatPrice({ input: 2, output: 10 }), thinking: "optional" as const },
    { id: "claude-haiku-4-5", tier: "fast", contextTokens: 200_000, maxOutputTokens: 64_000, price: flatPrice({ input: 1, output: 5 }), thinking: "optional" as const },
  ].map(({ thinking, ...m }) =>
    verified("https://platform.claude.com/docs/en/about-claude/models/overview")({
      ...m,
      tier: m.tier as ModelDefinition["tier"],
      family: "anthropic",
      capabilities: caps({ nativeTools: true, parallelTools: true, jsonSchema: true, vision: true, thinking, reasoningEcho: "thinking-blocks", streamingToolCalls: true }),
    }),
  ),
};

export const openai: ProviderDefinition = {
  id: "openai",
  displayName: "OpenAI",
  adapter: "openai-responses",
  adapterReady: false,
  family: "openai",
  defaultBaseUrl: "https://api.openai.com/v1",
  local: false,
  appendFamilyNote: false,
  quirks: { maxTokensParam: "max_completion_tokens", streamUsage: true },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://developers.openai.com/api/docs/models",
  notes: "Tools with reasoning need the Responses API (Chat Completions tools only work with reasoning_effort none).",
  models: [
    verified("https://developers.openai.com/api/docs/models/gpt-6-sol")({
      id: "gpt-6-sol",
      tier: "frontier",
      family: "openai",
      contextTokens: 1_050_000,
      maxOutputTokens: 128_000,
      price: promptTieredPrice(272_000, { input: 2, output: 10, cachedInput: 0.2 }, { input: 4, output: 20, cachedInput: 0.4 }),
      capabilities: caps({ nativeTools: true, parallelTools: true, forcedToolChoice: true, jsonSchema: true, vision: true, thinking: "optional", reasoningEcho: "encrypted", streamingToolCalls: true }),
    }),
    verified("https://developers.openai.com/api/docs/models")({
      id: "gpt-6-astra",
      tier: "frontier",
      family: "openai",
      contextTokens: 1_050_000,
      maxOutputTokens: 128_000,
      price: flatPrice({ input: 10, output: 50 }),
      capabilities: caps({ nativeTools: true, parallelTools: true, forcedToolChoice: true, jsonSchema: true, vision: true, thinking: "optional", reasoningEcho: "encrypted", streamingToolCalls: true }),
    }),
    verified("https://developers.openai.com/api/docs/models")({
      id: "gpt-6-luna",
      tier: "fast",
      family: "openai",
      contextTokens: 128_000,
      maxOutputTokens: 32_000,
      price: flatPrice({ input: 0.1, output: 0.5 }),
      capabilities: caps({ nativeTools: true, jsonSchema: true, thinking: "optional", reasoningEcho: "encrypted", streamingToolCalls: true }),
      notes: "Context and output not recorded by the research: conservative values.",
    }),
  ],
};

export const google: ProviderDefinition = {
  id: "google",
  displayName: "Google Gemini",
  adapter: "google",
  adapterReady: false,
  family: "google",
  defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
  local: false,
  appendFamilyNote: false,
  quirks: { maxTokensParam: "max_tokens", streamUsage: false },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://ai.google.dev/gemini-api/docs/models",
  notes: "Gemini 3 requires literal thought_signature replay on tool turns: native adapter only.",
  models: [
    verified("https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash")({
      id: "gemini-3.8-flash",
      tier: "strong",
      family: "google",
      contextTokens: 1_048_576,
      maxOutputTokens: 65_536,
      price: flatPrice({ input: 1.5, output: 7.5 }),
      priceNote: "tiered $0.75–1.50 / $3.75–7.50; the threshold is unrecorded, so the upper tier is used",
      capabilities: caps({ nativeTools: true, jsonSchema: true, vision: true, thinking: "optional", reasoningEcho: "thought_signature", streamingToolCalls: true }),
    }),
    verified("https://ai.google.dev/gemini-api/docs/pricing")({
      id: "gemini-3.1-pro-preview",
      tier: "frontier",
      family: "google",
      contextTokens: 200_000,
      maxOutputTokens: 65_536,
      price: flatPrice({ input: 4, output: 18 }),
      priceNote: "tiered $2–4 / $12–18: upper tier used",
      capabilities: caps({ nativeTools: true, jsonSchema: true, vision: true, thinking: "optional", reasoningEcho: "thought_signature", streamingToolCalls: true }),
      notes: "Context not recorded by the research: conservative 200K.",
    }),
  ],
};

export const xai: ProviderDefinition = {
  id: "xai",
  displayName: "xAI",
  adapter: "openai-responses",
  adapterReady: false,
  family: "grok",
  defaultBaseUrl: "https://api.x.ai/v1",
  local: false,
  appendFamilyNote: false,
  quirks: { maxTokensParam: "max_tokens", streamUsage: true },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://docs.x.ai/docs/models",
  notes: "grok-4.7 always returns encrypted reasoning: Responses API required for tool turns.",
  models: [
    verified("https://docs.x.ai/developers/grok-4-7")({
      id: "grok-4.7",
      tier: "frontier",
      family: "grok",
      contextTokens: 500_000,
      maxOutputTokens: 64_000,
      price: promptTieredPrice(200_000, { input: 2, output: 6 }, { input: 4, output: 12 }),
      capabilities: caps({ nativeTools: true, thinking: "always", reasoningEcho: "encrypted", streamingToolCalls: true }),
      notes: "Output limit not recorded: conservative 64K.",
    }),
    verified("https://docs.x.ai/docs/models")({
      id: "grok-build-0.1",
      tier: "strong",
      family: "grok",
      contextTokens: 256_000,
      maxOutputTokens: 64_000,
      price: flatPrice({ input: 1, output: 2 }),
      capabilities: caps({ nativeTools: true, thinking: "optional", reasoningEcho: "encrypted" }),
    }),
  ],
};

// ── OpenAI-compatible, adapter ready ───────────────────────────────────────

export const zai: ProviderDefinition = {
  id: "zai",
  displayName: "Z.ai (GLM)",
  adapter: "openai-compatible",
  adapterReady: true,
  family: "glm",
  defaultBaseUrl: "https://api.z.ai/api/paas/v4",
  local: false,
  appendFamilyNote: false,
  quirks: {
    ...OPENAI_COMPATIBLE_QUIRKS,
    maxTools: 128,
    extraBody: (ctx) => ({
      ...(ctx.hasTools ? { tool_stream: true } : {}),
      ...(ctx.effort && thinks(ctx) ? { reasoning_effort: LOW_HIGH_MAX[ctx.effort] } : {}),
    }),
  },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://docs.z.ai/api-reference/llm/chat-completion",
  models: [
    { id: "glm-5.3", tier: "frontier" as const, price: flatPrice({ input: 1.4, output: 4.4, cachedInput: 0.26 }), thinking: "always" as const },
    { id: "glm-5.3-flash", tier: "fast" as const, price: flatPrice({ input: 0.15, output: 0.5 }), thinking: "optional" as const },
    { id: "glm-5.3-flashx", tier: "fast" as const, price: flatPrice({ input: 0.37, output: 1.25 }), thinking: "optional" as const },
  ].map(({ thinking, ...m }) =>
    verified("https://docs.z.ai/guides/overview/pricing")({
      ...m,
      family: "glm",
      contextTokens: 200_000,
      maxOutputTokens: 131_072,
      capabilities: caps({ nativeTools: true, thinking, streamingToolCalls: true }),
      notes: "Context is 1M on the vendor page (unconfirmed): conservative 200K.",
    }),
  ),
};

export const qwen: ProviderDefinition = {
  id: "qwen",
  displayName: "Alibaba Qwen (Model Studio)",
  adapter: "openai-compatible",
  adapterReady: true,
  family: "qwen",
  defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  local: false,
  appendFamilyNote: false,
  quirks: {
    ...OPENAI_COMPATIBLE_QUIRKS,
    maxTools: 20,
    extraBody: (ctx) => (ctx.effort && ctx.model.capabilities.thinking === "optional" ? { enable_thinking: ctx.effort !== "low" } : {}),
  },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://www.alibabacloud.com/help/en/model-studio/model-pricing",
  notes: "Base URL is moving to per-workspace hosts: set LLM_QWEN_BASE_URL.",
  models: [
    verified("https://www.alibabacloud.com/help/en/model-studio/model-pricing")({
      id: "qwen3.8-max",
      tier: "frontier",
      family: "qwen",
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      price: flatPrice({ input: 2, output: 6 }),
      priceNote: "≈ figure from a secondary source",
      capabilities: caps({ nativeTools: true, thinking: "optional", streamingToolCalls: true }),
    }),
    verified("https://www.alibabacloud.com/help/en/model-studio/model-pricing")({
      id: "qwen3.7-plus",
      tier: "strong",
      family: "qwen",
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      price: flatPrice({ input: 0.32, output: 1.28 }),
      priceNote: "≈ figure from a secondary source",
      capabilities: caps({ nativeTools: true, thinking: "optional", streamingToolCalls: true }),
    }),
    verified("https://www.alibabacloud.com/help/en/model-studio/qwen-coder")({
      id: "qwen3-coder-next",
      tier: "strong",
      family: "qwen",
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      price: flatPrice({ input: 2, output: 6 }),
      priceNote: "unrecorded: priced at the qwen3.8-max upper bound",
      capabilities: caps({ nativeTools: true, streamingToolCalls: true }),
    }),
  ],
};

export const deepseek: ProviderDefinition = {
  id: "deepseek",
  displayName: "DeepSeek",
  adapter: "openai-compatible",
  adapterReady: true,
  family: "deepseek",
  defaultBaseUrl: "https://api.deepseek.com",
  local: false,
  appendFamilyNote: false,
  quirks: {
    ...OPENAI_COMPATIBLE_QUIRKS,
    extraBody: (ctx) => (ctx.effort ? { thinking: { type: ctx.effort === "low" ? "disabled" : "enabled" } } : {}),
  },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://api-docs.deepseek.com/quick_start/pricing",
  models: [
    { id: "deepseek-flash", tier: "fast" as const, vision: true, peak: { input: 0.3, output: 1.2 }, offPeak: { input: 0.15, output: 0.6 } },
    { id: "deepseek-v4-pro", tier: "strong" as const, vision: false, peak: { input: 1.32, output: 3.96 }, offPeak: { input: 0.66, output: 1.98 } },
  ].map(({ vision, peak, offPeak, ...m }) =>
    verified("https://api-docs.deepseek.com/quick_start/pricing")({
      ...m,
      family: "deepseek",
      contextTokens: 1_000_000,
      maxOutputTokens: 384_000,
      price: peakPrice({ hoursUtc: [[1, 4], [6, 10]], weekdaysOnly: true }, peak, offPeak),
      priceNote: "peak 01–04 and 06–10 UTC on weekdays",
      // With tools, every previous reasoning_content must be sent back or the API returns 400.
      capabilities: caps({ nativeTools: true, vision, thinking: "optional", reasoningEcho: "reasoning_content", streamingToolCalls: true }),
    }),
  ),
};

export const moonshot: ProviderDefinition = {
  id: "moonshot",
  displayName: "Moonshot Kimi",
  adapter: "openai-compatible",
  adapterReady: true,
  family: "kimi",
  defaultBaseUrl: "https://api.moonshot.ai/v1",
  local: false,
  appendFamilyNote: false,
  quirks: {
    ...OPENAI_COMPATIBLE_QUIRKS,
    extraBody: (ctx) => (ctx.effort && ctx.model.capabilities.thinking === "always" ? { reasoning_effort: LOW_HIGH_MAX[ctx.effort] } : {}),
  },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://platform.kimi.ai/docs/pricing/chat",
  models: [
    verified("https://platform.kimi.ai/docs/pricing/chat")({
      id: "kimi-k3",
      tier: "frontier",
      family: "kimi",
      contextTokens: 1_048_576,
      maxOutputTokens: 32_768,
      price: flatPrice({ input: 3, output: 15, cachedInput: 0.3 }),
      capabilities: caps({ nativeTools: true, thinking: "always", reasoningEcho: "reasoning_content", streamingToolCalls: true }),
    }),
    verified("https://platform.kimi.ai/docs/pricing/chat")({
      id: "kimi-k2.7-code",
      tier: "strong",
      family: "kimi",
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      price: flatPrice({ input: 0.95, output: 4, cachedInput: 0.19 }),
      capabilities: caps({ nativeTools: true, reasoningEcho: "reasoning_content", streamingToolCalls: true }),
    }),
  ],
};

export const minimax: ProviderDefinition = {
  id: "minimax",
  displayName: "MiniMax",
  adapter: "openai-compatible",
  adapterReady: true,
  family: "minimax",
  defaultBaseUrl: "https://api.minimax.io/v1",
  local: false,
  appendFamilyNote: false,
  quirks: OPENAI_COMPATIBLE_QUIRKS,
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://platform.minimax.io/docs/api-reference/api-overview",
  models: [
    verified("https://platform.minimax.io/docs/api-reference/api-overview")({
      id: "MiniMax-M3",
      tier: "strong",
      family: "minimax",
      contextTokens: 1_000_000,
      maxOutputTokens: 32_768,
      price: promptTieredPrice(512_000, { input: 0.6, output: 2.4 }, { input: 1.2, output: 4.8 }),
      priceNote: "≈ figure from a secondary source; doubles above 512K",
      capabilities: caps({ nativeTools: true, vision: true, thinking: "always" }),
    }),
  ],
};

export const mistral: ProviderDefinition = {
  id: "mistral",
  displayName: "Mistral",
  adapter: "openai-compatible",
  adapterReady: true,
  family: "mistral",
  defaultBaseUrl: "https://api.mistral.ai/v1",
  local: false,
  appendFamilyNote: false,
  quirks: {
    ...OPENAI_COMPATIBLE_QUIRKS,
    extraBody: (ctx) => (ctx.effort && thinks(ctx) ? { prompt_mode: "reasoning", reasoning_effort: ctx.effort } : {}),
  },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://docs.mistral.ai/getting-started/models/models_overview",
  models: [
    verified("https://docs.mistral.ai/getting-started/models/models_overview")({
      id: "mistral-medium-3505",
      tier: "strong",
      family: "mistral",
      contextTokens: 128_000,
      maxOutputTokens: 32_768,
      price: flatPrice({ input: 2, output: 6 }),
      priceNote: "unrecorded: conservative upper bound",
      capabilities: caps({ nativeTools: true, parallelTools: true, forcedToolChoice: true, jsonSchema: true, thinking: "optional", streamingToolCalls: true }),
    }),
    verified("https://docs.mistral.ai/getting-started/models/models_overview")({
      id: "devstral-2512",
      tier: "strong",
      family: "mistral",
      contextTokens: 262_144,
      maxOutputTokens: 32_768,
      price: flatPrice({ input: 0.4, output: 0.9 }),
      priceNote: "≈ figure from a secondary source",
      capabilities: caps({ nativeTools: true, parallelTools: true, jsonSchema: true, streamingToolCalls: true }),
    }),
  ],
};

export const groq: ProviderDefinition = {
  id: "groq",
  displayName: "Groq",
  adapter: "openai-compatible",
  adapterReady: true,
  defaultBaseUrl: "https://api.groq.com/openai/v1",
  local: false,
  appendFamilyNote: true,
  quirks: {
    ...OPENAI_COMPATIBLE_QUIRKS,
    extraBody: (ctx) => (ctx.effort && ctx.model.family === "gpt-oss" ? { reasoning_effort: LOW_MEDIUM_HIGH[ctx.effort] } : {}),
  },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://console.groq.com/docs/models",
  models: [
    verified("https://console.groq.com/docs/tool-use")({
      id: "openai/gpt-oss-20b",
      tier: "fast",
      family: "gpt-oss",
      contextTokens: 131_072,
      maxOutputTokens: 32_768,
      price: flatPrice({ input: 0.075, output: 0.3 }),
      // gpt-oss on Groq: no parallel tool calls.
      capabilities: caps({ nativeTools: true, thinking: "always", streamingToolCalls: true }),
    }),
  ],
};

export const together: ProviderDefinition = {
  id: "together",
  displayName: "Together AI",
  adapter: "openai-compatible",
  adapterReady: true,
  defaultBaseUrl: "https://api.together.xyz/v1",
  local: false,
  appendFamilyNote: true,
  quirks: OPENAI_COMPATIBLE_QUIRKS,
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://docs.together.ai/docs/serverless-models",
  notes: "Tool calling per model not recorded: nativeTools false until verified (override with LLM_TOGETHER_EXTRA_MODELS).",
  models: [
    { id: "deepseek-ai/DeepSeek-V4-Flash-0731", tier: "fast" as const, family: "deepseek" as const, price: flatPrice({ input: 0.14, output: 0.28 }) },
    { id: "zai-org/GLM-5.3-Flash", tier: "fast" as const, family: "glm" as const, price: flatPrice({ input: 0.15, output: 0.5 }) },
    { id: "deepseek-ai/DeepSeek-V4-Pro-0813", tier: "strong" as const, family: "deepseek" as const, price: flatPrice({ input: 1.32, output: 3.96 }) },
  ].map((m) =>
    verified("https://docs.together.ai/docs/serverless-models")({
      ...m,
      contextTokens: 1_000_000,
      maxOutputTokens: 32_768,
      capabilities: caps({ reasoningEcho: m.family === "deepseek" ? "reasoning_content" : "none" }),
    }),
  ),
};

export const fireworks: ProviderDefinition = {
  id: "fireworks",
  displayName: "Fireworks AI",
  adapter: "openai-compatible",
  adapterReady: true,
  defaultBaseUrl: "https://api.fireworks.ai/inference/v1",
  local: false,
  appendFamilyNote: true,
  quirks: OPENAI_COMPATIBLE_QUIRKS,
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://docs.fireworks.ai/tools-sdks/openai-compatibility",
  notes: "No model id verified yet: declare models with LLM_FIREWORKS_EXTRA_MODELS (accounts/fireworks/models/<name>).",
  models: [],
};

export const openrouter: ProviderDefinition = {
  id: "openrouter",
  displayName: "OpenRouter",
  adapter: "openai-compatible",
  adapterReady: true,
  defaultBaseUrl: "https://openrouter.ai/api/v1",
  local: false,
  appendFamilyNote: true,
  quirks: {
    ...OPENAI_COMPATIBLE_QUIRKS,
    usageCost: true,
    extraBody: (ctx) => (ctx.effort && thinks(ctx) ? { reasoning: { effort: LOW_MEDIUM_HIGH[ctx.effort] } } : {}),
  },
  limits: HOSTED_LIMITS,
  verifiedAt: RESEARCH_DATE,
  verifiedFrom: "https://openrouter.ai/docs/api-reference/overview",
  notes: "No model id pinned: declare models with LLM_OPENROUTER_EXTRA_MODELS. reasoning_details echo arrives with the aggregator work.",
  models: [],
};
