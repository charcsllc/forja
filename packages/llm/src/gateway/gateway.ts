/**
 * `createLlmGateway`: the one `Provider` the agent runtime talks to (contract C2).
 *
 * What this file protects:
 * - Every generation starts with a `route` event naming the provider and model.
 * - A request walks its chain (`req.model` if pinned, then the role's model and
 *   fallbacks; degraded models last). Transient failures (429/5xx) are retried on the same
 *   model with backoff honouring `Retry-After`; timeouts and other failures move to the
 *   next model. `aborted` and `budget` stop immediately.
 * - Nothing is retried once output reached the caller: a retry would duplicate text or
 *   tool calls. The error is thrown instead.
 * - Our own rate limit (`LLM_<P>_RPM`, `_MAX_CONCURRENCY`) queues callers; it never fails
 *   a call.
 * - Budget: a call is refused (`LlmError("budget")`) when `remainingUsd() <= 0` before it
 *   starts, and every `usage` event is charged with the catalog price.
 * - Config problems that do not block boot (pending adapters, unusable env models, typos)
 *   are logged once at creation and kept in `warnings()`; malformed `AGENT_*` values throw
 *   `LlmConfigError`.
 */
import { getProviderDefinition, modelsWithExtras } from "../catalog/index.js";
import type { ModelDefinition } from "../catalog/types.js";
import { parseProviderEnv } from "../env.js";
import { LlmConfigError, LlmError, toLlmError } from "../errors.js";
import { AGENT_ROLES, type AgentRole, type GenerateEvent, type GenerateRequest } from "../types.js";
import { ModelHealth } from "./health.js";
import { realSleep } from "./limiter.js";
import { buildRegistry, type RoutableProvider } from "./registry.js";
import { parseModelRef, parseRoleConfig } from "./role-config.js";
import { assignRoles } from "./router.js";
import type { CreateLlmGatewayOptions, GatewayLogger, LlmGateway, LlmProviderSummary, RoleAssignment, RoleSettings } from "./types.js";

/** Same-model retries for retryable failures (so at most 3 attempts per model). */
export const MAX_RETRIES_PER_MODEL = 2;
export const BACKOFF_BASE_MS = 2_000;
export const MAX_RETRY_AFTER_MS = 120_000;

const silentLogger: GatewayLogger = { info() {}, warn() {}, error() {} };

interface Target {
  ref: string;
  provider: RoutableProvider;
  model: ModelDefinition;
}

function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new LlmError("aborted", "generation aborted", { retryable: false }));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new LlmError("aborted", "generation aborted", { retryable: false }));
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

export function backoffMs(retry: number, err: LlmError): number {
  if (err.retryAfterMs !== undefined) return Math.min(err.retryAfterMs, MAX_RETRY_AFTER_MS);
  return BACKOFF_BASE_MS * 2 ** retry;
}

