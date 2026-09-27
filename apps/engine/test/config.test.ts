import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatProblems, parseConfig } from "../src/config.js";

function ok(env: NodeJS.ProcessEnv) {
  const r = parseConfig(env);
  if (!r.ok) throw new Error(formatProblems(r.problems));
  return r.config;
}

function problems(env: NodeJS.ProcessEnv) {
  const r = parseConfig(env);
  if (r.ok) throw new Error("expected a configuration error");
  return r.problems;
}

describe("config defaults (09-env-reference)", () => {
  it("fills every default from an empty environment", () => {
    const c = ok({});
    expect(c.DATABASE_URL).toBe("postgres://forja:forja@postgres:5432/forja");
    expect(c.DATA_DIR).toBe("/data");
    expect(c.DATA_DIR_HOST).toBe("/srv/forja/data");
    expect(c.ENGINE_PORT).toBe(4000);
    expect(c.ENGINE_INSTANCES).toBe(1);
    expect(c.LOG_LEVEL).toBe("info");
    expect(c.LOGS_RETENTION_DAYS).toBe(7);
    expect(c.EVENTS_RETENTION_DAYS).toBe(30);
    expect(c.UPLOAD_MAX_MB).toBe(8);
    expect(c.ENGINE_MAX_CONCURRENT_RUNS).toBe(2);
    expect(c.BUDGET_PER_RUN_USD).toBe(8);
    expect(c.BUDGET_PER_PROJECT_MONTH_USD).toBe(60);
    expect(c.BUDGET_GLOBAL_MONTH_USD).toBeNull();
    expect(c.SANDBOX_DRIVER).toBe("docker");
    expect(c.SANDBOX_RUNTIME).toBeUndefined();
    expect(c.SANDBOX_MEM).toBe("2g");
    expect(c.SANDBOX_CPUS).toBe(2);
    expect(c.SANDBOX_PIDS).toBe(512);
    expect(c.SANDBOX_EGRESS).toBe("internet");
    expect(c.SANDBOX_IDLE_MINUTES).toBe(120);
    expect(c.SANDBOX_MAX_ACTIVE).toBe(5);
    expect(c.SANDBOX_START_TIMEOUT_SEC).toBe(300);
    expect(c.DISK_MIN_FREE_GB).toBe(5);
    expect(c.PROJECT_MAX_SIZE_MB).toBe(2048);
    expect(c.PROJECT_PURGE_AFTER_DAYS).toBe(7);
    expect(c.PREVIEW_DOMAIN).toBe("forja.localhost");
    expect(c.PREVIEW_TLS).toBe(false);
    expect(c.PREVIEW_PUBLIC).toBe(true);
    expect(c.PUBLISH_DOMAIN).toBe("apps.forja.localhost");
    expect(c.PUBLISH_TLS).toBe(false);
    expect(c.TRAEFIK_DASHBOARD).toBe(false);
    expect(c.ALLOW_ENV_EXPORT).toBe(false);
    expect(c.WEBHOOK_TIMEOUT_MS).toBe(10000);
    expect(c.rawProviderEnv).toEqual({});
  });

  it("treats empty values as unset (KEY= in the example file)", () => {
    const c = ok({ ENGINE_PORT: "", SANDBOX_RUNTIME: "", FORJA_ENGINE_KEY: "", PUBLISH_IP: "" });
    expect(c.ENGINE_PORT).toBe(4000);
    expect(c.FORJA_ENGINE_KEY).toBeUndefined();
  });

  it("an explicitly empty budget means no limit", () => {
    expect(ok({ BUDGET_PER_RUN_USD: "" }).BUDGET_PER_RUN_USD).toBeNull();
    expect(ok({ BUDGET_GLOBAL_MONTH_USD: "250" }).BUDGET_GLOBAL_MONTH_USD).toBe(250);
  });

  it("collects provider and agent env raw, untouched", () => {
    const c = ok({
      LLM_ANTHROPIC: "true|sk-x",
      IMAGE_FAL: "false|",
      STOCK_PEXELS: "false|",
      AGENT_MAX_TURNS_PER_TASK: "60",
      OTHER: "x",
    });
    expect(c.rawProviderEnv).toEqual({
      LLM_ANTHROPIC: "true|sk-x",
      IMAGE_FAL: "false|",
      STOCK_PEXELS: "false|",
      AGENT_MAX_TURNS_PER_TASK: "60",
    });
  });

  it("server mode flips the PREVIEW_PUBLIC default", () => {
    const c = ok({
      PUBLISH_TLS: "true",
      ACME_EMAIL: "ops@example.com",
      FORJA_ENGINE_KEY: "k".repeat(32),
      FORJA_MASTER_KEY: randomBytes(32).toString("base64"),
    });
    expect(c.PREVIEW_PUBLIC).toBe(false);
    expect(ok({ PREVIEW_PUBLIC: "false" }).PREVIEW_PUBLIC).toBe(false);
  });
});

describe("config errors", () => {
  it("rejects bad types and enums", () => {
    const vars = problems({
      ENGINE_PORT: "abc",
      SANDBOX_EGRESS: "everything",
      PREVIEW_TLS: "maybe",
      SANDBOX_MEM: "lots",
      DATABASE_URL: "mysql://x",
    }).map((p) => p.variable);
    expect(vars).toEqual(
      expect.arrayContaining(["ENGINE_PORT", "SANDBOX_EGRESS", "PREVIEW_TLS", "SANDBOX_MEM", "DATABASE_URL"]),
    );
  });

  it("requires ACME_EMAIL with TLS and REDIS_URL with several instances", () => {
    const vars = problems({ PREVIEW_TLS: "true", ENGINE_INSTANCES: "2" }).map((p) => p.variable);
    expect(vars).toEqual(expect.arrayContaining(["ACME_EMAIL", "REDIS_URL"]));
  });

  it("requires both keys from env in server mode", () => {
    const vars = problems({ PUBLISH_TLS: "true", ACME_EMAIL: "ops@example.com" }).map((p) => p.variable);
    expect(vars).toEqual(expect.arrayContaining(["FORJA_ENGINE_KEY", "FORJA_MASTER_KEY"]));
  });

  it("rejects a master key that is not 32 bytes and never prints secret values", () => {
    const p = problems({ FORJA_MASTER_KEY: "c2hvcnQ=" });
    expect(p[0]?.variable).toBe("FORJA_MASTER_KEY");
    expect(p[0]?.value).toBe("(redacted)");
    expect(formatProblems(p)).not.toContain("c2hvcnQ=");
  });

  it("masks the database password in the problem table", () => {
    const r = parseConfig({ DATABASE_URL: "postgres://u:hunter2@db/x", ENGINE_PORT: "0" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(formatProblems(r.problems)).not.toContain("hunter2");
  });
});
