/**
 * The engine's Hono app. Built from injected dependencies so tests can mock the probes.
 *
 * Middleware order: request id → access log → auth → routes; one error handler that answers
 * in the v1 envelope under /v1 and in the v2 shape elsewhere.
 *
 * ⚠️ Auth: every route needs `api-key: FORJA_ENGINE_KEY` except `GET /v2/system/health`
 * and the signed public surface under `/v1/public/` (05 §2.3), which carries its own HMAC
 * token. Nothing else is public.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestId, type RequestIdVariables } from "hono/request-id";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import { PUBLIC_PATH_PREFIX } from "../auth/signed-url.js";
import { EngineError, isV1Path, v1Error, v2Error } from "./errors.js";
import { healthRoutes, type HealthProbes } from "./routes/health.js";
import { v1Routes } from "./routes/v1.js";

export const HEALTH_PATH = "/v2/system/health";

export interface AppDeps {
  config: Pick<
    Config,
    "BUDGET_PER_RUN_USD" | "BUDGET_PER_PROJECT_MONTH_USD" | "BUDGET_GLOBAL_MONTH_USD"
  >;
  engineKey: string;
  masterKey: string;
  logger: Logger;
  probes: HealthProbes;
}

export type AppEnv = { Variables: RequestIdVariables };

function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isPublicPath(path: string): boolean {
  return path === HEALTH_PATH || path.startsWith(PUBLIC_PATH_PREFIX);
}

/** Paths are logged without query strings, and public tokens are masked. */
function loggablePath(path: string): string {
  return path.startsWith(PUBLIC_PATH_PREFIX) ? `${PUBLIC_PATH_PREFIX}<token>` : path;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(requestId({ limitLength: 128 }));

  app.use(async (c, next) => {
    const started = performance.now();
    await next();
    deps.logger.info(
      {
        reqId: c.get("requestId"),
        method: c.req.method,
        path: loggablePath(c.req.path),
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      "request",
    );
  });

  app.use(async (c, next) => {
    if (isPublicPath(c.req.path)) return next();
    if (!keyMatches(c.req.header("api-key"), deps.engineKey)) {
      throw new EngineError(401, "UNAUTHORIZED", "Missing or invalid api-key");
    }
    return next();
  });

  app.route("/", healthRoutes(deps.probes));
  app.route("/v1", v1Routes(deps));

  app.notFound((c) =>
    isV1Path(c.req.path)
      ? c.json(v1Error("NOT_FOUND", "Not found"), 404)
      : c.json(v2Error("NOT_FOUND", "Not found"), 404),
  );

  app.onError((err, c) => {
    let status = 500;
    let code = "INTERNAL_ERROR";
    let message = "Internal error";
    if (err instanceof EngineError) {
      status = err.status;
      code = err.code;
      message = err.message;
    } else if (err instanceof HTTPException) {
      status = err.status;
      code = status === 400 ? "VALIDATION" : status === 404 ? "NOT_FOUND" : "HTTP_ERROR";
      message = err.message || message;
    } else {
      deps.logger.error({ err, reqId: c.get("requestId") }, "unhandled error");
    }
    const body = isV1Path(c.req.path) ? v1Error(code, message) : v2Error(code, message);
    return c.json(body, status as 500);
  });

  return app;
}
