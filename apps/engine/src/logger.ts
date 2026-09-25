/**
 * Engine logger (pino).
 *
 * ⚠️ Redaction is structural, not path-based: every object logged is walked and any key
 * named `api-key`/`authorization` or matching /key|secret|token|password/i is replaced
 * with "[redacted]" (07 §4: logs carry runId/taskId/role, never prompts or keys).
 * Pretty output only outside production and only when pino-pretty (a devDependency) is
 * installed, so the runtime image never needs it.
 */
import { createRequire } from "node:module";
import pino, { type Logger, type LoggerOptions } from "pino";

export type { Logger };

const SENSITIVE_KEY = /key|secret|token|password|authorization|cookie/i;
const REDACTED = "[redacted]";
const MAX_DEPTH = 8;

export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return value; // pino's err serializer handles errors
  if (seen.has(value) || depth > MAX_DEPTH) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactDeep(v, depth + 1, seen);
  }
  return out;
}

function prettyAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export interface LoggerSettings {
  level: string;
  pretty?: boolean;
}

export function createLogger(settings: LoggerSettings): Logger {
  const pretty =
    settings.pretty ??
    (process.env.NODE_ENV !== "production" && !process.env.VITEST && prettyAvailable());
  const options: LoggerOptions = {
    level: settings.level,
    base: { service: "forja-engine" },
    // Belt and braces for the common header paths, in case something bypasses `formatters.log`.
    redact: {
      paths: [
        'req.headers["api-key"]',
        "req.headers.authorization",
        'headers["api-key"]',
        "headers.authorization",
      ],
      censor: REDACTED,
    },
    formatters: {
      log: (obj) => redactDeep(obj) as Record<string, unknown>,
    },
  };
  if (pretty) {
    options.transport = {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname,service" },
    };
  }
  return pino(options);
}