export function createLlmGateway(opts: CreateLlmGatewayOptions): LlmGateway {
  const logger = opts.logger ?? silentLogger;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const report = parseProviderEnv(opts.env);
  const roleConfig = parseRoleConfig(opts.env); // throws LlmConfigError on malformed AGENT_* values
  const registry = buildRegistry(report, { ...(opts.fetch ? { fetch: opts.fetch } : {}), now, sleep });
  const { assignments, warnings: routeWarnings } = assignRoles(roleConfig.roles, opts.requirements, registry, new Date(now()));
  const health = new ModelHealth(now);

  const warnings = [
    ...registry.warnings,
    ...routeWarnings,
    ...roleConfig.unknownVariables.map((v) => `${v} names no agent role (typo?)`),
  ];
  for (const w of registry.skipped) logger.warn({ provider: w.id }, w.reason);
  for (const w of warnings.filter((w) => !registry.skipped.some((s) => s.reason === w))) logger.warn({}, w);

  function target(ref: string): Target | undefined {
    const parsed = parseModelRef(ref);
    if (!parsed) return undefined;
    const provider = registry.providers.get(parsed.provider);
    const model = provider?.models.find((m) => m.id === parsed.model);
    return provider && model ? { ref: `${parsed.provider}:${model.id}`, provider, model } : undefined;
  }

  function chainFor(req: GenerateRequest): Target[] {
    const a = assignments.get(req.role);
    const refs = [req.model, a?.model ?? undefined, ...(a?.fallbacks ?? [])].filter((r): r is string => typeof r === "string" && r !== "");
    const seen = new Set<string>();
    const targets: Target[] = [];
    for (const ref of refs) {
      const t = target(ref);
      if (!t) {
        if (ref === req.model) logger.warn({ role: req.role, model: ref }, "requested model is not routable; using the role's chain");
        continue;
      }
      if (seen.has(t.ref)) continue;
      seen.add(t.ref);
      targets.push(t);
    }
    return [...targets.filter((t) => !health.isDegraded(t.ref)), ...targets.filter((t) => health.isDegraded(t.ref))];
  }

  function checkBudget(req: GenerateRequest, t?: Target): void {
    if (req.budget.remainingUsd() <= 0) {
      throw new LlmError("budget", `budget exhausted before calling ${t ? t.ref : "a model"} for role ${req.role}`, {
        retryable: false,
        ...(t ? { provider: t.provider.definition.id, model: t.model.id } : {}),
      });
    }
  }

  async function* generate(req: GenerateRequest): AsyncGenerator<GenerateEvent> {
    const chain = chainFor(req);
    if (chain.length === 0) {
      const reason = assignments.get(req.role)?.error;
      throw new LlmError("unavailable", `no model available for role ${req.role}${reason ? `: ${reason}` : ""}`, { retryable: false });
    }
    checkBudget(req);
    const effort = req.effort ?? roleConfig.roles[req.role].effort;
    const effective: GenerateRequest = effort ? { ...req, effort } : req;

    let attempt = 0;
    let lastError: LlmError | undefined;
    for (const t of chain) {
      for (let retry = 0; ; retry++) {
        attempt++;
        checkBudget(req, t);
        const release = await t.provider.limiter.acquire(req.abortSignal);
        let emitted = false;
        let waitMs: number | undefined;
        try {
          yield { type: "route", provider: t.provider.definition.id, model: t.model.id, attempt };
          for await (const ev of t.provider.adapter.stream(t.model, effective)) {
            emitted = true;
            if (ev.type === "usage") req.budget.charge(ev.costUsd);
            yield ev;
          }
          health.success(t.ref);
          return;
        } catch (e) {
          const err = toLlmError(e, { provider: t.provider.definition.id, model: t.model.id });
          if (err.code === "aborted" || err.code === "budget" || emitted || req.abortSignal.aborted) throw err;
          if (health.failure(t.ref, err)) logger.warn({ model: t.ref, code: err.code }, `model ${t.ref} degraded after repeated failures; it goes last for a while`);
          lastError = err;
          if (err.retryable && err.code !== "timeout" && retry < MAX_RETRIES_PER_MODEL) {
            waitMs = backoffMs(retry, err);
            logger.warn({ model: t.ref, code: err.code, attempt, waitMs }, `retrying ${t.ref} after ${err.code}`);
          } else {
            logger.warn({ model: t.ref, code: err.code, attempt }, `giving up on ${t.ref}: ${err.message}`);
          }
        } finally {
          release(); // never hold a slot while backing off
        }
        if (waitMs === undefined) break;
        await abortableSleep(sleep, waitMs, req.abortSignal);
      }
    }
    throw lastError ?? new LlmError("unavailable", `no model answered for role ${req.role}`, { retryable: false });
  }

  function roleSettings(role: AgentRole): RoleSettings {
    const c = roleConfig.roles[role];
    return { role, ...(c.effort ? { effort: c.effort } : {}), maxOutputTokens: c.maxOutputTokens, toolProtocol: c.toolProtocol };
  }

  function providerSummaries(): LlmProviderSummary[] {
    return report.providers
      .filter((p) => p.kind === "llm")
      .map((p) => {
        const def = getProviderDefinition(p.id);
        return {
          id: p.id,
          kind: "llm" as const,
          envName: p.envName,
          status: p.status,
          adapterReady: def?.adapterReady ?? false,
          models: def ? modelsWithExtras(def, p.extraModels).map((m) => m.id) : [],
        };
      });
  }

  return {
    id: "gateway",
    report,
    generate,
    assignments: (): RoleAssignment[] =>
      AGENT_ROLES.map((r) => assignments.get(r))
        .filter((a): a is RoleAssignment => a !== undefined)
        .map((a) => ({ ...a, fallbacks: [...a.fallbacks] })),
    assertRolesSatisfiable(roles: AgentRole[]): void {
      const errors = roles.map((r) => assignments.get(r)).filter((a): a is RoleAssignment => a !== undefined && a.model === null).map((a) => a.error ?? `role \`${a.role}\` has no model`);
      if (errors.length > 0) throw new LlmConfigError(errors.join("\n"));
    },
    roleSettings,
    providerSummaries,
    warnings: () => [...warnings],
  };
}
