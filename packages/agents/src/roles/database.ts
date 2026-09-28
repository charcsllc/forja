/** Database engineer: schema, migrations, seed, typed queries on `verify_<runId>` (03 §1). */
import type { RoleDefinition } from "./types.js";

export const database: RoleDefinition = {
  role: "database",
  tools: ["read_file", "write_file", "edit_file", "glob", "grep", "list_dir", "bash", "db_query", "db_introspect"],
  submitTools: ["submit_report"],
  defaultScope: ["src/db/**", "drizzle/**", "tests/db/**", "docs/adr/**"],
  modelRequirements: { capabilities: ["nativeTools"], minContextTokens: 64_000, preferredTier: "strong" },
  maxOutputTokens: 32_000,
  needsFrameworkSheet: true,
};
