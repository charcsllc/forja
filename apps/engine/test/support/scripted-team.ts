/**
 * A scripted Forja team for engine tests: answers each agent session by role and by the
 * tools it was offered, like a well-behaved model would. No network, no key.
 *
 * Protects: the orchestrator and the v1 contract are tested end to end (director intake →
 * plan → task with real file writes → gates → merge → closing message) with the same
 * provider interface the gateway implements.
 */
import { scriptedProvider, textTurn, toolCallTurn, type GenerateEvent, type GenerateRequest, type ScriptedProvider } from "@forja/llm";

export const ABOUT_PAGE = 'export default function AboutPage() {\n  return <main><h1>About us</h1></main>;\n}\n';

export function tweakPlan(overrides: Record<string, unknown> = {}) {
  return {
    intent: "tweak",
    summary: "Add an About page",
    spec: {
      goal: "An about page",
      users: ["visitors"],
      pages: [{ route: "/about", purpose: "Tell who we are", sections: ["hero"] }],
      features: [],
      dataModel: [],
      integrations: [],
      nonFunctional: { seo: true, auth: "none", i18n: ["en"], a11y: "AA" },
    },
    decisions: [],
    tasks: [
      {
        id: "about-page",
        role: "frontend",
        title: "About page",
        description: "Create src/app/about/page.tsx with an h1 'About us'.",
        dependsOn: [],
        scope: { write: ["src/app/about/**"] },
        acceptance: ["GET /about renders an h1"],
        weight: 1,
      },
    ],
    budgetWeights: { "about-page": 1 },
    verification: { pages: ["/about"], flows: [] },
    ...overrides,
  };
}

export interface TeamScript {
  intent?: "tweak" | "question" | "feature";
  plan?: unknown;
  /** Per-role hooks: return events to override the default behaviour of that turn. */
  roles?: Partial<Record<string, (req: GenerateRequest, i: number) => GenerateEvent[] | undefined>>;
  answer?: string;
  closing?: string;
  /** Usage cost per turn (USD). */
  costPerTurn?: number;
}

const usage = (cost: number): GenerateEvent => ({ type: "usage", input: 100, output: 50, cachedInput: 0, cacheWrite: 0, costUsd: cost });
const route: GenerateEvent = { type: "route", provider: "scripted", model: "team-1", attempt: 1 };

function call(id: string, name: string, args: unknown, cost: number): GenerateEvent[] {
  return [route, { type: "tool-call", id, name, args }, usage(cost), { type: "finish", reason: "tool-calls" }];
}

export function scriptedTeam(script: TeamScript = {}): ScriptedProvider {
  const cost = script.costPerTurn ?? 0;
  return scriptedProvider((req, i) => {
    const tools = new Set(req.tools.map((t) => t.name));
    const last = req.messages.at(-1);
    const hooked = script.roles?.[req.role]?.(req, i);
    if (hooked) return hooked;
    if (req.role === "director") {
      if (tools.has("submit_intent")) return call(`c${i}`, "submit_intent", { intent: script.intent ?? "tweak", confidence: 0.9, reason: "A small page" }, cost);
      if (tools.has("submit_plan")) return call(`c${i}`, "submit_plan", script.plan ?? tweakPlan(), cost);
      if (tools.has("submit_message") && tools.size === 1) return call(`c${i}`, "submit_message", { text: script.closing ?? "Listo: añadí la página **Sobre nosotros**." }, cost);
      if (tools.has("submit_message")) return call(`c${i}`, "submit_message", { text: script.answer ?? "Usa Postgres 17." }, cost);
    }
    if (req.role === "frontend" || req.role === "fixer" || req.role === "backend" || req.role === "database") {
      if (last?.role === "tool" && last.name === "write_file") {
        return call(`c${i}`, "submit_report", { status: "done", summary: "Added the about page.", filesChanged: ["src/app/about/page.tsx"], acceptance: [{ criterion: "GET /about renders an h1", met: true, evidence: "npm run typecheck" }] }, cost);
      }
      return call(`c${i}`, "write_file", { path: "src/app/about/page.tsx", content: ABOUT_PAGE }, cost);
    }
    if (req.role === "summarizer") return call(`c${i}`, "submit_summary", { text: "## Context summary\nwrote the page" }, cost);
    return [route, ...textTurn("I do not know this role.")];
  });
}

export { call as scriptedCall, toolCallTurn };
