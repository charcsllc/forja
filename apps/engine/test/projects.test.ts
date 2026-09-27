import { describe, expect, it } from "vitest";
import { activeProject, makeTestEngine } from "./fakes.js";
import { suffixed } from "../src/services/projects.js";

describe("POST /v1/projects", () => {
  it("creates a project in Creating, queues provisioning, and provisioning reaches Active", async () => {
    const e = makeTestEngine();
    const res = await e.json("POST", "/v1/projects", { projectId: "my-shop", description: "A shop" });
    expect(res.status).toBe(200);
    expect(res.body.errors).toBeNull();
    expect(res.body.data).toMatchObject({
      projectId: "my-shop",
      label: "my-shop",
      description: "A shop",
      plan: "self-hosted",
      agentServerStatus: "Creating",
      agentProcessStatus: "idle",
      deployment: null,
      customDomain: null,
      secrets: [],
      developmentUrlFieldToUse: "temporalDevelopmentProjectUrl",
      temporalDevelopmentProjectUrl: "http://my-shop.forja.localhost",
      internalDevelopmentUrl: "http://forja-app-my-shop:3000",
    });
    expect(res.body.data.requestedProjectId).toBeUndefined();
    expect(e.queue.sent.map((j) => j.name)).toEqual(["sandbox.provision"]);
    expect((await e.store.getOperation("my-shop"))?.kind).toBe("provision");

    await e.queue.drain();
    const p = await e.json("GET", "/v1/projects/my-shop");
    expect(p.body.data.agentServerStatus).toBe("Active");
    expect(p.body.data.serverErrorMessage).toBeNull();
    expect(p.body.data.templateVersion).toBe("9.9.9");
    expect(await e.store.getOperation("my-shop")).toBeNull();
    // DB passwords + auth secret are system secrets: stored, never listed.
    expect((await e.store.listSecrets("my-shop", "system")).map((s) => s.name).sort()).toEqual([
      "BETTER_AUTH_SECRET",
      "FORJA_DB_APP_RW_PASSWORD",
      "FORJA_DB_CMS_RO_PASSWORD",
      "FORJA_DB_CMS_RW_PASSWORD",
      "FORJA_DB_SUPERUSER_PASSWORD",
    ]);
    expect(p.body.data.secrets).toEqual([]);
    expect(e.sandbox.projects.get("my-shop")?.env.BETTER_AUTH_SECRET?.length).toBeGreaterThanOrEqual(32);
    expect(e.sandbox.projects.get("my-shop")?.env.ALLOWED_FRAME_ANCESTORS).toBe("http://localhost:3000");
    // Engine attached to the internal network; migrations ran.
    expect(e.sandbox.attached.has("forja-int-my-shop>forja-engine-test")).toBe(true);
    expect(e.sandbox.calls).toContain("exec:forja-app-my-shop:npm run --silent");
  });

  it("auto-suffixes a taken id and echoes requestedProjectId", async () => {
    const e = makeTestEngine();
    await e.json("POST", "/v1/projects", { projectId: "taken-id", description: "" });
    const second = await e.json("POST", "/v1/projects", { projectId: "taken-id", description: "" });
    expect(second.body.data.projectId).toBe("taken-id-2");
    expect(second.body.data.requestedProjectId).toBe("taken-id");
    const third = await e.json("POST", "/v1/projects", { projectId: "taken-id", description: "" });
    expect(third.body.data.projectId).toBe("taken-id-3");
  });

  it("keeps suffixed ids within 35 chars", () => {
    const base = "a".repeat(35);
    expect(suffixed(base, 2)).toHaveLength(35);
    expect(suffixed(base, 2).endsWith("-2")).toBe(true);
    expect(suffixed("abc-defghijklmnopqrstuvwxyz-abcdefg", 12)).not.toMatch(/--/);
  });

  it.each([
    ["", 400, "MISSING_PROJECT_ID"],
    ["abc", 400, "INVALID_PROJECT_NAME_LENGTH"],
    ["Bad_Name", 400, "INVALID_PROJECT_NAME"],
    ["double--hyphen", 400, "INVALID_PROJECT_NAME"],
    ["my-dev-app", 400, "RESERVED_PROJECT_NAME"],
    ["traefik", 400, "RESERVED_PROJECT_NAME"],
    ["admin", 400, "RESERVED_PROJECT_NAME"],
  ])("refuses %j with %i %s", async (projectId, status, code) => {
    const e = makeTestEngine();
    const res = await e.json("POST", "/v1/projects", { projectId, description: "" });
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ errors: { errorCode: code, errorMessage: expect.any(String) }, data: null });
  });
});

