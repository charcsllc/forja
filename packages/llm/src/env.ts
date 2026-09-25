/**
 * Provider activation from the environment (docs/architecture/02 §1, 09).
 *
 * What this file protects:
 * - The two-value format `LLM_<P>="<switch>|<api key>"` is parsed exactly as documented:
 *   split on the FIRST `|`, switch is truthy only for true/1/yes/on (case-insensitive),
 *   key is trimmed. The separate form `LLM_<P>_ENABLED` + `LLM_<P>_API_KEY` is equivalent.
 * - A key is never switched off silently: both forms present and disagreeing is
 *   `misconfigured`, and so is "enabled without a key" (except local providers).
 * - **Key values never enter the report.** The report is safe to log, serialise and return
 *   from `/v2/system/models`. The only way to read a key is `report.getApiKey(...)`, a
 *   non-enumerable accessor backed by a closure, so `JSON.stringify(report)` cannot leak it.
 * - The same rules apply to `IMAGE_*` and `STOCK_*` media providers.
 */
import { z } from "zod";

// ── Provider ids ────────────────────────────────────────────────────────────

export const LLM_PROVIDER_IDS = [
  "anthropic", "openai", "google", "zai", "qwen", "deepseek", "moonshot", "minimax",
  "mistral", "xai", "groq", "together", "fireworks", "openrouter", "ollama", "lmstudio", "vllm",
] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];

/** Local providers may be enabled with an empty key. */
export const LOCAL_LLM_PROVIDER_IDS = ["ollama", "lmstudio", "vllm"] as const satisfies readonly LlmProviderId[];

export const IMAGE_PROVIDER_IDS = ["openai", "google", "fal", "replicate", "stability"] as const;
export type ImageProviderId = (typeof IMAGE_PROVIDER_IDS)[number];

export const STOCK_PROVIDER_IDS = ["unsplash", "pexels", "pixabay"] as const;
export type StockProviderId = (typeof STOCK_PROVIDER_IDS)[number];

export type ProviderKind = "llm" | "image" | "stock";
export type ProviderStatus = "enabled" | "disabled" | "misconfigured";

export const PROVIDER_ENV_PREFIX: Record<ProviderKind, string> = { llm: "LLM", image: "IMAGE", stock: "STOCK" };

const PROVIDER_IDS_BY_KIND: Record<ProviderKind, readonly string[]> = {
  llm: LLM_PROVIDER_IDS,
  image: IMAGE_PROVIDER_IDS,
  stock: STOCK_PROVIDER_IDS,
};

/** Suffixes recognised after `<PREFIX>_<PROVIDER>`; anything else is reported as unknown. */
const KNOWN_SUFFIXES = ["", "_ENABLED", "_API_KEY", "_BASE_URL", "_ORG", "_TIMEOUT_MS", "_MAX_CONCURRENCY", "_EXTRA_MODELS"] as const;

const TRUTHY = new Set(["true", "1", "yes", "on"]);

// ── Optional settings ───────────────────────────────────────────────────────

export const extraModelSchema = z
  .object({
    id: z.string().min(1),
    contextTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    tier: z.enum(["frontier", "strong", "fast", "local"]).optional(),
    vision: z.boolean().optional(),
    nativeTools: z.boolean().optional(),
  })
  .strict();
export type ExtraModel = z.infer<typeof extraModelSchema>;
const extraModelsSchema = z.array(extraModelSchema);

const positiveIntSchema = z.coerce.number().int().positive();

// ── Report ──────────────────────────────────────────────────────────────────

export interface ProviderEntry {
  id: string;
  kind: ProviderKind;
  /** The combined variable name, e.g. `LLM_ANTHROPIC`. */
  envName: string;
  status: ProviderStatus;
  /** Whether a non-empty key was supplied. The value itself is never in the report. */
  apiKeyPresent: boolean;
  local: boolean;
  /** Which form(s) configured it. */
  source: "none" | "combined" | "separate" | "both";
  /** Base URL with any `user:password@` stripped. */
  baseUrl?: string;
  org?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  extraModels?: ExtraModel[];
  /** Why the status is what it is, plus warnings. Never contains a key value. */
  reasons: string[];
}

