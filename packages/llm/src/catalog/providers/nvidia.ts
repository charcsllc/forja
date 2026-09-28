/**
 * NVIDIA NIM (build.nvidia.com), OpenAI-compatible, the first provider with a live adapter.
 *
 * What this file protects:
 * - Only ids present in the captured `GET /v1/models` (test/fixtures/nvidia/models.json,
 *   82 ids, 2026-09-28) and useful to agents are listed.
 * - Capabilities are conservative: native tools only where a streamed tool call was
 *   captured (`z-ai/glm-5.3`) or where the same GLM-5.3 family and NIM tool parser make it
 *   certain (`z-ai/glm-5.3-flash`); vision only where the model name proves it.
 * - Contexts are 131 072 tokens (NIM's usual serving length), not the vendor maximum.
 * - Price is 0: the free tier is rate-limited (≈40 requests/min, `LLM_NVIDIA_RPM`), not
 *   billed. The first byte took 131 s on the free endpoint, hence the 300 s timeout.
 */
import { caps, FREE } from "../price.js";
import type { ModelDefinition, ProviderDefinition } from "../types.js";
import { OPENAI_COMPATIBLE_QUIRKS } from "../defaults.js";

const VERIFIED_AT = "2026-09-28";
const FROM_MODELS = "GET https://integrate.api.nvidia.com/v1/models (packages/llm/test/fixtures/nvidia/models.json)";
const FROM_CAPTURE = "streamed tool call + tool-result turn captured from z-ai/glm-5.3 (packages/llm/test/fixtures/nvidia/tool-*.{request.json,response.sse})";
const PRICE_NOTE = "free tier: rate-limited (≈40 req/min), not billed";
const CONTEXT = 131_072;

function model(m: Omit<ModelDefinition, "price" | "priceNote" | "verifiedAt" | "contextTokens"> & { contextTokens?: number }): ModelDefinition {
  return { contextTokens: CONTEXT, price: FREE, priceNote: PRICE_NOTE, verifiedAt: VERIFIED_AT, ...m };
}

export const nvidia: ProviderDefinition = {
  id: "nvidia",
  displayName: "NVIDIA NIM",
  adapter: "openai-compatible",
  adapterReady: true,
  defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
  local: false,
  appendFamilyNote: true,
  quirks: OPENAI_COMPATIBLE_QUIRKS,
  limits: { rpm: 40, firstByteTimeoutMs: 300_000, idleTimeoutMs: 120_000 },
  verifiedAt: VERIFIED_AT,
  verifiedFrom: FROM_MODELS,
  notes: "Free endpoint: 131 s to first byte observed; tool calls arrive as one complete delta.",
  models: [
    model({
      id: "z-ai/glm-5.3",
      tier: "frontier",
      family: "glm",
      maxOutputTokens: 32_768,
      // Thinking streamed as `reasoning_content`; a history without it was accepted.
      capabilities: caps({ nativeTools: true, thinking: "always" }),
      verifiedFrom: `${FROM_MODELS}; ${FROM_CAPTURE}`,
    }),
    model({
      id: "z-ai/glm-5.3-flash",
      tier: "fast",
      family: "glm",
      maxOutputTokens: 32_768,
      capabilities: caps({ nativeTools: true, thinking: "optional" }),
      verifiedFrom: FROM_MODELS,
      notes: "nativeTools inferred from the GLM-5.3 capture (same family and NIM tool parser); not captured itself.",
    }),
    model({
      id: "moonshotai/kimi-k3",
      tier: "frontier",
      family: "kimi",
      maxOutputTokens: 32_768,
      capabilities: caps({ thinking: "always", reasoningEcho: "reasoning_content" }),
      verifiedFrom: FROM_MODELS,
      notes: "Tool calling on NIM not captured yet: nativeTools false until it is.",
    }),
    model({
      id: "moonshotai/kimi-k2.6",
      tier: "strong",
      family: "kimi",
      maxOutputTokens: 32_768,
      capabilities: caps({ reasoningEcho: "reasoning_content" }),
      verifiedFrom: FROM_MODELS,
    }),
    model({
      id: "deepseek-ai/deepseek-v4.1-flash",
      tier: "fast",
      family: "deepseek",
      maxOutputTokens: 32_768,
      capabilities: caps({ thinking: "optional", reasoningEcho: "reasoning_content" }),
      verifiedFrom: FROM_MODELS,
      notes: "Vision exists on DeepSeek's own API; not assumed on NIM.",
    }),
    model({
      id: "openai/gpt-oss-20b",
      tier: "fast",
      family: "gpt-oss",
      maxOutputTokens: 16_384,
      capabilities: caps({ thinking: "always" }),
      verifiedFrom: FROM_MODELS,
    }),
    model({
      id: "nvidia/nemotron-3-super-120b-a12b",
      tier: "strong",
      family: "nemotron",
      maxOutputTokens: 16_384,
      capabilities: caps({ thinking: "optional" }),
      verifiedFrom: FROM_MODELS,
    }),
    model({
      id: "meta/llama-3.2-90b-vision-instruct",
      tier: "strong",
      family: "llama",
      maxOutputTokens: 8_192,
      capabilities: caps({ vision: true }),
      verifiedFrom: FROM_MODELS,
      notes: "Vision proven by the model name; tool calling not captured.",
    }),
  ],
};
