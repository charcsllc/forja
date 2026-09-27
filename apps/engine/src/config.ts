/**
 * Engine configuration, parsed once at boot from the environment.
 *
 * ⭐ Defaults are exactly those of docs/architecture/09-env-reference.md (engine, sandbox,
 * preview/publish and budget sections, plus "Varios"). Provider and per-role model settings
 * (`LLM_*`, `IMAGE_*`, `STOCK_*`, `AGENT_*`) belong to packages/llm and packages/agents
 * (phase 2): they are only collected raw into `rawProviderEnv` here, never interpreted.
 *
 * ⚠️ An invalid configuration prints a table of problems and exits with code 1 (`loadConfig`).
 * Tests use `parseConfig`, which returns the problems instead of exiting.
 */
import { z } from "zod";

const RAW_PROVIDER_PREFIXES = ["LLM_", "IMAGE_", "STOCK_", "AGENT_"] as const;

/** Treat empty strings as "not set" so `KEY=` in a .env file means the default. */
const emptyToUndefined = (v: unknown): unknown =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const bool = (def: boolean) =>
  z.preprocess(
    (v) => {
      const e = emptyToUndefined(v);
      if (typeof e !== "string") return e;
      const s = e.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(s)) return true;
      if (["false", "0", "no", "off"].includes(s)) return false;
      return e;
    },
    z.boolean({ invalid_type_error: "must be true or false" }).default(def),
  );

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(emptyToUndefined, z.coerce.number().int().min(min).max(max).default(def));

const num = (def: number, min = 0) =>
  z.preprocess(emptyToUndefined, z.coerce.number().min(min).default(def));

/** Optional USD amount; empty = no limit (null). */
const usdOrNull = (def: number | null) =>
  z.preprocess(
    (v) => (v === undefined ? def : typeof v === "string" && v.trim() === "" ? null : v),
    z.coerce.number().min(0).nullable(),
  );

const str = (def: string) => z.preprocess(emptyToUndefined, z.string().default(def));
const optStr = () => z.preprocess(emptyToUndefined, z.string().optional());

const byteSize = (def: string) =>
  z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(/^\d+(\.\d+)?[bkmg]?$/i, "must be a size like 512m or 2g")
      .default(def),
  );

const EnvSchema = z
  .object({
    // ── Engine ──
    FORJA_ENGINE_KEY: optStr(),
    FORJA_MASTER_KEY: optStr().refine(
      (v) => v === undefined || Buffer.from(v, "base64").length === 32,
      "must be 32 bytes, base64-encoded",
    ),
    DATABASE_URL: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL")
        .default("postgres://forja:forja@postgres:5432/forja"),
    ),
    DATA_DIR: str("/data"),
    DATA_DIR_HOST: str("/srv/forja/data"),
    ENGINE_PORT: int(4000, 1, 65535),
    ENGINE_INSTANCES: int(1, 1),
    REDIS_URL: optStr(),
    LOG_LEVEL: z.preprocess(
      emptyToUndefined,
      z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    ),
    LOGS_RETENTION_DAYS: int(7, 1),
    EVENTS_RETENTION_DAYS: int(30, 1),
    UPLOAD_MAX_MB: int(8, 1),
    ENGINE_MAX_CONCURRENT_RUNS: int(2, 1),
    RUN_REQUIRE_PLAN_APPROVAL: bool(false),
    RUN_ALLOW_QUESTIONS: bool(false),
    /** Docker endpoint (the socket proxy in compose). Not in 09 yet; unset = "unavailable". */
    DOCKER_HOST: optStr(),

    // ── Budgets (USD; empty = no limit) ──
    BUDGET_PER_RUN_USD: usdOrNull(8),
    BUDGET_PER_PROJECT_MONTH_USD: usdOrNull(60),
    BUDGET_GLOBAL_MONTH_USD: usdOrNull(null),

    // ── Sandboxes ──
    SANDBOX_DRIVER: z.preprocess(emptyToUndefined, z.enum(["docker", "process"]).default("docker")),
    SANDBOX_RUNTIME: z.preprocess(emptyToUndefined, z.enum(["runc", "runsc"]).optional()),
    SANDBOX_MEM: byteSize("2g"),
    SANDBOX_CPUS: num(2, 0.1),
    SANDBOX_PIDS: int(512, 16),
    SANDBOX_EGRESS: z.preprocess(
      emptyToUndefined,
      z.enum(["internet", "registry-only"]).default("internet"),
    ),
    SANDBOX_IDLE_MINUTES: int(120, 1),
    SANDBOX_MAX_ACTIVE: int(5, 1),
    SANDBOX_START_TIMEOUT_SEC: int(300, 10),
    DISK_MIN_FREE_GB: num(5, 0),
    PROJECT_MAX_SIZE_MB: int(2048, 1),
    PROJECT_PURGE_AFTER_DAYS: int(7, 0),
    /** Template copied into every new project (phase 1: the only one). */
    TEMPLATE_DIR: str("/opt/forja/templates/nextjs-postgres"),
    /** Image of `forja-app-<id>` / `forja-verify-<id>` (tagged with the template version). */
    RUNNER_IMAGE: str("forja-runner:1.0.0"),
    /** Image of `forja-db-<id>`. */
    SANDBOX_DB_IMAGE: str("postgres:17-alpine"),
    /**
     * Name or id of the engine's own container, attached to each project's internal network
     * so the CMS reaches `forja-db-<id>`. Empty = the hostname (Docker sets it to the short id).
     */
    ENGINE_CONTAINER: optStr(),

    // ── Preview and publish ──
    PREVIEW_DOMAIN: str("forja.localhost"),
    PREVIEW_TLS: bool(false),
    /** Default depends on PUBLISH_TLS (server mode → false); resolved below. */
    PREVIEW_PUBLIC: z.preprocess(
      (v) => {
        const e = emptyToUndefined(v);
        if (typeof e !== "string") return e;
        const s = e.trim().toLowerCase();
        return s === "true" ? true : s === "false" ? false : e;
      },
      z.boolean({ invalid_type_error: "must be true or false" }).optional(),
    ),
    PUBLISH_DOMAIN: str("apps.forja.localhost"),
    PUBLISH_TLS: bool(false),
    PUBLISH_IP: z.preprocess(emptyToUndefined, z.string().ip().optional()),
    ACME_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
    ACME_DNS_PROVIDER: optStr(),
    TRAEFIK_DASHBOARD: bool(false),
    /** The UI's public origin: signed file URLs are `${WEB_PUBLIC_URL}/api/files/<token>` (05 §2.3). */
    WEB_PUBLIC_URL: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .url()
        .transform((v) => v.replace(/\/+$/, ""))
        .default("http://localhost:3000"),
    ),

    // ── Varios ──
    ALLOW_ENV_EXPORT: bool(false),
    NPM_ALLOWLIST_FILE: optStr(),
    BACKUP_DIR: optStr(),
    BACKUP_S3_ENDPOINT: optStr(),
    BACKUP_S3_BUCKET: optStr(),
    BACKUP_S3_ACCESS_KEY: optStr(),
    BACKUP_S3_SECRET_KEY: optStr(),
    WEBHOOK_TIMEOUT_MS: int(10000, 100),
  })
  .superRefine((c, ctx) => {
    if ((c.PREVIEW_TLS || c.PUBLISH_TLS) && !c.ACME_EMAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ACME_EMAIL"],
        message: "required when PREVIEW_TLS or PUBLISH_TLS is true",
      });
    }
    if (c.ENGINE_INSTANCES > 1 && !c.REDIS_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["REDIS_URL"],
        message: "required when ENGINE_INSTANCES > 1",
      });
    }
    // Server mode (PUBLISH_TLS=true): both keys must come from the environment (09, 07 §2).
    if (c.PUBLISH_TLS) {
      for (const k of ["FORJA_ENGINE_KEY", "FORJA_MASTER_KEY"] as const) {
        if (!c[k]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [k],
            message: "required in server mode (PUBLISH_TLS=true)",
          });
        }
      }
    }
    if (c.FORJA_ENGINE_KEY !== undefined && c.FORJA_ENGINE_KEY.length < 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["FORJA_ENGINE_KEY"],
        message: "must be at least 24 characters",
      });
    }
  });

