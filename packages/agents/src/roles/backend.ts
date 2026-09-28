/** Backend engineer: use cases, route handlers, server actions (03 §1). `http_probe` arrives in phase 3. */
import type { RoleDefinition } from "./types.js";

export const backend: RoleDefinition = {
  role: "backend",
  tools: ["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "bash"],
  submitTools: ["submit_report"],
  defaultScope: [
    "src/modules/*/domain/**",
    "src/modules/*/application/**",
    "src/modules/*/infrastructure/**",
    "src/modules/*/ui/actions.ts",
    "src/app/api/**",
    "src/jobs/**",
    "tests/modules/**",
  ],
  modelRequirements: { capabilities: ["nativeTools"], minContextTokens: 64_000, preferredTier: "strong" },
  maxOutputTokens: 32_000,
  needsFrameworkSheet: true,
};
