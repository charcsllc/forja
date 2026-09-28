/**
 * Gateway contract (C2 in the phase 2 brief): what `@forja/agents` and the engine see.
 *
 * What this file protects: the shapes below are consumed by other packages and by
 * `GET /v2/system/models`; they are safe to serialise (no key, no function values except
 * the methods of `LlmGateway`).
 */
import type { ProviderEnvReport, ProviderStatus } from "../env.js";
import type { AgentRole, Effort, Provider } from "../types.js";
import type { ToolProtocol } from "./role-config.js";

export interface ModelRequirements {
  capabilities: Array<"nativeTools" | "jsonSchema" | "vision">;
  minContextTokens: number;
  preferredTier: "frontier" | "strong" | "fast";
  maxPricePer1MOutput?: number;
  /** Soft: a model of another family is preferred; if none exists the role still gets one (with a warning). */
  differentFamilyThan?: AgentRole[];
}

export interface RoleAssignment {
  role: AgentRole;
  /** `provider:model`, e.g. `nvidia:z-ai/glm-5.3`; null when nothing satisfies the role. */
  model: string | null;
  fallbacks: string[];
  source: "env" | "auto";
  /** Why no model satisfies the role. */
  error?: string;
}

export interface GatewayLogger {
  info(o: object, m?: string): void;
  warn(o: object, m?: string): void;
  error(o: object, m?: string): void;
}

export interface CreateLlmGatewayOptions {
  env: Record<string, string | undefined>;
  /** Declared by the roles in @forja/agents. */
  requirements: Partial<Record<AgentRole, ModelRequirements>>;
  logger?: GatewayLogger;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Injectable for tests: resolves after `ms` (rate-limit waits and retry backoff). */
  sleep?: (ms: number) => Promise<void>;
}

/** Same as the env report; the alias names it as the contract does. */
export type ProviderReport = ProviderEnvReport;

/** Per-role settings the agent runtime applies to its requests. */
export interface RoleSettings {
  role: AgentRole;
  effort?: Effort;
  maxOutputTokens: number;
  toolProtocol: ToolProtocol;
}

/** One LLM provider as `GET /v2/system/models` lists it (contract C3). */
export interface LlmProviderSummary {
  id: string;
  kind: "llm";
  envName: string;
  status: ProviderStatus;
  adapterReady: boolean;
  models: string[];
}

export interface LlmGateway extends Provider {
  /** Safe to serialise (env.ts): never contains a key. */
  readonly report: ProviderReport;
  assignments(): RoleAssignment[];
  /** Throws `LlmConfigError` naming exactly what is missing. */
  assertRolesSatisfiable(roles: AgentRole[]): void;
  roleSettings(role: AgentRole): RoleSettings;
  providerSummaries(): LlmProviderSummary[];
  /** Non-fatal configuration findings (skipped providers, unusable env models, typos). */
  warnings(): string[];
}
