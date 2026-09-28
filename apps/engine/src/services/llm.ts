/**
 * The engine's door to language models: the LLM gateway (packages/llm, contract C2) plus
 * what the orchestrator needs to know about it (role models, context sizes, protocols) and
 * the `GET /v2/system/models` report (contract C3).
 *
 * What this protects:
 * - A broken or incomplete LLM configuration NEVER stops the engine: files, versions,
 *   database and previews keep working. `unavailableReason()` says, in operator terms,
 *   what to configure, and `agent/start` answers it (localized) instead of starting a run.
 * - The report never contains a key (the gateway's report is safe to serialise).
 * - Replay mode (`FORJA_LLM_REPLAY_DIR`, opt-in, for integration tests) wraps the gateway
 *   in the record/replay provider; `replay-or-fail` (the default of that mode) can never
 *   spend a request.
 * - Tests inject a provider with `createTestLlmService`; production code has no other
 *   way to replace the gateway.
 */
import { PHASE2_ROLES, ROLE_DEFINITIONS, ROLE_REQUIREMENTS, parseAgentSettings, type AgentSettings, type ToolProtocolName } from "@forja/agents";
import type { AgentRole } from "@forja/contracts";
import {
  LlmConfigError,
  createLlmGateway,
  createReplayProvider,
  getProviderDefinition,
  parseModelRef,
  parseProviderEnv,
  type Effort,
  type LlmGateway,
  type Provider,
  type ReplayMode,
  type RoleAssignment,
} from "@forja/llm";
import type { ImageSourcingPort } from "@forja/contracts/media";
import type { Logger } from "../logger.js";

export interface RoleRuntime {
  /** `provider:model` the role is routed to (null: gateway decides / unknown). */
  model: string | null;
  maxOutputTokens: number;
  protocol: ToolProtocolName;
  effort?: Effort;
  /** The routed model's context window (compaction trigger); null when unknown. */
  contextTokens: number | null;
}

export interface SystemModelsReport {
  providers: Array<{
    id: string;
    kind: "llm" | "image" | "stock";
    envName: string;
    status: "enabled" | "disabled" | "misconfigured";
    adapterReady: boolean;
    models?: string[];
  }>;
  assignments: RoleAssignment[];
}

export interface LlmService {
  /** What the agent loop calls (the gateway, or a test provider). */
  readonly provider: Provider;
  readonly settings: AgentSettings;
  /** Null when every phase-2 role has a model; otherwise what the operator must configure. */
  unavailableReason(): string | null;
  role(role: AgentRole): RoleRuntime;
  systemModels(imageSourcing?: ImageSourcingPort): SystemModelsReport;
}

const MISSING_PROVIDER_HINT =
  'Enable a provider in the engine environment, e.g. LLM_NVIDIA="true|<key>" (see docs/architecture/09-env-reference.md), or pin a model per role with AGENT_<ROLE>_MODEL=provider:model, then restart the engine.';

function refusingProvider(reason: string): Provider {
  return {
    id: "unavailable",
    // eslint-disable-next-line require-yield
    async *generate() {
      throw new LlmConfigError(reason);
    },
  };
}

function roleRuntimeFrom(gateway: LlmGateway | null, role: AgentRole): RoleRuntime {
  const def = (ROLE_DEFINITIONS as Partial<Record<AgentRole, (typeof ROLE_DEFINITIONS)["director"]>>)[role];
  const assignment = gateway?.assignments().find((a) => a.role === role);
  const settings = gateway?.roleSettings(role);
  const ref = assignment?.model ? parseModelRef(assignment.model) : undefined;
  const model = ref ? getProviderDefinition(ref.provider)?.models.find((m) => m.id === ref.model) : undefined;
  const wanted = settings?.toolProtocol ?? "auto";
  const protocol: ToolProtocolName = wanted === "xml" || (wanted === "auto" && model !== undefined && !model.capabilities.nativeTools) ? "xml" : "native";
  return {
    model: assignment?.model ?? null,
    maxOutputTokens: Math.min(settings?.maxOutputTokens ?? def?.maxOutputTokens ?? 16_000, model?.maxOutputTokens ?? Number.POSITIVE_INFINITY),
    protocol,
    ...(settings?.effort ? { effort: settings.effort } : {}),
    contextTokens: model?.contextTokens ?? null,
  };
}

