/**
 * The only place that reads `process.env` (outside next.config.ts and scripts/).
 *
 * Required: DATABASE_URL, BETTER_AUTH_SECRET, NEXT_PUBLIC_APP_URL. Every integration key is
 * optional and, when missing, the matching development adapter is used (console mailer,
 * local storage), so the app always starts.
 *
 * Validation is lazy (first property read) so that `next build` can import modules without
 * a database or secrets. During `next build` a failed validation is a warning, not an error;
 * at runtime it throws with every problem listed.
 *
 * Server-only: values are read at runtime from `process.env`, never inlined. Pass what a
 * client component needs as props.
 */
import { z } from "zod";

const optionalUrl = z.url().optional();

const list = z
  .string()
  .optional()
  .transform((value) => (value ?? "").split(/[\s,]+/).filter(Boolean));

const flag = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  // Required
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  NEXT_PUBLIC_APP_URL: z.url(),

  // Origins
  INTERNAL_APP_URL: optionalUrl,
  ALLOWED_FRAME_ANCESTORS: list,
  EXTRA_TRUSTED_ORIGINS: list,

  // Email (optional: without SMTP_HOST mail is written to the log)
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: flag,
  SMTP_FROM: z.string().default("App <no-reply@localhost>"),

  // File storage (optional: without S3_BUCKET files go to STORAGE_DIR on local disk)
  STORAGE_DIR: z.string().optional(),
  S3_ENDPOINT: optionalUrl,
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_URL: optionalUrl,
  S3_FORCE_PATH_STYLE: flag,

  // Background jobs: "inline" runs registered handlers inside the web process.
  JOBS_MODE: z.enum(["inline", "off"]).default("inline"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

function readProcessEnv(): Record<string, string | undefined> {
  // Treat empty strings (common in .env files and compose) as "not set".
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) out[key] = value === "" ? undefined : value;
  return out;
}

function load(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(readProcessEnv());
  if (parsed.success) {
    cached = parsed.data;
    return cached;
  }
  const message = `Invalid environment variables:\n${z.prettifyError(parsed.error)}`;
  if (process.env.NEXT_PHASE === "phase-production-build") {
    // `next build` imports route modules without runtime configuration. Use what we have;
    // the server validates again, strictly, when it starts serving requests.
    const lenient = schema.partial().safeParse(readProcessEnv());
    cached = (lenient.success ? lenient.data : {}) as Env;
    return cached;
  }
  throw new Error(message);
}

/** Validated environment. Read properties at call time, not at module top level. */
export const env: Env = new Proxy({} as Env, {
  get(_target, key: string) {
    return load()[key as keyof Env];
  },
  has(_target, key: string) {
    return key in load();
  },
  ownKeys() {
    return Reflect.ownKeys(load());
  },
  getOwnPropertyDescriptor(_target, key) {
    return Reflect.getOwnPropertyDescriptor(load(), key);
  },
});

/** For tests: forget the cached values after changing `process.env`. */
export function resetEnvCache(): void {
  cached = undefined;
}

/** Every origin BetterAuth and CSRF checks should trust. */
export function trustedOrigins(): string[] {
  const origins = [env.NEXT_PUBLIC_APP_URL, env.INTERNAL_APP_URL, ...env.EXTRA_TRUSTED_ORIGINS];
  return [...new Set(origins.filter((value): value is string => Boolean(value)).map((value) => new URL(value).origin))];
}
