/**
 * Director: classifies, plans, answers questions and writes the closing message.
 * Read-only on code; its outputs are `submit_intent`, `submit_plan`, `submit_decision`,
 * `submit_message` (03 §1). Native tools are what it needs for structured output: every
 * submission is validated with zod by the loop, so JSON-schema mode is not required.
 */
import type { RoleDefinition } from "./types.js";

export const director: RoleDefinition = {
  role: "director",
  tools: ["read_file", "grep", "glob", "list_dir", "git_log", "git_diff"],
  submitTools: ["submit_intent", "submit_plan", "submit_decision", "submit_message"],
  defaultScope: [],
  modelRequirements: { capabilities: ["nativeTools"], minContextTokens: 128_000, preferredTier: "frontier" },
  maxOutputTokens: 16_000,
  needsFrameworkSheet: false,
};
