/**
 * Roles and registry. Protects: every tool a role lists exists, names follow the
 * snake_case rule, and `ROLE_REQUIREMENTS` covers exactly the phase-2 roles (contract C2).
 */
import { AGENT_ROLES } from "@forja/contracts";
import { describe, expect, it } from "vitest";
import { PHASE2_ROLES, PLANNABLE_ROLES, ROLE_DEFINITIONS, ROLE_REQUIREMENTS } from "../src/roles/index.js";
import { TOOL_NAME_RE, TOOL_REGISTRY, toolsByName } from "../src/tools/registry.js";
import { parseAgentSettings } from "../src/settings.js";

describe("roles", () => {
  it("list only registered tools, and submit tools of kind submit", () => {
    for (const role of PHASE2_ROLES) {
      const def = ROLE_DEFINITIONS[role];
      expect(() => toolsByName(def.tools)).not.toThrow();
      for (const t of toolsByName(def.submitTools)) expect(t.kind).toBe("submit");
      for (const t of toolsByName(def.tools)) expect(t.kind).not.toBe("submit");
    }
  });

  it("export requirements for exactly the phase-2 roles", () => {
    expect(Object.keys(ROLE_REQUIREMENTS).sort()).toEqual([...PHASE2_ROLES].sort());
    for (const r of Object.values(ROLE_REQUIREMENTS)) expect(r?.capabilities).toContain("nativeTools");
    expect(ROLE_REQUIREMENTS.director?.preferredTier).toBe("frontier");
    expect(ROLE_REQUIREMENTS.fixer?.preferredTier).toBe("fast");
    for (const r of PLANNABLE_ROLES) expect(PHASE2_ROLES).toContain(r);
    for (const r of PHASE2_ROLES) expect(AGENT_ROLES).toContain(r);
  });

  it("read-only roles have no write tools", () => {
    for (const role of ["director", "summarizer"] as const) {
      expect(toolsByName(ROLE_DEFINITIONS[role].tools).some((t) => t.kind === "write")).toBe(false);
    }
  });
});

describe("registry", () => {
  it("names are unique snake_case", () => {
    for (const name of TOOL_REGISTRY.keys()) expect(name).toMatch(TOOL_NAME_RE);
  });
  it("unknown tool names throw", () => {
    expect(() => toolsByName(["apply_patch"])).toThrow(/unknown tool/);
  });
});

describe("parseAgentSettings", () => {
  it("uses the documented defaults and reports bad values", () => {
    const s = parseAgentSettings({});
    expect(s).toMatchObject({ maxParallelTasks: 1, maxTurnsPerTask: 60, taskLocalRetries: 2, fixerPasses: 3, maxFixRounds: 4, maxReviewRounds: 2, contextSoftLimit: 0.6 });
    const bad = parseAgentSettings({ AGENT_MAX_TURNS_PER_TASK: "lots", AGENT_MAX_PARALLEL_TASKS: "4", AGENT_CONTEXT_SOFT_LIMIT: "0.5" });
    expect(bad.maxTurnsPerTask).toBe(60);
    expect(bad.maxParallelTasks).toBe(1);
    expect(bad.contextSoftLimit).toBe(0.5);
    expect(bad.problems.join("\n")).toMatch(/AGENT_MAX_PARALLEL_TASKS[\s\S]*AGENT_MAX_TURNS_PER_TASK/);
  });
});
