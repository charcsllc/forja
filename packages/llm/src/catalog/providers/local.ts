/**
 * Local runtimes (Ollama, LM Studio, vLLM): OpenAI-compatible, no catalog models.
 *
 * What this file protects: a local model's facts depend on what the operator pulled and
 * how it is served (`num_ctx`, `--tool-call-parser`), so nothing is assumed: models come
 * only from `LLM_<P>_EXTRA_MODELS`, and generous timeouts cover weight loading.
 */
import type { ProviderDefinition } from "../types.js";
import { LOCAL_LIMITS, OPENAI_COMPATIBLE_QUIRKS, RESEARCH_DATE } from "../defaults.js";

function local(id: "ollama" | "lmstudio" | "vllm", displayName: string, defaultBaseUrl: string | undefined, verifiedFrom: string): ProviderDefinition {
  return {
    id,
    displayName,
    adapter: "openai-compatible",
    adapterReady: true,
    ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
    local: true,
    appendFamilyNote: true,
    quirks: OPENAI_COMPATIBLE_QUIRKS,
    limits: LOCAL_LIMITS,
    verifiedAt: RESEARCH_DATE,
    verifiedFrom,
    notes: "Declare models with LLM_<P>_EXTRA_MODELS.",
    models: [],
  };
}

export const ollama = local("ollama", "Ollama", "http://localhost:11434/v1", "https://docs.ollama.com/api/openai-compatibility");
export const lmstudio = local("lmstudio", "LM Studio", "http://localhost:1234/v1", "https://lmstudio.ai/docs/developer/openai-compat");
export const vllm = local("vllm", "vLLM", undefined, "https://docs.vllm.ai/en/latest/features/tool_calling.html");
