/**
 * Fixer: mechanical fixes of type, lint and build errors (03 §1). Writes only the files in
 * the error list and their direct imports (the orchestrator computes that scope); `bash`
 * only for the checkers.
 */
import type { RoleDefinition } from "./types.js";

export const FIXER_BASH_ALLOWLIST: readonly string[] = [
  "npm run typecheck",
  "npm run lint",
  "npm run format",
  "npm run build",
  "npx tsc",
  "npx eslint",
  "npx prettier",
  "npx next build",
  "tsc",
  "eslint",
  "prettier",
];

export const fixer: RoleDefinition = {
  role: "fixer",
  tools: ["read_file", "edit_file", "grep", "glob", "list_dir", "bash"],
  submitTools: ["submit_report"],
  defaultScope: [],
  modelRequirements: { capabilities: ["nativeTools"], minContextTokens: 32_000, preferredTier: "fast" },
  maxOutputTokens: 16_000,
  bashAllowlist: FIXER_BASH_ALLOWLIST,
  needsFrameworkSheet: true,
};
