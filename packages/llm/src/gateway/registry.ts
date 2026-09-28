/**
 * Routable providers: enabled in env ∩ adapter implemented ∩ base URL known.
 *
 * What this file protects:
 * - An enabled provider whose adapter is not implemented yet is skipped with exactly one
 *   warning ("enabled but its adapter arrives later"), never a crash.
 * - The key is read once, through `report.getApiKey`, and handed only to the adapter.
 * - Env overrides win over catalog defaults: `LLM_<P>_BASE_URL`, `_TIMEOUT_MS` (first
 *   byte), `_RPM`, `_MAX_CONCURRENCY`, `_EXTRA_MODELS`.
 */
import { createOpenAICompatibleAdapter, type ChatAdapter } from "../adapters/openai-compatible.js";
import { getProviderDefinition, modelsWithExtras } from "../catalog/index.js";
import type { ModelDefinition, ProviderDefinition } from "../catalog/types.js";
import type { ProviderEntry, ProviderEnvReport } from "../env.js";
import { RateLimiter } from "./limiter.js";

export interface RoutableProvider {
  definition: ProviderDefinition;
  entry: ProviderEntry;
  models: ModelDefinition[];
  adapter: ChatAdapter;
  limiter: RateLimiter;
}

export interface Registry {
  /** In `LLM_PROVIDER_IDS` order. */
  providers: Map<string, RoutableProvider>;
  /** Enabled providers that cannot be called, with the reason (also in `warnings`). */
  skipped: Array<{ id: string; reason: string }>;
  warnings: string[];
}

export interface RegistryOptions {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function adapterPendingMessage(id: string): string {
  return `provider \`${id}\` is enabled but its adapter arrives later; it is skipped`;
}

export function buildRegistry(report: ProviderEnvReport, opts: RegistryOptions = {}): Registry {
  const providers = new Map<string, RoutableProvider>();
  const skipped: Registry["skipped"] = [];
  const warnings: string[] = [];
  const skip = (id: string, reason: string) => {
    skipped.push({ id, reason });
    warnings.push(reason);
  };

  for (const entry of report.providers) {
    if (entry.kind !== "llm" || entry.status !== "enabled") continue;
    const definition = getProviderDefinition(entry.id);
    if (!definition) {
      skip(entry.id, `provider \`${entry.id}\` has no catalog entry; it is skipped`);
      continue;
    }
    if (!definition.adapterReady || definition.adapter !== "openai-compatible") {
      skip(entry.id, adapterPendingMessage(entry.id));
      continue;
    }
    const baseUrl = entry.baseUrl ?? definition.defaultBaseUrl;
    if (!baseUrl) {
      skip(entry.id, `provider \`${entry.id}\` needs ${entry.envName}_BASE_URL; it is skipped`);
      continue;
    }
    const models = modelsWithExtras(definition, entry.extraModels);
    if (models.length === 0) warnings.push(`provider \`${entry.id}\` is enabled but lists no models; declare them in ${entry.envName}_EXTRA_MODELS`);
    const apiKey = report.getApiKey(entry.id, "llm");
    const adapter = createOpenAICompatibleAdapter({
      provider: definition,
      baseUrl,
      ...(apiKey ? { apiKey } : {}),
      firstByteTimeoutMs: entry.timeoutMs ?? definition.limits.firstByteTimeoutMs,
      idleTimeoutMs: definition.limits.idleTimeoutMs,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.now ? { now: opts.now } : {}),
    });
    const rpm = entry.rpm ?? definition.limits.rpm;
    const maxConcurrency = entry.maxConcurrency ?? definition.limits.maxConcurrency;
    const limiter = new RateLimiter({
      ...(rpm !== undefined ? { rpm } : {}),
      ...(maxConcurrency !== undefined ? { maxConcurrency } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    });
    providers.set(entry.id, { definition, entry, models, adapter, limiter });
  }
  return { providers, skipped, warnings };
}
