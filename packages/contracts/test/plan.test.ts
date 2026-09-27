import { describe, expect, it } from "vitest";
import {
  type RunPlan,
  type Task,
  IntentClassificationSchema,
  RunPlanSchema,
  globToRegExp,
  globsOverlap,
  scopeCoversPath,
  toAgentProcessStatus,
  validatePlan,
} from "../src/plan";

function task(id: string, write: string[], extra: Partial<Task> = {}): Task {
  return {
    id,
    role: "frontend",
    title: `Task ${id}`,
    description: `Do ${id}`,
    dependsOn: [],
    scope: { write },
    acceptance: [`${id} works`],
    weight: 1,
    ...extra,
  };
}

function plan(tasks: Task[], budgetWeights: Record<string, number> = {}): RunPlan {
  return {
    intent: "full",
    summary: "A shop for handmade candles",
    spec: {
      goal: "Sell candles online",
      users: ["shoppers", "owner"],
      pages: [{ route: "/", purpose: "Home", sections: ["hero"], contentSlots: [], states: {}, data: [] }],
      features: [{ name: "Catalogue", userStories: ["As a shopper I browse candles"], businessRules: [] }],
      dataModel: [
        {
          name: "candle",
          fields: [{ name: "name", type: "text", required: true }],
          relations: [],
          invariants: [],
        },
      ],
      integrations: [],
      nonFunctional: { seo: true, auth: "email", i18n: ["es"], a11y: "AA" },
    },
    decisions: [
      {
        title: "Server components for the catalogue",
        context: "SEO matters",
        options: ["SSR", "CSR"],
        decision: "SSR",
        consequences: "No client fetching",
      },
    ],
    tasks,
    budgetWeights,
    verification: { pages: ["/"], flows: [{ name: "browse", steps: ["open /"], expected: "candles listed" }] },
  };
}

const goodTasks = [
  task("design", ["docs/design/**", "src/app/globals.css", "src/components/ui/**"], { role: "designer" }),
  task("db", ["src/db/**", "drizzle/**"], { role: "database" }),
  task("catalogue-api", ["src/modules/catalogue/**", "src/app/api/candles/**"], {
    role: "backend",
    dependsOn: ["db"],
  }),
  task("home", ["src/app/(shop)/page.tsx", "src/components/layout/**"], {
    dependsOn: ["design", "catalogue-api"],
  }),
  task("cart", ["src/modules/cart/**", "src/app/(shop)/cart/**"], { dependsOn: ["design", "db"] }),
];

describe("schemas", () => {
  it("parses a realistic plan", () => {
    const p = plan(goodTasks, { design: 2, db: 1 });
    expect(RunPlanSchema.parse(p)).toEqual(p);
  });

  it("bounds intent confidence", () => {
    expect(IntentClassificationSchema.safeParse({ intent: "tweak", confidence: 0.9, reason: "colour" }).success).toBe(
      true,
    );
    expect(IntentClassificationSchema.safeParse({ intent: "tweak", confidence: 1.2, reason: "x" }).success).toBe(false);
  });

  it("projects run statuses onto API v1", () => {
    expect(toAgentProcessStatus(null)).toBe("idle");
    expect(toAgentProcessStatus("verifying")).toBe("init");
    expect(toAgentProcessStatus("cancelling")).toBe("init");
    expect(toAgentProcessStatus("limit-reached")).toBe("done");
  });
});

describe("glob heuristic", () => {
  it("matches literal paths exactly", () => {
    expect(globToRegExp("src/app/**").test("src/app/layout.tsx")).toBe(true);
    expect(globToRegExp("src/**/page.tsx").test("src/page.tsx")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/modules/x/{domain,ui}/**").test("src/modules/x/ui/a.tsx")).toBe(true);
  });

  it("compares globs by static prefix", () => {
    expect(globsOverlap("src/app/**", "src/app/(shop)/cart/**")).toBe(true);
    expect(globsOverlap("src/modules/cart/**", "src/modules/catalogue/**")).toBe(false);
    expect(globsOverlap("src/app/**", "src/application/**")).toBe(false);
    expect(globsOverlap("src/mod*", "src/modules/cart/**")).toBe(true);
    // Over-approximation: same directory prefix, different extensions still "overlap".
    expect(globsOverlap("src/app/*.tsx", "src/app/x/**")).toBe(true);
  });

  it("honours exclusions for literal paths", () => {
    expect(scopeCoversPath(["src/app/**", "!src/app/globals.css"], "src/app/globals.css")).toBe(false);
    expect(scopeCoversPath(["src/app/**", "!src/app/globals.css"], "src/app/layout.tsx")).toBe(true);
  });
});

describe("validatePlan", () => {
  it("accepts a valid plan", () => {
    expect(validatePlan(plan(goodTasks, { design: 2, home: 1 }))).toEqual({ ok: true });
  });

  it("reports schema errors without running the rules", () => {
    const result = validatePlan({ intent: "full" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.every((e) => e.startsWith("schema:"))).toBe(true);
  });

  it("rejects overlapping scopes of unrelated tasks", () => {
    const result = validatePlan(
      plan([task("a", ["src/modules/cart/**"]), task("b", ["src/modules/cart/ui/**"])]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/"a" and "b" have no dependency/);
  });

  it("allows overlap along a transitive dependency path", () => {
    const result = validatePlan(
      plan([
        task("a", ["src/modules/cart/**"]),
        task("mid", ["docs/x.md"], { dependsOn: ["a"] }),
        task("b", ["src/modules/cart/ui/**"], { dependsOn: ["mid"] }),
      ]),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a hot file with two owners even when they are ordered", () => {
    const result = validatePlan(
      plan([
        task("design", ["src/app/globals.css"], { role: "designer" }),
        task("page", ["src/app/**"], { dependsOn: ["design"] }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain('hot file "src/app/globals.css" is writable by 2 tasks: design, page');
  });

  it("accepts the hot file once the frontend scope excludes it", () => {
    const result = validatePlan(
      plan([
        task("design", ["src/app/globals.css"], { role: "designer" }),
        task("page", ["src/app/**", "!src/app/globals.css", "!src/app/layout.tsx"], { dependsOn: ["design"] }),
      ]),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a cycle and names it", () => {
    const result = validatePlan(
      plan([
        task("a", ["a/**"], { dependsOn: ["c"] }),
        task("b", ["b/**"], { dependsOn: ["a"] }),
        task("c", ["c/**"], { dependsOn: ["b"] }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith("dependsOn forms a cycle: a → c → b → a"))).toBe(true);
  });

  it("rejects unknown dependencies, self-dependencies, empty acceptance and bad weights", () => {
    const result = validatePlan(
      plan(
        [
          task("a", ["a/**"], { dependsOn: ["ghost", "a"], acceptance: ["  "], weight: 0 }),
          task("a", ["dup/**"]),
        ],
        { a: -1, ghost: 1 },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          'task "a": duplicate task id',
          'task "a": needs at least one acceptance criterion',
          'task "a": weight must be > 0 (got 0)',
          'task "a": depends on itself',
          'task "a": dependsOn references unknown task "ghost"',
          'budgetWeights: "a" must be > 0 (got -1)',
          'budgetWeights: "ghost" is not a task of this plan',
        ]),
      );
    }
  });

  it("accepts dependencies on tasks outside a partial re-plan", () => {
    const p = plan([task("fix", ["src/modules/cart/**"], { dependsOn: ["db"] })]);
    expect(validatePlan(p).ok).toBe(false);
    expect(validatePlan(p, { knownTaskIds: ["db"] })).toEqual({ ok: true });
  });
});
