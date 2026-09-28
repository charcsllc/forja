/**
 * The roles implemented in this phase and their model requirements.
 *
 * What this protects: `ROLE_REQUIREMENTS` is what the engine hands to
 * `createLlmGateway({ requirements })` (contract C2), so the router assigns a model to
 * exactly the roles the runtime can run, and the engine can tell at boot whether they are
 * all satisfiable. Phase-3 roles (designer, brand, imagery, copywriter, supervisor, qa,
 * reviewer, security, docs) are deliberately absent.
 */
import type { AgentRole } from "@forja/contracts";
import type { ModelRequirements } from "@forja/llm";
import { backend } from "./backend.js";
import { database } from "./database.js";
import { director } from "./director.js";
import { fixer } from "./fixer.js";
import { frontend } from "./frontend.js";
import { summarizer } from "./summarizer.js";
import type { RoleDefinition } from "./types.js";

export { FIXER_BASH_ALLOWLIST } from "./fixer.js";
export type { RoleDefinition } from "./types.js";

export const PHASE2_ROLES = ["director", "frontend", "backend", "database", "fixer", "summarizer"] as const satisfies readonly AgentRole[];
export type Phase2Role = (typeof PHASE2_ROLES)[number];

/** Roles the director may assign plan tasks to in this phase. */
export const PLANNABLE_ROLES: readonly AgentRole[] = ["frontend", "backend", "database"];

export const ROLE_DEFINITIONS: Readonly<Record<Phase2Role, RoleDefinition>> = {
  director,
  frontend,
  backend,
  database,
  fixer,
  summarizer,
};

export const ROLE_REQUIREMENTS: Partial<Record<AgentRole, ModelRequirements>> = Object.fromEntries(
  PHASE2_ROLES.map((r) => [r, ROLE_DEFINITIONS[r].modelRequirements]),
);

export function roleDefinition(role: AgentRole): RoleDefinition | undefined {
  return (ROLE_DEFINITIONS as Partial<Record<AgentRole, RoleDefinition>>)[role];
}
