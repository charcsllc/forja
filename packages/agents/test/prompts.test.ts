/**
 * Prompt assembly and the prompt bundle. Protects: the documented order
 * (base → role → provider → family), the bundle being in sync with docs/prompts, and the
 * context headers carrying scope, limits and the submit schema.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assembleSystemPrompt, modelFamily, promptNotes } from "../src/prompts/assemble.js";
import { PROMPT_BUNDLE } from "../src/prompts/bundle.generated.js";
import { PHASE2_ROLES } from "../src/roles/index.js";
import { DIRECTOR_AFTER_INTENT, renderDirectorIntake, renderFixContext, renderTaskContext } from "../src/context/task-context.js";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const headings = (s: string) => s.split("\n").filter((l) => /^# /.test(l));

describe("prompt bundle", () => {
  it("is in sync with docs/prompts (run `npm run prompts:bundle -w @forja/agents` when this fails)", () => {
    expect(() => execFileSync("node", ["scripts/bundle-prompts.mjs", "--check"], { cwd: pkg, stdio: "pipe" })).not.toThrow();
  });

  it("contains every phase-2 role and the Next.js 16 sheet", () => {
    for (const role of PHASE2_ROLES) expect(PROMPT_BUNDLE.roles[role]).toMatch(/^# Role:/);
    expect(PROMPT_BUNDLE.context.next16).toContain("src/proxy.ts");
  });
});

describe("assembleSystemPrompt", () => {
  it.each(PHASE2_ROLES)("%s on nvidia/GLM: base → role → nvidia (if present) → zai", (role) => {
    const { system, parts } = assembleSystemPrompt({ role, model: "nvidia:z-ai/glm-5.3" });
    const expected = ["_base-engineer.md", `roles/${role}.md`, ...(PROMPT_BUNDLE.providers.nvidia ? ["providers/nvidia.md"] : []), "providers/zai.md"];
    expect(parts).toEqual(expected);
    expect(headings(system)[0]).toBe("# Base persona (prepended to every role prompt)");
    expect(headings(system)[1]).toMatch(/^# Role: /);
    expect({ role, parts, headings: headings(system) }).toMatchSnapshot();
  });

  it("direct providers get only their own note; no model = no notes", () => {
    expect(assembleSystemPrompt({ role: "frontend", model: "zai:glm-5.3" }).parts).toEqual(["_base-engineer.md", "roles/frontend.md", "providers/zai.md"]);
    expect(assembleSystemPrompt({ role: "fixer", model: "anthropic:claude-opus-5-5" }).parts).toEqual(["_base-engineer.md", "roles/fixer.md", "providers/anthropic.md"]);
    expect(assembleSystemPrompt({ role: "fixer" }).parts).toEqual(["_base-engineer.md", "roles/fixer.md"]);
    expect(() => assembleSystemPrompt({ role: "nope" as "fixer" })).toThrow(/no prompt/);
  });

  it("maps model ids to families", () => {
    expect(modelFamily("z-ai/glm-5.3")).toBe("zai");
    expect(modelFamily("qwen/qwen3-coder-480b")).toBe("qwen");
    expect(modelFamily("moonshotai/kimi-k3")).toBe("moonshot");
    expect(modelFamily("meta/llama-4")).toBeNull();
    expect(promptNotes("ollama", "qwen3-coder:30b")).toEqual(["ollama", "qwen"]);
    expect(promptNotes("nvidia", "z-ai/glm-5.3")).toEqual(["nvidia", "zai"]);
  });
});

describe("context headers", () => {
  const plan = {
    intent: "tweak" as const,
    summary: "About page",
    spec: { goal: "g", users: [], pages: [{ route: "/about", purpose: "p", sections: [], contentSlots: [], states: {}, data: [] }], features: [], dataModel: [], integrations: [], nonFunctional: { seo: true, auth: "none" as const, i18n: ["en"], a11y: "AA" as const } },
    decisions: [],
    tasks: [{ id: "fe", role: "frontend" as const, title: "About page", description: "Create /about", dependsOn: [], scope: { write: ["src/app/about/**"] }, acceptance: ["renders an h1"], weight: 1 }],
    budgetWeights: { fe: 1 },
    verification: { pages: ["/about"], flows: [] },
  };

  it("task context: task, scope, limits, Next 16 sheet and the submit schema", () => {
    const text = renderTaskContext({ task: plan.tasks[0]!, plan, dependencyReports: [], projectAgentsMd: "# AGENTS", fileTree: "src/app/page.tsx", limits: { maxTurns: 60, budgetUsd: 2.5 } });
    expect(text).toContain("## Your task: About page");
    expect(text).toContain("- `src/app/about/**`");
    expect(text).toContain("At most 60 turns");
    expect(text).toContain("2.50 USD");
    expect(text).toContain("# Next.js 16 reference sheet");
    expect(text).toMatch(/call `submit_report` with this schema: \{"type":"object"/);
  });

  it("director intake never plans unavailable roles and asks for submit_intent first", () => {
    const text = renderDirectorIntake({ prompt: "Add an about page", inputFiles: [], language: "es", isFirstPrompt: false, projectAgentsMd: null, fileTree: "", recentConversation: [], limits: { maxTurns: 30, budgetUsd: null }, budgetUsd: null });
    expect(text).toContain("- `frontend`");
    expect(text).toContain("Only these roles may own plan tasks");
    expect(text).toContain("Call `submit_intent` first");
    expect(DIRECTOR_AFTER_INTENT("question")).toContain("submit_message");
    expect(DIRECTOR_AFTER_INTENT("feature")).toContain("submit_plan");
  });

  it("fix context names the gate, the errors and the scope", () => {
    const text = renderFixContext({ gate: "typecheck", command: "npm run typecheck", errors: [{ file: "src/a.ts", line: 3, message: "TS2304: Cannot find name 'x'" }], output: "…", scope: ["src/a.ts"], limits: { maxTurns: 20, budgetUsd: 1 } });
    expect(text).toContain("`typecheck`");
    expect(text).toContain("src/a.ts:3: TS2304");
  });
});