describe("POST /v1/projects/launch (phase 1)", () => {
  it("creates + provisions and reports the agent as not started with an `agent` warning", async () => {
    const e = makeTestEngine();
    await e.json("POST", "/v1/projects", { projectId: "bakery", description: "" });
    const res = await e.json("POST", "/v1/projects/launch", { projectId: "bakery", prompt: "A bakery site", description: "A bakery site" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      projectId: "bakery-2",
      requestedProjectId: "bakery",
      agent: { started: false },
    });
    expect(res.body.data.warnings).toContainEqual(expect.objectContaining({ step: "agent", code: "NOT_IMPLEMENTED" }));
    const got = await e.json("GET", "/v1/projects/bakery-2");
    expect(got.status).toBe(200);
  });

  it("requires a prompt", async () => {
    const e = makeTestEngine();
    const res = await e.json("POST", "/v1/projects/launch", { projectId: "bakery" });
    expect(res.status).toBe(400);
    expect(res.body.errors.errorCode).toBe("MISSING_PROMPT");
  });

  it("warns on figma", async () => {
    const e = makeTestEngine();
    const res = await e.json("POST", "/v1/projects/launch", { projectId: "figgy", prompt: "x", figma: { token: "t" } });
    expect(res.body.data.warnings[0]).toMatchObject({ step: "figma", code: "NOT_IMPLEMENTED" });
  });
});

describe("GET /v1/projects", () => {
  it("returns ALL projects without a limit, as summaries", async () => {
    const e = makeTestEngine();
    for (let i = 0; i < 25; i++) await e.json("POST", "/v1/projects", { projectId: `proj-${String(i).padStart(2, "0")}`, description: `n${i}` });
    const res = await e.json("GET", "/v1/projects");
    expect(res.body.data).toHaveLength(25);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(
      ["createdAt", "description", "label", "lastModifiedAt", "plan", "previewImageUrl", "projectId"].sort(),
    );
    const limited = await e.json("GET", "/v1/projects?limit=5&skip=2");
    expect(limited.body.data).toHaveLength(5);
    const search = await e.json("GET", "/v1/projects?search=n13");
    expect(search.body.data.map((p: { projectId: string }) => p.projectId)).toEqual(["proj-13"]);
  });
});

