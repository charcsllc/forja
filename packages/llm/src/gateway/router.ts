/**
 * Role → model assignment (docs/architecture/02 §3).
 *
 * What this file protects:
 * - Auto-assignment is deterministic: filter by hard requirements (capabilities, context,
 *   price ceiling), then sort by tier closeness, output price, higher tier on ties, and
 *   catalog order. The next candidates become the fallbacks.
 * - `AGENT_<ROLE>_MODEL`/`_FALLBACKS` win when usable; an unusable reference (provider
 *   disabled or pending, unknown model) is a warning and the chain moves on, never a
 *   crash. When nothing in env is usable the role is auto-assigned.
 * - A role nobody can serve gets `model: null` and an `error` that names the missing
 *   requirement and what is enabled, e.g. "role `designer` needs `vision`; enabled
 *   providers: groq (openai/gpt-oss-20b)".
 */
import { outputPricePer1M } from "../catalog/price.js";
import type { ModelDefinition, ModelTier } from "../catalog/types.js";
import { AGENT_ROLES, type AgentRole } from "../types.js";
import type { Registry } from "./registry.js";
import { formatModelRef, type ModelRef, type RoleEnvConfig } from "./role-config.js";
import type { ModelRequirements, RoleAssignment } from "./types.js";

export const MAX_AUTO_FALLBACKS = 2;

/** Used for roles that declare no requirements. */
export const DEFAULT_REQUIREMENTS: ModelRequirements = { capabilities: [], minContextTokens: 0, preferredTier: "strong" };

const TIER_RANK: Record<ModelTier, number> = { frontier: 0, strong: 1, fast: 2, local: 3 };

export interface Candidate {
  provider: string;
  model: ModelDefinition;
  ref: string;
  order: number;
}

export function listCandidates(registry: Registry): Candidate[] {
  const out: Candidate[] = [];
  for (const [provider, p] of registry.providers) {
    for (const model of p.models) out.push({ provider, model, ref: `${provider}:${model.id}`, order: out.length });
  }
  return out;
}

export function meets(model: ModelDefinition, req: ModelRequirements, at: Date): boolean {
  if (!req.capabilities.every((c) => model.capabilities[c])) return false;
  if (model.contextTokens < req.minContextTokens) return false;
  if (req.maxPricePer1MOutput !== undefined && outputPricePer1M(model.price, at) > req.maxPricePer1MOutput) return false;
  return true;
}

export function rank(candidates: Candidate[], req: ModelRequirements, at: Date): Candidate[] {
  const preferred = TIER_RANK[req.preferredTier];
  return candidates
    .filter((c) => meets(c.model, req, at))
    .map((c) => ({ c, distance: Math.abs(TIER_RANK[c.model.tier] - preferred), price: outputPricePer1M(c.model.price, at) }))
    .sort((a, b) => a.distance - b.distance || a.price - b.price || TIER_RANK[a.c.model.tier] - TIER_RANK[b.c.model.tier] || a.c.order - b.c.order)
    .map((x) => x.c);
}

function enabledSummary(registry: Registry): string {
  const parts = [...registry.providers.entries()].map(([id, p]) => {
    const ids = p.models.map((m) => m.id);
    const shown = ids.slice(0, 3).join(", ") + (ids.length > 3 ? ", …" : "");
    return `${id} (${shown || "no models"})`;
  });
  const pending = registry.skipped.map((s) => `${s.id} (skipped)`);
  const all = [...parts, ...pending];
  return all.length > 0 ? all.join(", ") : "none";
}

/** Explains why no candidate satisfies `req`. */
export function unsatisfiedReason(role: AgentRole, req: ModelRequirements, candidates: Candidate[], registry: Registry, at: Date): string {
  if (candidates.length === 0) {
    return `role \`${role}\` has no model: no enabled LLM provider can be called; enabled providers: ${enabledSummary(registry)}`;
  }
  const missing: string[] = [];
  for (const cap of req.capabilities) if (!candidates.some((c) => c.model.capabilities[cap])) missing.push(`\`${cap}\``);
  if (!candidates.some((c) => c.model.contextTokens >= req.minContextTokens)) missing.push(`≥ ${req.minContextTokens} context tokens`);
  if (req.maxPricePer1MOutput !== undefined && !candidates.some((c) => outputPricePer1M(c.model.price, at) <= req.maxPricePer1MOutput!)) {
    missing.push(`output price ≤ $${req.maxPricePer1MOutput}/1M`);
  }
  const needs =
    missing.length > 0
      ? missing.join(" and ")
      : [...req.capabilities.map((c) => `\`${c}\``), `≥ ${req.minContextTokens} context tokens`, ...(req.maxPricePer1MOutput !== undefined ? [`output price ≤ $${req.maxPricePer1MOutput}/1M`] : [])].join(" + ") +
        " in one model";
  return `role \`${role}\` needs ${needs}; enabled providers: ${enabledSummary(registry)}`;
}

