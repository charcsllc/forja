/** Frontend engineer: pages, components, `src/proxy.ts` (03 §1). Browser tools arrive in phase 3. */
import type { RoleDefinition } from "./types.js";

export const frontend: RoleDefinition = {
  role: "frontend",
  tools: ["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "bash", "image_find"],
  submitTools: ["submit_report"],
  defaultScope: ["src/app/**", "!src/app/api/**", "!src/app/globals.css", "src/components/layout/**", "src/modules/*/ui/**", "src/proxy.ts", "tests/components/**", "public/images/**"],
  modelRequirements: { capabilities: ["nativeTools"], minContextTokens: 64_000, preferredTier: "strong" },
  maxOutputTokens: 32_000,
  needsFrameworkSheet: true,
};
