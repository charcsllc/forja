/**
 * `AGENT_<ROLE>_*` parsing (docs/architecture/02 §3, 09).
 *
 * What this file protects:
 * - Every per-role variable is validated with zod at boot; a malformed value is an
 *   operator error reported with the variable name (`LlmConfigError`), never a silent
 *   default.
 * - Model references are `provider:model`, split on the FIRST `:` (NIM ids contain `/`,
 *   Ollama tags contain `:`).
 * - Only `AGENT_<ROLE>_{MODEL,FALLBACKS,EFFORT,MAX_OUTPUT_TOKENS,TOOL_PROTOCOL}` belong
 *   here; other `AGENT_*` settings (turn limits, retries) are the orchestrator's.
 */
import { z } from "zod";
import { LlmConfigError } from "../errors.js";
import { AGENT_ROLES, type AgentRole, type Effort } from "../types.js";

export type ToolProtocol = "auto" | "native" | "xml";

export interface ModelRef {
  provider: string;
  model: string;
}

export interface RoleEnvConfig {
  role: AgentRole;
  model?: ModelRef;
  fallbacks: ModelRef[];
  effort?: Effort;
  maxOutputTokens: number;
  toolProtocol: ToolProtocol;
}

/** Implementers write whole files: they get twice the default output budget. */
export const IMPLEMENTER_ROLES: readonly AgentRole[] = ["database", "backend", "frontend"];
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
export const IMPLEMENTER_MAX_OUTPUT_TOKENS = 32_000;

const ROLE_SUFFIXES = ["MODEL", "FALLBACKS", "EFFORT", "MAX_OUTPUT_TOKENS", "TOOL_PROTOCOL"] as const;

export function parseModelRef(value: string): ModelRef | undefined {
  const v = value.trim();
  const colon = v.indexOf(":");
  if (colon <= 0 || colon === v.length - 1) return undefined;
  return { provider: v.slice(0, colon).trim().toLowerCase(), model: v.slice(colon + 1).trim() };
}

export function formatModelRef(ref: ModelRef): string {
  return `${ref.provider}:${ref.model}`;
}

const modelRefSchema = z.string().transform((v, ctx) => {
  const ref = parseModelRef(v);
  if (!ref) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${v}" is not "provider:model"` });
    return z.NEVER;
  }
  return ref;
});

const roleSchema = z.object({
  MODEL: modelRefSchema.optional(),
  FALLBACKS: z
    .string()
    .optional()
    .transform((v, ctx) => {
      const refs: ModelRef[] = [];
      for (const item of (v ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
        const ref = parseModelRef(item);
        if (!ref) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${item}" is not "provider:model"` });
        else refs.push(ref);
      }
      return refs;
    }),
  EFFORT: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().optional(),
  TOOL_PROTOCOL: z.enum(["auto", "native", "xml"]).optional(),
});

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim();
  return v === "" ? undefined : v;
}

export interface RoleConfigResult {
  roles: Record<AgentRole, RoleEnvConfig>;
  /** `AGENT_<X>_MODEL`-style variables naming no known role (typos). */
  unknownVariables: string[];
}

/** Parses every role's variables; throws `LlmConfigError` listing every invalid one. */
export function parseRoleConfig(env: Record<string, string | undefined>): RoleConfigResult {
  const errors: string[] = [];
  const roles = {} as Record<AgentRole, RoleEnvConfig>;
  for (const role of AGENT_ROLES) {
    const prefix = `AGENT_${role.toUpperCase()}_`;
    const raw: Record<string, string | undefined> = {};
    for (const suffix of ROLE_SUFFIXES) raw[suffix] = clean(env[`${prefix}${suffix}`]);
    const parsed = roleSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(`${prefix}${String(issue.path[0] ?? "")}: ${issue.message}`);
      continue;
    }
    const d = parsed.data;
    roles[role] = {
      role,
      ...(d.MODEL ? { model: d.MODEL } : {}),
      fallbacks: d.FALLBACKS,
      ...(d.EFFORT ? { effort: d.EFFORT } : {}),
      maxOutputTokens: d.MAX_OUTPUT_TOKENS ?? (IMPLEMENTER_ROLES.includes(role) ? IMPLEMENTER_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS),
      toolProtocol: d.TOOL_PROTOCOL ?? "auto",
    };
  }
  if (errors.length > 0) throw new LlmConfigError(`invalid agent model settings:\n  ${errors.join("\n  ")}`);

  const pattern = new RegExp(`^AGENT_([A-Z0-9]+)_(${ROLE_SUFFIXES.join("|")})$`);
  const known = new Set(AGENT_ROLES.map((r) => r.toUpperCase()));
  const unknownVariables = Object.keys(env)
    .filter((name) => {
      const m = pattern.exec(name);
      return m !== null && !known.has(m[1] as string);
    })
    .sort();
  return { roles, unknownVariables };
}
