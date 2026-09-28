/**
 * Role assignment and AGENT_* parsing. Protects: NVIDIA alone covers the implementing
 * roles with GLM-5.3 and the fast roles with GLM-5.3-flash; unsatisfiable roles say
 * exactly what is missing; env overrides and their warnings; pending adapters are skipped.
 */
import { describe, expect, it } from "vitest";
import { createLlmGateway, type GatewayLogger } from "../src/gateway/index.js";
import { REQUIREMENTS } from "./helpers.js";
import { parseModelRef, parseRoleConfig } from "../src/gateway/role-config.js";
import { LlmConfigError } from "../src/errors.js";

const NVIDIA_ONLY = { LLM_NVIDIA: "true|nvapi-test-key" };

function recordingLogger() {
  const warns: string[] = [];
  const logger: GatewayLogger = { info() {}, warn: (_o, m) => void warns.push(m ?? ""), error() {} };
  return { logger, warns };
}

function byRole(env: Record<string, string>, requirements = REQUIREMENTS) {
  const gw = createLlmGateway({ env, requirements });
  return { gw, map: Object.fromEntries(gw.assignments().map((a) => [a.role, a])) };
}

describe("auto-assignment with only NVIDIA enabled", () => {
  it("gives GLM-5.3 to director/frontend/backend/database and GLM-5.3-flash to fixer/summarizer", () => {
    const { map } = byRole(NVIDIA_ONLY);
    for (const role of ["director", "frontend", "backend", "database"]) {
      expect(map[role], role).toMatchObject({ model: "nvidia:z-ai/glm-5.3", source: "auto" });
    }
    for (const role of ["fixer", "summarizer"]) expect(map[role], role).toMatchObject({ model: "nvidia:z-ai/glm-5.3-flash", source: "auto" });
    expect(map.director!.fallbacks).toEqual(["nvidia:z-ai/glm-5.3-flash"]);
    expect(map.summarizer!.fallbacks).toEqual(["nvidia:deepseek-ai/deepseek-v4.1-flash", "nvidia:openai/gpt-oss-20b"]);
  });

  it("explains a role no single model satisfies", () => {
    const { gw, map } = byRole(NVIDIA_ONLY);
    expect(map.designer).toMatchObject({ model: null, source: "auto" });
    expect(map.designer!.error).toBe(
      "role `designer` needs `nativeTools` + `vision` + ≥ 64000 context tokens in one model; enabled providers: nvidia (z-ai/glm-5.3, z-ai/glm-5.3-flash, moonshotai/kimi-k3, …)",
    );
    expect(() => gw.assertRolesSatisfiable(["director", "frontend"])).not.toThrow();
    expect(() => gw.assertRolesSatisfiable(["director", "designer"])).toThrow(LlmConfigError);
    expect(() => gw.assertRolesSatisfiable(["designer"])).toThrow(/role `designer` needs/);
  });

  it("keeps the reviewer on the same family with a warning when no other family qualifies", () => {
    const { gw, map } = byRole(NVIDIA_ONLY);
    expect(map.reviewer!.model).toBe("nvidia:z-ai/glm-5.3");
    expect(gw.warnings().join("\n")).toMatch(/role `reviewer` should use a model family other than glm/);
  });

  it("roles without declared requirements still get a model", () => {
    const { map } = byRole(NVIDIA_ONLY);
    expect(map.docs!.model).not.toBeNull();
    expect(Object.keys(map)).toHaveLength(15);
  });
});

describe("unsatisfiable configurations", () => {
  it("names the missing capability (groq only, no vision)", () => {
    const { map } = byRole({ LLM_GROQ: "true|gsk-test" }, { designer: { capabilities: ["vision"], minContextTokens: 32_000, preferredTier: "strong" } });
    expect(map.designer!.error).toBe("role `designer` needs `vision`; enabled providers: groq (openai/gpt-oss-20b)");
  });

  it("names context and price ceilings", () => {
    const { map } = byRole(NVIDIA_ONLY, { director: { capabilities: [], minContextTokens: 1_000_000, preferredTier: "frontier" } });
    expect(map.director!.error).toMatch(/needs ≥ 1000000 context tokens; enabled providers: nvidia/);
    const zai = byRole({ LLM_ZAI: "true|k" }, { director: { capabilities: [], minContextTokens: 0, preferredTier: "frontier", maxPricePer1MOutput: 0.1 } });
    expect(zai.map.director!.error).toMatch(/needs output price ≤ \$0.1\/1M/);
  });

  it("with nothing callable says so", () => {
    const { logger, warns } = recordingLogger();
    const gw = createLlmGateway({ env: { LLM_ANTHROPIC: "true|sk-ant-test" }, requirements: REQUIREMENTS, logger });
    expect(gw.assignments().find((a) => a.role === "director")!.error).toBe(
      "role `director` has no model: no enabled LLM provider can be called; enabled providers: anthropic (skipped)",
    );
    expect(warns).toEqual(["provider `anthropic` is enabled but its adapter arrives later; it is skipped"]);
  });
});

