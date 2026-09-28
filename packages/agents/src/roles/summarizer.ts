/** Summarizer: context compaction and handoff summaries through `submit_summary` (03 §1). */
import type { RoleDefinition } from "./types.js";

export const summarizer: RoleDefinition = {
  role: "summarizer",
  tools: [],
  submitTools: ["submit_summary"],
  defaultScope: [],
  modelRequirements: { capabilities: ["nativeTools"], minContextTokens: 128_000, preferredTier: "fast" },
  maxOutputTokens: 8_000,
  needsFrameworkSheet: false,
};