function mediaProviders(env: Record<string, string | undefined>, imageSourcing?: ImageSourcingPort): SystemModelsReport["providers"] {
  const report = parseProviderEnv(env);
  const search = imageSourcing && "searchProviders" in imageSourcing ? new Set((imageSourcing as { searchProviders: readonly string[] }).searchProviders) : new Set<string>();
  return report.providers
    .filter((p) => p.kind !== "llm")
    .map((p) => ({
      id: p.id,
      kind: p.kind,
      envName: p.envName,
      status: p.status,
      // Image generation is not implemented in phase 2; stock search is when packages/media uses it.
      adapterReady: p.kind === "stock" && search.has(p.id),
    }));
}

export interface CreateLlmServiceOptions {
  env: Record<string, string | undefined>;
  logger: Logger;
}

export function createLlmService({ env, logger }: CreateLlmServiceOptions): LlmService {
  const settings = parseAgentSettings(env);
  for (const problem of settings.problems) logger.warn({ problem }, "agent setting ignored");
  let gateway: LlmGateway | null = null;
  let reason: string | null = null;
  try {
    gateway = createLlmGateway({ env, requirements: ROLE_REQUIREMENTS, logger: logger.child({ component: "llm" }) });
  } catch (err) {
    reason = `The LLM configuration is invalid: ${err instanceof Error ? err.message : String(err)}`;
    logger.error({ err: reason }, "LLM gateway not created: agent runs are disabled until the configuration is fixed");
  }
  if (gateway) {
    for (const a of gateway.assignments()) {
      if (!(PHASE2_ROLES as readonly string[]).includes(a.role)) continue;
      if (a.model) logger.info({ role: a.role, model: a.model, fallbacks: a.fallbacks, source: a.source }, "role assignment");
      else logger.error({ role: a.role, error: a.error }, "role has no model");
    }
    try {
      gateway.assertRolesSatisfiable([...PHASE2_ROLES]);
    } catch (err) {
      reason = `${err instanceof Error ? err.message : String(err)} ${MISSING_PROVIDER_HINT}`;
      logger.error({ err: reason }, "agent roles not satisfiable: the engine stays up, agent/start will explain what to configure");
    }
  }

  let provider: Provider = gateway ?? refusingProvider(reason ?? "no LLM gateway");
  const replayDir = env.FORJA_LLM_REPLAY_DIR?.trim();
  if (replayDir) {
    const mode = (env.FORJA_LLM_REPLAY_MODE?.trim() || "replay-or-fail") as ReplayMode;
    provider = createReplayProvider({ dir: replayDir, mode, ...(gateway ? { inner: gateway } : {}) });
    if (mode === "replay-or-fail") reason = null; // recordings alone can serve every role
    logger.warn({ dir: replayDir, mode }, "LLM replay mode: recorded generations are served (integration testing only)");
  }

  return {
    provider,
    settings,
    unavailableReason: () => reason,
    role: (role) => roleRuntimeFrom(gateway, role),
    systemModels: (imageSourcing) => ({
      providers: [...(gateway?.providerSummaries() ?? []), ...mediaProviders(env, imageSourcing)],
      assignments: gateway?.assignments() ?? [],
    }),
  };
}

/** Tests only: a service over an injected provider (scripted or replay), every role available. */
export function createTestLlmService(provider: Provider, opts: { env?: Record<string, string | undefined>; unavailable?: string; contextTokens?: number } = {}): LlmService {
  const settings = parseAgentSettings(opts.env ?? {});
  return {
    provider,
    settings,
    unavailableReason: () => opts.unavailable ?? null,
    role: (role) => ({
      model: null,
      maxOutputTokens: (ROLE_DEFINITIONS as Partial<Record<AgentRole, { maxOutputTokens: number }>>)[role]?.maxOutputTokens ?? 16_000,
      protocol: "native",
      contextTokens: opts.contextTokens ?? null,
    }),
    systemModels: () => ({ providers: [], assignments: [] }),
  };
}