describe("pending adapters", () => {
  it("skips them with exactly one warning and routes to the ready provider", () => {
    const { logger, warns } = recordingLogger();
    const gw = createLlmGateway({ env: { ...NVIDIA_ONLY, LLM_ANTHROPIC: "true|sk-ant-test", LLM_OPENAI: "true|sk-test" }, requirements: REQUIREMENTS, logger });
    expect(warns.filter((w) => /adapter arrives later/.test(w)).sort()).toEqual([
      "provider `anthropic` is enabled but its adapter arrives later; it is skipped",
      "provider `openai` is enabled but its adapter arrives later; it is skipped",
    ]);
    expect(gw.assignments().find((a) => a.role === "director")!.model).toBe("nvidia:z-ai/glm-5.3");
    const summaries = gw.providerSummaries();
    expect(summaries.find((p) => p.id === "anthropic")).toMatchObject({ status: "enabled", adapterReady: false });
    expect(summaries.find((p) => p.id === "nvidia")).toMatchObject({ status: "enabled", adapterReady: true, envName: "LLM_NVIDIA" });
    expect(summaries.find((p) => p.id === "nvidia")!.models).toHaveLength(8);
    expect(JSON.stringify(summaries)).not.toContain("test");
    expect(JSON.stringify(gw.report)).not.toContain("nvapi-test-key");
  });
});

describe("AGENT_<ROLE>_* overrides", () => {
  it("uses the env model and valid fallbacks, warning about the unusable ones", () => {
    const { gw, map } = byRole({
      ...NVIDIA_ONLY,
      AGENT_FRONTEND_MODEL: "nvidia:moonshotai/kimi-k3",
      AGENT_FRONTEND_FALLBACKS: "anthropic:claude-opus-5-5, nvidia:z-ai/glm-5.3",
    });
    expect(map.frontend).toEqual({ role: "frontend", model: "nvidia:moonshotai/kimi-k3", fallbacks: ["nvidia:z-ai/glm-5.3"], source: "env" });
    const w = gw.warnings().join("\n");
    expect(w).toMatch(/AGENT_FRONTEND_FALLBACKS: anthropic:claude-opus-5-5 skipped: provider `anthropic` is not enabled/);
    expect(w).toMatch(/AGENT_FRONTEND: nvidia:moonshotai\/kimi-k3 does not meet the role's requirements/);
  });

  it("falls to the first valid fallback when the primary is unusable", () => {
    const { map } = byRole({ ...NVIDIA_ONLY, AGENT_DIRECTOR_MODEL: "nvidia:no-such-model", AGENT_DIRECTOR_FALLBACKS: "nvidia:z-ai/glm-5.3-flash" });
    expect(map.director).toMatchObject({ model: "nvidia:z-ai/glm-5.3-flash", source: "env", fallbacks: [] });
  });

  it("auto-assigns when nothing configured is usable", () => {
    const { gw, map } = byRole({ ...NVIDIA_ONLY, AGENT_DIRECTOR_MODEL: "anthropic:claude-fable-5-1" });
    expect(map.director).toMatchObject({ model: "nvidia:z-ai/glm-5.3", source: "auto" });
    expect(gw.warnings().join("\n")).toMatch(/AGENT_DIRECTOR_MODEL: nothing configured is usable; role auto-assigned/);
  });

  it("parses effort, output tokens and tool protocol, with defaults", () => {
    const gw = createLlmGateway({
      env: { ...NVIDIA_ONLY, AGENT_DIRECTOR_EFFORT: "high", AGENT_FIXER_MAX_OUTPUT_TOKENS: "4000", AGENT_FIXER_TOOL_PROTOCOL: "xml" },
      requirements: REQUIREMENTS,
    });
    expect(gw.roleSettings("director")).toEqual({ role: "director", effort: "high", maxOutputTokens: 16_000, toolProtocol: "auto" });
    expect(gw.roleSettings("frontend")).toEqual({ role: "frontend", maxOutputTokens: 32_000, toolProtocol: "auto" });
    expect(gw.roleSettings("fixer")).toEqual({ role: "fixer", maxOutputTokens: 4_000, toolProtocol: "xml" });
  });

  it("rejects malformed values naming every variable", () => {
    expect(() => parseRoleConfig({ AGENT_DIRECTOR_EFFORT: "extreme", AGENT_QA_MODEL: "no-colon", AGENT_QA_MAX_OUTPUT_TOKENS: "-1" })).toThrow(
      /AGENT_DIRECTOR_EFFORT[\s\S]*AGENT_QA_MODEL: "no-colon" is not "provider:model"[\s\S]*AGENT_QA_MAX_OUTPUT_TOKENS/,
    );
    expect(() => createLlmGateway({ env: { AGENT_FRONTEND_TOOL_PROTOCOL: "json" }, requirements: {} })).toThrow(LlmConfigError);
  });

  it("reports AGENT_<X>_MODEL for unknown roles and ignores other AGENT_* settings", () => {
    const r = parseRoleConfig({ AGENT_DESIGNR_MODEL: "nvidia:z-ai/glm-5.3", AGENT_MAX_TURNS_PER_TASK: "60", AGENT_CONTEXT_SOFT_LIMIT: "0.6" });
    expect(r.unknownVariables).toEqual(["AGENT_DESIGNR_MODEL"]);
  });

  it("splits model refs on the first colon", () => {
    expect(parseModelRef("ollama:qwen3:32b")).toEqual({ provider: "ollama", model: "qwen3:32b" });
    expect(parseModelRef("NVIDIA:z-ai/glm-5.3")).toEqual({ provider: "nvidia", model: "z-ai/glm-5.3" });
    expect(parseModelRef(":x")).toBeUndefined();
    expect(parseModelRef("x:")).toBeUndefined();
  });
});