describe("PATCH / DELETE / undelete", () => {
  it("updates label and description; null label resets to the id", async () => {
    const e = makeTestEngine();
    await activeProject(e, "patch-me");
    const r1 = await e.json("PATCH", "/v1/projects/patch-me", { label: "Nice", description: "New" });
    expect(r1.body.data).toMatchObject({ label: "Nice", description: "New" });
    const r2 = await e.json("PATCH", "/v1/projects/patch-me", { label: null });
    expect(r2.body.data.label).toBe("patch-me");
  });

  it("soft-deletes (404 after, id stays taken), removes the sandbox, and undeletes", async () => {
    const e = makeTestEngine();
    await activeProject(e, "gone-soon");
    const del = await e.json("DELETE", "/v1/projects/gone-soon");
    expect(del.body.data).toEqual({ projectId: "gone-soon", deleted: true });
    expect((await e.json("GET", "/v1/projects/gone-soon")).status).toBe(404);
    expect((await e.json("GET", "/v1/projects")).body.data).toHaveLength(0);
    await e.queue.drain();
    expect(e.sandbox.projects.has("gone-soon")).toBe(false);
    expect(e.sandbox.attached.size).toBe(0);
    const again = await e.json("POST", "/v1/projects", { projectId: "gone-soon", description: "" });
    expect(again.body.data.projectId).toBe("gone-soon-2");

    const un = await e.json("POST", "/v2/projects/gone-soon/undelete");
    expect(un.status).toBe(200);
    expect(un.body.agentServerStatus).toBe("Creating");
    await e.queue.drain();
    expect((await e.json("GET", "/v1/projects/gone-soon")).body.data.agentServerStatus).toBe("Active");
  });

  it("404s unknown and unroutable ids in the envelope", async () => {
    const e = makeTestEngine();
    for (const id of ["does-not-exist", "UPPER", "a".repeat(70)]) {
      const res = await e.json("GET", `/v1/projects/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.errors.errorCode).toBe("PROJECT_NOT_FOUND");
    }
  });
});

describe("agent (phase 1 stand-ins) and stubs", () => {
  it("answers idle/empty status and conversation; start is 501; stop is NO_PROCESS_RUNNING", async () => {
    const e = makeTestEngine();
    await activeProject(e, "agent-less");
    const st = await e.json("GET", "/v1/projects/agent-less/agent/status");
    expect(st.body.data).toMatchObject({ projectId: "agent-less", status: "idle", startedAt: null, realtimeConversation: [] });
    const conv = await e.json("GET", "/v1/projects/agent-less/agent/full-conversation");
    expect(conv.body.data.conversation).toEqual([]);
    const start = await e.json("POST", "/v1/projects/agent-less/agent/start", { prompt: "x", inputFiles: [] });
    expect(start.status).toBe(501);
    expect(start.body.errors.errorCode).toBe("NOT_IMPLEMENTED");
    const stop = await e.json("POST", "/v1/projects/agent-less/agent/stop", {});
    expect(stop.status).toBe(409);
    expect(stop.body.errors.errorCode).toBe("NO_PROCESS_RUNNING");
  });

  it("answers the 05 §2.1 stubs exactly", async () => {
    const e = makeTestEngine();
    await activeProject(e, "stubby");
    expect((await e.json("GET", "/v1/projects/stubby/deployments/status")).body.data).toEqual({ status: null });
    expect((await e.json("POST", "/v1/projects/stubby/deployments/deploy", {})).status).toBe(501);
    expect((await e.json("PUT", "/v1/projects/stubby/domain", { hostname: "x.com" })).status).toBe(501);
    expect((await e.json("GET", "/v1/projects/stubby/github/status")).body.data).toEqual({
      connected: false,
      tokenValid: false,
      tokenExpired: false,
    });
    expect((await e.json("GET", "/v1/projects/stubby/github/pull-status")).body.data).toEqual({ status: null });
    expect((await e.json("GET", "/v1/projects/stubby/figma/status")).body.data).toEqual({ connected: false });
    expect((await e.json("POST", "/v1/projects/stubby/github/connect", {})).body.errors.errorCode).toBe("NOT_IMPLEMENTED");
    expect((await e.json("POST", "/v1/projects/stubby/figma/connect", {})).body.errors.errorCode).toBe("NOT_IMPLEMENTED");
    expect((await e.json("GET", "/v1/projects/stubby/backend/prod/logs")).body.data).toEqual({ records: [] });
  });
});

describe("secrets", () => {
  it("stores write-only values, lists names, masks github/env, refuses reserved names", async () => {
    const e = makeTestEngine();
    await activeProject(e, "secretive");
    const created = await e.json("POST", "/v1/projects/secretive/secrets", { secretName: "STRIPE_KEY", secretValue: "sk_live_x", environment: "both" });
    expect(created.body.data).toEqual({ _id: expect.any(String), secretName: "STRIPE_KEY", environment: "both" });
    const p = await e.json("GET", "/v1/projects/secretive");
    expect(p.body.data.secrets).toEqual([{ _id: created.body.data._id, secretName: "STRIPE_KEY", environment: "both" }]);
    expect(JSON.stringify(p.body)).not.toContain("sk_live_x");
    const row = (await e.store.listSecrets("secretive", "user"))[0];
    expect(row?.ciphertext).not.toContain("sk_live_x");
    const env = await e.json("GET", "/v1/projects/secretive/github/env");
    expect(env.body.data.envDev).toBe("STRIPE_KEY=***");
    for (const bad of ["DATABASE_URL", "BETTER_AUTH_SECRET", "1BAD", "with space"]) {
      const r = await e.json("POST", "/v1/projects/secretive/secrets", { secretName: bad, secretValue: "v", environment: "both" });
      expect(r.status).toBe(400);
      expect(r.body.errors.errorCode).toBe("INVALID_SECRET_KEY_NAME");
    }
    const del = await e.json("DELETE", `/v1/projects/secretive/secrets/${created.body.data._id}`);
    expect(del.body.data).toEqual({ deleted: true });
    expect((await e.json("DELETE", `/v1/projects/secretive/secrets/${created.body.data._id}`)).status).toBe(404);
  });
});

describe("GET /v2/projects/:id/budget", () => {
  it("has the UI's shape with zeros before the ledger exists", async () => {
    const e = makeTestEngine();
    await activeProject(e, "budgeted");
    const res = await e.call("GET", "/v2/projects/budgeted/budget");
    expect(await res.json()).toEqual({
      project: { monthSpentUsd: 0, monthBudgetUsd: 60 },
      runs: [],
      global: { monthSpentUsd: 0, monthBudgetUsd: null },
    });
    expect((await e.call("GET", "/v2/projects/nope-nope/budget")).status).toBe(404);
  });

  it("reports runs of this month", async () => {
    const e = makeTestEngine();
    await activeProject(e, "spender");
    e.store.runs.push({ projectId: "spender", id: "r1", startedAt: new Date(), createdAt: new Date(), status: "done", spentUsd: 1.25, budgetUsd: null });
    const body = (await (await e.call("GET", "/v2/projects/spender/budget")).json()) as { runs: unknown[]; project: unknown };
    expect(body.project).toEqual({ monthSpentUsd: 1.25, monthBudgetUsd: 60 });
    expect(body.runs).toEqual([{ id: "r1", startedAt: expect.any(String), status: "done", spentUsd: 1.25, budgetUsd: 8 }]);
  });
});
