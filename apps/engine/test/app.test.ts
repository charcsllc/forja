/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomBytes } from "node:crypto";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { signPublicPath } from "../src/auth/signed-url.js";
import { createApp, type AppDeps } from "../src/http/app.js";
import type { HealthProbes } from "../src/http/routes/health.js";

const engineKey = "test-engine-key-0123456789abcdef";
const masterKey = randomBytes(32).toString("base64");

function makeApp(probes: Partial<HealthProbes> = {}) {
  const deps: AppDeps = {
    config: { BUDGET_PER_RUN_USD: 8, BUDGET_PER_PROJECT_MONTH_USD: 60, BUDGET_GLOBAL_MONTH_USD: null },
    engineKey,
    masterKey,
    logger: pino({ level: "silent" }),
    probes: {
      db: async () => true,
      queue: async () => true,
      docker: async () => "unavailable",
      diskFreeGb: async () => 42.5,
      dataDirCheck: () => "skipped",
      ...probes,
    },
  };
  return createApp(deps);
}

const auth = { headers: { "api-key": engineKey } };

describe("GET /v2/system/health", () => {
  it("is public and reports every probe", async () => {
    const res = await makeApp().request("/v2/system/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      ok: true,
      db: "ok",
      queue: "ok",
      docker: "unavailable",
      disk: { freeGb: 42.5 },
      dataDirCheck: "skipped",
    });
    expect(typeof body.version).toBe("string");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("answers 503 when the database is down (mocked)", async () => {
    const res = await makeApp({ db: async () => false }).request("/v2/system/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: "error", queue: "ok" });
  });

  it("treats a throwing probe as an error, not a crash", async () => {
    const res = await makeApp({
      queue: async () => {
        throw new Error("boom");
      },
    }).request("/v2/system/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ queue: "error" });
  });
});

describe("auth", () => {
  it("rejects /v1 without api-key in the v1 envelope", async () => {
    const res = await makeApp().request("/v1/account");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      errors: { errorCode: "UNAUTHORIZED", errorMessage: "Missing or invalid api-key" },
      data: null,
    });
  });

  it("rejects /v2 with a wrong key in the v2 shape", async () => {
    const res = await makeApp().request("/v2/runs/x/events", { headers: { "api-key": "nope" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Missing or invalid api-key" } });
  });

  it("lets signed public paths through without api-key", async () => {
    const path = signPublicPath(masterKey, { projectId: "p1", resource: "uploads/a", ttlSeconds: 60 });
    const res = await makeApp().request(path);
    expect(res.status).toBe(501);
    const bad = await makeApp().request("/v1/public/not-a-token");
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as any).errors.errorCode).toBe("INVALID_TOKEN");
  });
});

describe("v1", () => {
  it("GET /v1/account", async () => {
    const res = await makeApp().request("/v1/account", auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      errors: null,
      data: {
        credits: null,
        mode: "self-hosted",
        budgets: { perRunUsd: 8, perProjectMonthUsd: 60, globalMonthUsd: null },
      },
    });
  });

  it("GET /v1/credit-costs", async () => {
    const res = await makeApp().request("/v1/credit-costs", auth);
    expect(await res.json()).toEqual({ errors: null, data: {} });
  });

  it("unimplemented endpoints answer NOT_IMPLEMENTED 501 in the envelope", async () => {
    for (const [method, path] of [
      ["GET", "/v1/projects"],
      ["POST", "/v1/projects/launch"],
      ["PUT", "/v1/projects/p1/files/content"],
      ["DELETE", "/v1/projects/p1"],
    ] as const) {
      const res = await makeApp().request(path, { method, headers: { "api-key": engineKey } });
      expect(res.status).toBe(501);
      const body = (await res.json()) as any;
      expect(body.data).toBeNull();
      expect(body.errors.errorCode).toBe("NOT_IMPLEMENTED");
      expect(typeof body.errors.errorMessage).toBe("string");
    }
  });

  it("unknown /v2 routes are 404 in the v2 shape", async () => {
    const res = await makeApp().request("/v2/nope", auth);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
  });
});
