/**
 * The provider catalog: one definition per LLM provider id, plus helpers.
 *
 * What this file protects:
 * - `CATALOG` covers every id in `LLM_PROVIDER_IDS` (checked by the type), so enabling a
 *   provider in env can never reach an undefined definition.
 * - `LLM_<P>_EXTRA_MODELS` extends a provider's list with conservative defaults (no vision,
 *   no native tools unless declared, price 0 unless known) and overrides a catalog entry
 *   with the same id field by field, so an operator can correct the catalog without a
 *   release.
 * - The prompt-note order for a model is fixed here: provider note, then family note for
 *   aggregators and local runtimes (docs/prompts/README.md).
 */
import type { ExtraModel, LlmProviderId } from "../env.js";
import { caps, FREE } from "./price.js";
import type { ModelDefinition, ModelFamily, ProviderDefinition } from "./types.js";
import { anthropic, deepseek, fireworks, google, groq, minimax, mistral, moonshot, openai, openrouter, qwen, together, xai, zai } from "./providers/first-party.js";
import { lmstudio, ollama, vllm } from "./providers/local.js";
import { nvidia } from "./providers/nvidia.js";

export * from "./types.js";
export * from "./price.js";

export const CATALOG: Readonly<Record<LlmProviderId, ProviderDefinition>> = {
  anthropic, openai, google, zai, qwen, deepseek, moonshot, minimax, mistral, xai, groq, together, fireworks, openrouter, nvidia, ollama, lmstudio, vllm,
};

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
  return (CATALOG as Record<string, ProviderDefinition>)[id];
}

/** Catalog models of a provider merged with the operator's `LLM_<P>_EXTRA_MODELS`. */
export function modelsWithExtras(def: ProviderDefinition, extras: ExtraModel[] | undefined): ModelDefinition[] {
  const out = def.models.map((m) => ({ ...m }));
  for (const extra of extras ?? []) {
    const existing = out.find((m) => m.id === extra.id);
    if (existing) {
      existing.contextTokens = extra.contextTokens;
      existing.maxOutputTokens = extra.maxOutputTokens;
      if (extra.tier) existing.tier = extra.tier;
      existing.capabilities = {
        ...existing.capabilities,
        ...(extra.vision !== undefined ? { vision: extra.vision } : {}),
        ...(extra.nativeTools !== undefined ? { nativeTools: extra.nativeTools } : {}),
      };
      existing.verifiedFrom = `${existing.verifiedFrom}; overridden by LLM_${def.id.toUpperCase()}_EXTRA_MODELS`;
      continue;
    }
    out.push({
      id: extra.id,
      tier: extra.tier ?? (def.local ? "local" : "strong"),
      ...(def.family ? { family: def.family } : {}),
      contextTokens: extra.contextTokens,
      maxOutputTokens: extra.maxOutputTokens,
      price: FREE,
      priceNote: "declared by the operator: price unknown, counted as 0",
      capabilities: caps({ vision: extra.vision ?? false, nativeTools: extra.nativeTools ?? false }),
      verifiedAt: "operator",
      verifiedFrom: `LLM_${def.id.toUpperCase()}_EXTRA_MODELS`,
    });
  }
  return out;
}

/** Family → prompt note basename in docs/prompts/providers (null: no family note). */
export const FAMILY_NOTE: Readonly<Record<ModelFamily, string | null>> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  glm: "zai",
  qwen: "qwen",
  deepseek: "deepseek",
  kimi: "moonshot",
  minimax: "minimax",
  mistral: "mistral",
  grok: "xai",
  llama: null,
  "gpt-oss": null,
  nemotron: null,
};

/**
 * Prompt notes for a `provider:model`, in order: the provider's own note, then (for
 * aggregators and local runtimes) the model family's note. E.g. nvidia + z-ai/glm-5.3 →
 * ["nvidia", "zai"].
 */
export function promptNotesFor(providerId: string, model: Pick<ModelDefinition, "family"> | undefined): string[] {
  const def = getProviderDefinition(providerId);
  if (!def) return [];
  const notes = [def.id as string];
  const familyNote = def.appendFamilyNote && model?.family ? FAMILY_NOTE[model.family] : null;
  if (familyNote && familyNote !== def.id) notes.push(familyNote);
  return notes;
}