export interface AssignResult {
  assignments: Map<AgentRole, RoleAssignment>;
  warnings: string[];
}

function usableRef(ref: ModelRef, registry: Registry): string | undefined {
  const p = registry.providers.get(ref.provider);
  if (!p) {
    const skipped = registry.skipped.find((s) => s.id === ref.provider);
    return skipped ? `provider \`${ref.provider}\` cannot be called (${skipped.reason})` : `provider \`${ref.provider}\` is not enabled`;
  }
  if (!p.models.some((m) => m.id === ref.model)) {
    return `model \`${ref.model}\` is not in the ${ref.provider} catalog; declare it in ${p.entry.envName}_EXTRA_MODELS`;
  }
  return undefined;
}

export function assignRoles(
  roleConfig: Record<AgentRole, RoleEnvConfig>,
  requirements: Partial<Record<AgentRole, ModelRequirements>>,
  registry: Registry,
  at: Date,
): AssignResult {
  const warnings: string[] = [];
  const assignments = new Map<AgentRole, RoleAssignment>();
  const candidates = listCandidates(registry);
  const byRef = new Map(candidates.map((c) => [c.ref, c]));

  // Roles that must differ from others are resolved last, once those others are known.
  const ordered = [...AGENT_ROLES].sort((a, b) => Number(Boolean(requirements[a]?.differentFamilyThan?.length)) - Number(Boolean(requirements[b]?.differentFamilyThan?.length)));

  for (const role of ordered) {
    const cfg = roleConfig[role];
    const req = requirements[role] ?? DEFAULT_REQUIREMENTS;
    const envName = `AGENT_${role.toUpperCase()}`;

    const envRefs: string[] = [];
    const declared = [...(cfg.model ? [{ ref: cfg.model, variable: `${envName}_MODEL` }] : []), ...cfg.fallbacks.map((ref) => ({ ref, variable: `${envName}_FALLBACKS` }))];
    for (const { ref, variable } of declared) {
      const problem = usableRef(ref, registry);
      const formatted = formatModelRef(ref);
      if (problem) warnings.push(`${variable}: ${formatted} skipped: ${problem}`);
      else if (!envRefs.includes(formatted)) envRefs.push(formatted);
    }

    if (cfg.model && envRefs.length > 0) {
      // When the primary is unusable, envRefs[0] is the first valid fallback (02 §3).
      const primary = envRefs[0] as string;
      const c = byRef.get(primary);
      if (c && !meets(c.model, req, at)) warnings.push(`${envName}: ${primary} does not meet the role's requirements; used as configured`);
      assignments.set(role, { role, model: primary, fallbacks: envRefs.slice(1), source: "env" });
      continue;
    }
    if (cfg.model) warnings.push(`${envName}_MODEL: nothing configured is usable; role auto-assigned`);

    let ranked = rank(candidates, req, at);
    if (ranked.length === 0) {
      assignments.set(role, { role, model: null, fallbacks: envRefs, source: "auto", error: unsatisfiedReason(role, req, candidates, registry, at) });
      continue;
    }
    const avoid = new Set(
      (req.differentFamilyThan ?? [])
        .map((other) => assignments.get(other)?.model)
        .filter((ref): ref is string => typeof ref === "string")
        .map((ref) => byRef.get(ref)?.model.family)
        .filter((f) => f !== undefined),
    );
    if (avoid.size > 0) {
      const different = ranked.filter((c) => c.model.family === undefined || !avoid.has(c.model.family));
      if (different.length > 0) ranked = [...different, ...ranked.filter((c) => !different.includes(c))];
      else warnings.push(`role \`${role}\` should use a model family other than ${[...avoid].join(", ")}, but no enabled model qualifies; using the same family`);
    }
    const auto = ranked.map((c) => c.ref);
    const primary = auto[0] as string;
    const fallbacks = [...envRefs, ...auto.slice(1, 1 + MAX_AUTO_FALLBACKS)].filter((ref, i, all) => ref !== primary && all.indexOf(ref) === i);
    assignments.set(role, { role, model: primary, fallbacks, source: "auto" });
  }
  return { assignments, warnings };
}