type ParsedEnv = z.infer<typeof EnvSchema>;

export type Config = Omit<ParsedEnv, "PREVIEW_PUBLIC"> & {
  PREVIEW_PUBLIC: boolean;
  /** Raw `LLM_*`, `IMAGE_*`, `STOCK_*`, `AGENT_*` entries, for packages/llm (phase 2). */
  rawProviderEnv: Record<string, string>;
};

export interface ConfigProblem {
  variable: string;
  problem: string;
  value: string;
}

export type ParseConfigResult =
  | { ok: true; config: Config }
  | { ok: false; problems: ConfigProblem[] };

const SECRET_NAME = /key|secret|token|password/i;

function displayValue(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (v === undefined) return "(unset)";
  if (v === "") return "(empty)";
  if (SECRET_NAME.test(name)) return "(redacted)";
  if (name === "DATABASE_URL") return v.replace(/\/\/([^:@/]+):[^@]*@/, "//$1:***@");
  return v.length > 60 ? `${v.slice(0, 57)}...` : v;
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): ParseConfigResult {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const variable = String(issue.path[0] ?? "(env)");
      return { variable, problem: issue.message, value: displayValue(variable, env) };
    });
    return { ok: false, problems };
  }
  const rawProviderEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && RAW_PROVIDER_PREFIXES.some((p) => k.startsWith(p))) rawProviderEnv[k] = v;
  }
  const parsed = result.data;
  return {
    ok: true,
    config: {
      ...parsed,
      PREVIEW_PUBLIC: parsed.PREVIEW_PUBLIC ?? !parsed.PUBLISH_TLS,
      rawProviderEnv,
    },
  };
}

export function formatProblems(problems: ConfigProblem[]): string {
  const headers = ["VARIABLE", "PROBLEM", "VALUE"] as const;
  const rows = problems.map((p) => [p.variable, p.problem, p.value] as const);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const line = (cells: readonly string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" │ ");
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  return [
    "Forja Engine: invalid configuration",
    "",
    line(headers),
    sep,
    ...rows.map(line),
    "",
    "See docs/architecture/09-env-reference.md.",
  ].join("\n");
}

/** Parse the environment; on error print a readable table and exit(1). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = parseConfig(env);
  if (!result.ok) {
    process.stderr.write(`${formatProblems(result.problems)}\n`);
    process.exit(1);
  }
  return result.config;
}
