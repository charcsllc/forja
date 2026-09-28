/**
 * The system prompt assembler (docs/prompts/README.md "Cada agente recibe…").
 *
 * Order: `_base-engineer.md` → `roles/<role>.md` → `providers/<provider>.md` → for
 * aggregators and local servers, `providers/<family>.md` of the model (e.g. NVIDIA NIM
 * serving GLM → `nvidia.md` then `zai.md`; the catalog's `promptNotesFor` decides). The "Tool protocol" section (XML only) is
 * appended by the loop's protocol, and the orchestrator's context header travels as the
 * first user message, so the system prompt stays identical for every task of a role
 * (provider-side prompt caching).
 *
 * What this protects: prompts come only from the bundle generated from docs/prompts
 * (`bundle.generated.ts`), never from the filesystem at runtime; a missing role prompt is
 * a programming error, a missing provider or family note is simply skipped.
 */
import type { AgentRole } from "@forja/contracts";
import { getProviderDefinition, promptNotesFor } from "@forja/llm";
import { PROMPT_BUNDLE } from "./bundle.generated.js";

const FAMILY_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|[/:_-])glm|z-ai|zai|zhipu/i, "zai"],
  [/qwen|qwq/i, "qwen"],
  [/deepseek/i, "deepseek"],
  [/kimi|moonshot/i, "moonshot"],
  [/minimax/i, "minimax"],
  [/mistral|mixtral|codestral|devstral|magistral|ministral/i, "mistral"],
  [/claude|anthropic/i, "anthropic"],
  [/gemini|gemma|google\//i, "google"],
  [/grok|x-ai|xai\//i, "xai"],
  [/(^|[/:])(gpt|o\d|chatgpt|openai)/i, "openai"],
];

/**
 * The prompt family note of a model id (`z-ai/glm-5.3` → `zai`), or null. Only used for
 * models the catalog does not know (`LLM_<P>_EXTRA_MODELS`); catalog models carry their
 * family and `promptNotesFor` (packages/llm) decides.
 */
export function modelFamily(modelId: string): string | null {
  for (const [re, family] of FAMILY_RULES) if (re.test(modelId)) return family;
  return null;
}

/**
 * Provider and family notes for a `provider:model`, in order (nvidia + GLM →
 * ["nvidia", "zai"]). The catalog is the source of truth; unknown models of an aggregator
 * fall back to the id heuristic.
 */
export function promptNotes(provider: string, modelId: string): string[] {
  const def = getProviderDefinition(provider);
  if (!def) {
    const family = modelFamily(modelId);
    return family && family !== provider ? [provider, family] : [provider];
  }
  const known = def.models.find((m) => m.id === modelId);
  if (known) return promptNotesFor(provider, known);
  const family = def.appendFamilyNote ? modelFamily(modelId) : null;
  return family && family !== provider ? [provider, family] : [provider];
}

/** `"nvidia:z-ai/glm-5.3"` → `{ provider: "nvidia", model: "z-ai/glm-5.3" }`. */
export function splitModelRef(ref: string): { provider: string; model: string } {
  const i = ref.indexOf(":");
  return i === -1 ? { provider: ref, model: "" } : { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export interface AssembledPrompt {
  system: string;
  /** Which bundle files went in, in order (logged and asserted in tests). */
  parts: string[];
}

export interface AssembleInput {
  role: AgentRole;
  /** `provider:model` the role is routed to; absent = no provider notes. */
  model?: string | null;
}

export function assembleSystemPrompt({ role, model }: AssembleInput): AssembledPrompt {
  const rolePrompt = PROMPT_BUNDLE.roles[role];
  if (!rolePrompt) throw new Error(`no prompt for role "${role}" in the bundle`);
  const sections = [PROMPT_BUNDLE.base.trim(), rolePrompt.trim()];
  const parts = ["_base-engineer.md", `roles/${role}.md`];
  if (model) {
    const { provider, model: modelId } = splitModelRef(model);
    for (const note of promptNotes(provider, modelId)) {
      const text = PROMPT_BUNDLE.providers[note];
      if (!text) continue;
      sections.push(text.trim());
      parts.push(`providers/${note}.md`);
    }
  }
  return { system: `${sections.join("\n\n---\n\n")}\n`, parts };
}

/** A bundled reference sheet (`src/context/<name>.md`). */
export function contextSheet(name: string): string {
  const sheet = PROMPT_BUNDLE.context[name];
  if (!sheet) throw new Error(`no context sheet "${name}" in the bundle`);
  return sheet;
}
