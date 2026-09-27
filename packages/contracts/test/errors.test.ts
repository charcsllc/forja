import { describe, expect, it } from "vitest";
import {
  ENGINE_ERROR_CODES,
  ENGINE_ERROR_STATUS,
  STATUS_FOR,
  UPSTREAM_CODE_MAP,
  VCAAS_ERROR_CODES,
  classifyUpstreamCode,
  isEngineErrorCode,
  isVcaasErrorCode,
} from "../src/v1/errors";

describe("upstream → normalised mapping", () => {
  it.each([
    ["INSUFFICIENT_CREDITS", 402, "INSUFFICIENT_CREDITS"],
    ["PROJECT_EXPORT_LIMIT_REACHED", 429, "INSUFFICIENT_CREDITS"],
    ["MAX_PROJECTS_REACHED", 403, "PROJECT_LIMIT_REACHED"],
    ["PLATFORM_FREE_PLAN_NO_GITHUB", 403, "PLAN_REQUIRED"],
    ["PLAN_SOMETHING_NEW", 403, "PLAN_REQUIRED"],
    ["NO_DEPLOYMENT", 404, "PROJECT_NOT_FOUND"],
    ["MISSING_PROJECT_ID", 400, "PROJECT_NOT_FOUND"],
    ["TOO_MANY_PROMPTS", 429, "RATE_LIMITED"],
    ["RATE_LIMIT_EXCEEDED", 429, "RATE_LIMITED"],
    ["RESERVED_PROJECT_NAME", 400, "VALIDATION"],
    ["PROJECT_ALREADY_EXISTS", 400, "VALIDATION"],
    ["MISSING_ANYTHING", 400, "VALIDATION"],
    ["INVALID_WHATEVER", 422, "VALIDATION"],
    ["invalid_project_name", 400, "VALIDATION"],
    ["SERVER_NOT_READY", 409, "UNKNOWN"],
    ["SANDBOX_NOT_REACHABLE", 409, "UNKNOWN"],
    [undefined, 402, "INSUFFICIENT_CREDITS"],
    [undefined, 404, "PROJECT_NOT_FOUND"],
    ["SOMETHING_ELSE", 500, "UNKNOWN"],
  ] as const)("%s (%i) → %s", (code, status, expected) => {
    expect(classifyUpstreamCode(code, status)).toBe(expected);
  });

  it("maps only to known normalised codes and has a status for each", () => {
    for (const value of Object.values(UPSTREAM_CODE_MAP)) expect(isVcaasErrorCode(value)).toBe(true);
    for (const code of VCAAS_ERROR_CODES) expect(STATUS_FOR[code]).toBeGreaterThanOrEqual(400);
    expect(isVcaasErrorCode("UPLOAD_QUOTA_EXCEEDED")).toBe(true);
    expect(isVcaasErrorCode("SERVER_NOT_READY")).toBe(false);
  });
});

describe("engine codes", () => {
  it("has a unique entry and an HTTP status per code", () => {
    const codes = ENGINE_ERROR_CODES.map((e) => e.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(ENGINE_ERROR_STATUS.NO_PROVIDER_ENABLED).toBe(503);
    expect(ENGINE_ERROR_STATUS.STALE_WRITE).toBe(409);
    expect(ENGINE_ERROR_STATUS.FORBIDDEN_PATH).toBe(403);
    expect(ENGINE_ERROR_STATUS.SERVER_NOT_READY).toBe(409);
    expect(ENGINE_ERROR_STATUS.NOT_IMPLEMENTED).toBe(501);
    expect(ENGINE_ERROR_STATUS.INSUFFICIENT_CREDITS).toBe(402);
    expect(ENGINE_ERROR_STATUS.FILE_TOO_LARGE).toBe(413);
    expect(isEngineErrorCode("AGENT_RUNNING")).toBe(true);
    expect(isEngineErrorCode("PLAN_REQUIRED")).toBe(false);
  });

  it("normalises engine codes the way the UI expects", () => {
    for (const { code, status } of ENGINE_ERROR_CODES) {
      const normalised = classifyUpstreamCode(code, status);
      expect(isVcaasErrorCode(normalised)).toBe(true);
    }
    expect(classifyUpstreamCode("INSUFFICIENT_CREDITS", ENGINE_ERROR_STATUS.INSUFFICIENT_CREDITS)).toBe(
      "INSUFFICIENT_CREDITS",
    );
    expect(classifyUpstreamCode("FILE_TOO_LARGE", 413)).toBe("UNKNOWN");
  });
});
