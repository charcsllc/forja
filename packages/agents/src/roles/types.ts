/**
 * What a role is to the runtime (docs/architecture/03 §1: `packages/agents/src/roles/<rol>.ts`
 * is the source of truth for scopes, tools, model requirements and final output).
 */
import type { AgentRole } from "@forja/contracts";
import type { ModelRequirements } from "@forja/llm";

export interface RoleDefinition {
  role: AgentRole;
  /** Tools besides the submit tools, from the registry. */
  tools: readonly string[];
  /** The `submit_*` tools this role may call; the first is its normal final output. */
  submitTools: readonly string[];
  /** Default write scope (globs) when a task does not narrow it; empty = read-only role. */
  defaultScope: readonly string[];
  /** Contract C2: what a model must offer to play this role. */
  modelRequirements: ModelRequirements;
  /** Default `maxOutputTokens` (AGENT_<ROLE>_MAX_OUTPUT_TOKENS overrides). */
  maxOutputTokens: number;
  /** `bash` restricted to these command prefixes (03 §1 table). */
  bashAllowlist?: readonly string[];
  /** Whether the Next.js 16 reference sheet goes in the task context. */
  needsFrameworkSheet: boolean;
}