export interface ProviderEnvReport {
  providers: ProviderEntry[];
  /** False when any provider is `misconfigured`: the engine must refuse to boot. */
  ok: boolean;
  /** `LLM_*`/`IMAGE_*`/`STOCK_*` variables that match no known provider or setting (typos). */
  unknownVariables: string[];
  /** Reads a key. Non-enumerable: never serialised. Returns undefined unless `enabled`. */
  getApiKey(id: string, kind?: ProviderKind): string | undefined;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;

/** Treats undefined and whitespace-only values as absent. */
function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** dotenv strips quotes; a hand-exported value may still carry one matching pair. */
function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

export function isTruthySwitch(value: string): boolean {
  return TRUTHY.has(unquote(value).trim().toLowerCase());
}

/** `"<switch>|<key>"` → split on the first `|`. No `|` = switch only, empty key. */
export function parseTwoValue(raw: string): { enabled: boolean; key: string } {
  const value = unquote(raw);
  const bar = value.indexOf("|");
  const switchPart = bar === -1 ? value : value.slice(0, bar);
  const keyPart = bar === -1 ? "" : value.slice(bar + 1);
  return { enabled: isTruthySwitch(switchPart), key: keyPart.trim() };
}

function redactBaseUrl(raw: string): { url?: string; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "is not a valid URL" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { error: "must be http(s)" };
  parsed.username = "";
  parsed.password = "";
  return { url: parsed.toString().replace(/\/$/, "") };
}

interface ParsedProvider {
  entry: ProviderEntry;
  key: string | undefined;
}

function parseOne(env: Env, kind: ProviderKind, id: string): ParsedProvider {
  const envName = `${PROVIDER_ENV_PREFIX[kind]}_${id.toUpperCase()}`;
  const local = kind === "llm" && (LOCAL_LLM_PROVIDER_IDS as readonly string[]).includes(id);
  const reasons: string[] = [];
  const settingErrors: string[] = [];

  const combinedRaw = env[envName];
  const enabledRaw = env[`${envName}_ENABLED`];
  const apiKeyRaw = env[`${envName}_API_KEY`];

  const hasCombined = present(combinedRaw);
  const hasSeparate = present(enabledRaw) || present(apiKeyRaw);
  const source: ProviderEntry["source"] = hasCombined && hasSeparate ? "both" : hasCombined ? "combined" : hasSeparate ? "separate" : "none";

  const combined = hasCombined ? parseTwoValue(combinedRaw) : undefined;
  const separate = hasSeparate
    ? {
        enabled: present(enabledRaw) ? isTruthySwitch(enabledRaw) : undefined,
        key: present(apiKeyRaw) ? unquote(apiKeyRaw).trim() : "",
      }
    : undefined;

  let conflict = false;
  if (combined && separate) {
    if (separate.enabled !== undefined && separate.enabled !== combined.enabled) {
      conflict = true;
      reasons.push(`${envName} and ${envName}_ENABLED disagree (switch ${combined.enabled ? "on" : "off"} vs ${separate.enabled ? "on" : "off"})`);
    }
    if (combined.key !== separate.key && (combined.key !== "" || separate.key !== "")) {
      conflict = true;
      reasons.push(`${envName} and ${envName}_API_KEY carry different keys; use one form only`);
    }
  }

  const enabled = combined?.enabled ?? separate?.enabled ?? false;
  const key = (combined?.key || separate?.key || "").trim();
  const apiKeyPresent = key !== "";

  // Optional settings.
  const entry: ProviderEntry = { id, kind, envName, status: "disabled", apiKeyPresent, local, source, reasons };

  const baseUrlRaw = env[`${envName}_BASE_URL`];
  if (present(baseUrlRaw)) {
    const r = redactBaseUrl(unquote(baseUrlRaw));
    if (r.url) entry.baseUrl = r.url;
    else settingErrors.push(`${envName}_BASE_URL ${r.error}`);
  }
  const orgRaw = env[`${envName}_ORG`];
  if (present(orgRaw)) entry.org = unquote(orgRaw);
  for (const [suffix, field] of [["_TIMEOUT_MS", "timeoutMs"], ["_MAX_CONCURRENCY", "maxConcurrency"]] as const) {
    const raw = env[`${envName}${suffix}`];
    if (!present(raw)) continue;
    const parsed = positiveIntSchema.safeParse(unquote(raw));
    if (parsed.success) entry[field] = parsed.data;
    else settingErrors.push(`${envName}${suffix} must be a positive integer`);
  }
  const extraRaw = env[`${envName}_EXTRA_MODELS`];
  if (present(extraRaw)) {
    let json: unknown;
    try {
      json = JSON.parse(unquote(extraRaw));
    } catch {
      settingErrors.push(`${envName}_EXTRA_MODELS is not valid JSON`);
    }
    if (json !== undefined) {
      const parsed = extraModelsSchema.safeParse(json);
      if (parsed.success) entry.extraModels = parsed.data;
      else {
        const first = parsed.error.issues[0];
        settingErrors.push(`${envName}_EXTRA_MODELS is invalid${first ? ` at ${first.path.join(".") || "(root)"}: ${first.message}` : ""}`);
      }
    }
  }

  // Status.
  if (conflict) {
    entry.status = "misconfigured";
  } else if (enabled) {
    if (!apiKeyPresent && !local) {
      entry.status = "misconfigured";
      reasons.push(`${envName} is enabled but has no API key`);
    } else {
      entry.status = "enabled";
      if (!apiKeyPresent) reasons.push("local provider, no key");
    }
  } else {
    entry.status = "disabled";
    if (apiKeyPresent) reasons.push(`warning: ${envName} is switched off but carries a key; the key is ignored`);
  }

  if (settingErrors.length > 0) {
    if (entry.status === "enabled") {
      entry.status = "misconfigured";
      reasons.push(...settingErrors);
    } else {
      reasons.push(...settingErrors.map((e) => `warning: ${e}`));
    }
  }

  return { entry, key: entry.status === "enabled" && apiKeyPresent ? key : undefined };
}

function findUnknownVariables(env: Env): string[] {
  const unknown: string[] = [];
  for (const name of Object.keys(env).sort()) {
    for (const kind of Object.keys(PROVIDER_ENV_PREFIX) as ProviderKind[]) {
      const prefix = `${PROVIDER_ENV_PREFIX[kind]}_`;
      if (!name.startsWith(prefix)) continue;
      const known = PROVIDER_IDS_BY_KIND[kind].some((id) =>
        KNOWN_SUFFIXES.some((suffix) => name === `${prefix}${id.toUpperCase()}${suffix}`),
      );
      if (!known) unknown.push(name);
    }
  }
  return unknown;
}

/**
 * Parses every LLM, image and stock provider from `env` (usually `process.env`).
 * Pure: it never reads `process.env` itself, never throws, and never logs.
 */
export function parseProviderEnv(env: Env): ProviderEnvReport {
  const providers: ProviderEntry[] = [];
  const keys = new Map<string, string>();
  for (const kind of ["llm", "image", "stock"] as const) {
    for (const id of PROVIDER_IDS_BY_KIND[kind]) {
      const { entry, key } = parseOne(env, kind, id);
      providers.push(entry);
      if (key !== undefined) keys.set(`${kind}:${id}`, key);
    }
  }
  const report = {
    providers,
    ok: providers.every((p) => p.status !== "misconfigured"),
    unknownVariables: findUnknownVariables(env),
  } as ProviderEnvReport;
  Object.defineProperty(report, "getApiKey", {
    enumerable: false,
    value: (id: string, kind: ProviderKind = "llm") => keys.get(`${kind}:${id}`),
  });
  return report;
}

// ── Boot log ────────────────────────────────────────────────────────────────

/** Plain-text table for the engine's boot log. Contains no key material. */
export function formatProviderTable(report: ProviderEnvReport, opts: { includeDisabled?: boolean } = {}): string {
  const includeDisabled = opts.includeDisabled ?? true;
  const rows = report.providers
    .filter((p) => includeDisabled || p.status !== "disabled" || p.reasons.length > 0)
    .map((p) => [
      p.kind,
      p.id,
      p.status === "enabled" ? "enabled" : p.status === "misconfigured" ? "MISCONFIGURED" : "disabled",
      p.apiKeyPresent ? "yes" : p.local ? "local" : "no",
      p.baseUrl ?? "",
      p.reasons.join("; "),
    ]);
  const header = ["kind", "provider", "status", "key", "base url", "notes"];
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)];
  if (report.unknownVariables.length > 0) out.push("", `unknown variables (typo?): ${report.unknownVariables.join(", ")}`);
  if (!report.ok) out.push("", "one or more providers are misconfigured: refusing to start");
  return out.join("\n");
}
