import pino from "pino";
import { env } from "@/env";

/** Structured JSON logs to stdout. Never log request bodies, secrets or personal data. */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  base: undefined,
  redact: {
    paths: ["password", "*.password", "token", "*.token", "headers.authorization", "headers.cookie"],
    censor: "[redacted]",
  },
});
