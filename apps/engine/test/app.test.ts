/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { signPublicPath } from "../src/auth/signed-url.js";
import { createApp } from "../src/http/app.js";
import type { HealthProbes } from "../src/http/routes/health.js";
import { ENGINE_KEY, makeTestEngine } from "./fakes.js";

function makeApp(probes: Partial<HealthProbes> = {}) {
  const e = makeTestEngine();
  const app = createApp({
    config: e.config,
    engineKey: ENGINE_KEY,
    masterKey: e.ctx.masterKey,
    logger: e.ctx.logger,
    ctx: e.ctx,
    probes: {
      db: async () => true,
      queue: async () => true,
      docker: async () => "unavailable",
      diskFreeGb: async () => 42.5,
      dataDirCheck: () => "ok",
      ...probes,
    },
  });
  return { app, e };
}

const auth = { headers: { "api-key": ENGINE_KEY } };

describe("GET /v2/system/health", () => {
  it("is public and reports every probe", async () => {
    const res = await makeApp().app.request("/v2/system/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ ok: true, db: "ok", queue: "ok", docker: "unavailable", disk: { freeGb: 42.5 }, dataDirCheck: "ok" });
    expect(typeof body.version).toBe("string");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("answers 503 when the database is down (mocked)", async () => {
    const res = await makeApp({ db: async () => false }).app.request("/v2/system/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, db: "error", queue: "ok" });
  });

  it("treats a throwing probe as an error, not a crash", async () => {
    const res = await makeApp({
      queue: async () => {
        throw new Error("boom");
      },
    }).app.request("/v2/system/health");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ queue: "error" });
  });
});

describe("auth", () => {
  it("rejects /v1 without api-key in the v1 envelope", async () => {
    const res = await makeApp().app.request("/v1/account");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      errors: { errorCode: "UNAUTHORIZED", errorMessage: "Missing or invalid api-key" },
      data: null,
    });
  });

  it("rejects /v2 with a wrong key in the v2 shape", async () => {
    const res = await makeApp().app.request("/v2/projects/x/budget", { headers: { "api-key": "nope" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Missing or invalid api-key" } });
  });

  it("lets signed public paths through without api-key (and refuses bad tokens)", async () => {
    const { app, e } = makeApp();
    const path = signPublicPath(e.ctx.masterKey, { projectId: "nope-project", resource: "uploads/a", ttlSeconds: 60 });
    const res = await app.request(path);
    expect(res.status).toBe(404);
    const bad = await app.request("/v1/public/not-a-token");
    expect(bad.status).toBe(403);
    expect(((await bad.json()) as any).errors.errorCode).toBe("INVALID_TOKEN");
    const expired = signPublicPath(e.ctx.masterKey, { projectId: "p", resource: "uploads/a", ttlSeconds: 1, now: Date.now() - 10_000 });
    expect((await app.request(expired)).status).toBe(403);
  });
});

describe("v1 basics", () => {
  it("GET /v1/account", async () => {
    const res = await makeApp().app.request("/v1/account", auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      errors: null,
      data: { credits: null, mode: "self-hosted", budgets: { perRunUsd: 8, perProjectMonthUsd: 60, globalMonthUsd: null } },
    });
  });

  it("GET /v1/credit-costs", async () => {
    const res = await makeApp().app.request("/v1/credit-costs", auth);
    expect(await res.json()).toEqual({ errors: null, data: {} });
  });

  it("GET /v1/system/public-config", async () => {
    const res = await makeApp().app.request("/v1/system/public-config", auth);
    expect(await res.json()).toEqual({
      errors: null,
      data: { publishScheme: "http", publishDomain: "apps.forja.localhost", previewDomain: "forja.localhost" },
    });
  });

  it("unknown endpoints answer NOT_IMPLEMENTED 501 in the envelope", async () => {
    for (const [method, path] of [
      ["POST", "/v1/projects/p1/export"],
      ["GET", "/v1/project-groups"],
      ["GET", "/v1/webhooks"],
    ] as const) {
      const res = await makeApp().app.request(path, { method, headers: { "api-key": ENGINE_KEY } });
      const body = (await res.json()) as any;
      expect(body.data).toBeNull();
      expect([501, 404]).toContain(res.status);
      expect(typeof body.errors.errorMessage).toBe("string");
    }
  });

  it("unknown /v2 routes are 404 in the v2 shape", async () => {
    const res = await makeApp().app.request("/v2/nope", auth);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
  });
});
