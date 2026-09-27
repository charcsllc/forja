/**
 * API v1 (Totalum-compatible envelope `{errors, data}`, docs/research/02).
 * Phase 0 implements `account`, `credit-costs` and the signed public surface's token check;
 * every other path answers `NOT_IMPLEMENTED` 501 in the envelope so apps/web can already
 * point at the engine and get well-formed errors.
 */
import { Hono } from "hono";
import { verifyPublicToken } from "../../auth/signed-url.js";
import type { AppDeps } from "../app.js";
import { EngineError } from "../errors.js";

export function v1Routes(deps: Pick<AppDeps, "config" | "masterKey">): Hono {
  const r = new Hono();

  r.get("/account", (c) =>
    c.json({
      errors: null,
      data: {
        credits: null,
        mode: "self-hosted",
        budgets: {
          perRunUsd: deps.config.BUDGET_PER_RUN_USD,
          perProjectMonthUsd: deps.config.BUDGET_PER_PROJECT_MONTH_USD,
          globalMonthUsd: deps.config.BUDGET_GLOBAL_MONTH_USD,
        },
      },
    }),
  );

  r.get("/credit-costs", (c) => c.json({ errors: null, data: {} }));

  // Signed public surface: the token is verified now; serving the resource lands in phase 1.
  r.get("/public/:token", (c) => {
    const result = verifyPublicToken(deps.masterKey, c.req.param("token"));
    if (!result.ok) throw new EngineError(403, "INVALID_TOKEN", "Invalid or expired link");
    throw new EngineError(501, "NOT_IMPLEMENTED", "Public resources are served from phase 1");
  });

  r.all("/*", (c) => {
    throw new EngineError(501, "NOT_IMPLEMENTED", `${c.req.method} ${c.req.path} is not implemented yet`);
  });

  return r;
}
