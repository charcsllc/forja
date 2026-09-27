import { describe, expect, it } from "vitest";
import {
  DesignReviewSchema,
  ReviewSchema,
  SummarySchema,
  TaskReportSchema,
  TriageSchema,
} from "../src/reports";
import { RUN_EVENT_TYPES, RunEventSchema, type RunEvent } from "../src/events";

const report = {
  status: "done",
  summary: "Built the product page with loading and empty states.",
  filesChanged: ["src/app/(shop)/products/[slug]/page.tsx"],
  acceptance: [{ criterion: "Page renders at 375", met: true, evidence: "browser_screenshot 375" }],
  decisions: [{ title: "Static params", why: "Catalogue is small" }],
  concerns: [],
  followUps: [],
  newDependencies: [],
  envNeeds: [{ name: "STRIPE_SECRET_KEY", description: "Payments", required: false }],
  secretKeysNeeded: [{ name: "STRIPE_SECRET_KEY", description: "Stripe secret key" }],
  screenshots: ["shots/product-375.png"],
};

describe("reports", () => {
  it("round-trips a task report and fills defaults", () => {
    expect(TaskReportSchema.parse(report)).toEqual(report);
    const minimal = TaskReportSchema.parse({ status: "blocked", summary: "Need a key", filesChanged: [], acceptance: [] });
    expect(minimal.concerns).toEqual([]);
    expect(TaskReportSchema.safeParse({ ...report, envNeeds: [{ name: "lower", description: "x", required: true }] }).success).toBe(false);
  });

  it("accepts reviewer and security findings and enforces the verdict rule", () => {
    const review = {
      findings: [
        {
          severity: "medium",
          category: "maintainability",
          file: "src/modules/cart/application/add.ts",
          line: 12,
          title: "Duplicated price rounding",
          why: "Two rounding rules will drift",
          fix: "Use money.round()",
        },
        {
          severity: "low",
          cwe: "CWE-639",
          file: "src/app/api/orders/[id]/route.ts",
          line: 18,
          title: "IDOR",
          scenario: "User A reads B's order",
          fix: "Filter by owner",
          verified: false,
        },
      ],
      summary: "Solid.",
      verdict: "approve",
    };
    expect(ReviewSchema.parse(review)).toEqual(review);
    const blocking = { ...review, findings: [{ ...review.findings[0], severity: "high" }] };
    expect(ReviewSchema.safeParse(blocking).success).toBe(false);
    expect(ReviewSchema.safeParse({ ...blocking, verdict: "request-changes" }).success).toBe(true);
    const unclassified = { ...review, findings: [{ severity: "info", file: "a", title: "t", why: "w", fix: "f" }] };
    expect(ReviewSchema.safeParse(unclassified).success).toBe(false);
  });

  it("round-trips triage, design review and summary", () => {
    const triage = {
      items: [
        {
          gate: "routes",
          routeTo: "frontend",
          what: "expected one h1",
          where: "/pricing",
          evidence: "found 2 h1",
          reproduce: "open /pricing",
          suspectedCause: "Hypothesis: hero and header both use h1",
        },
      ],
      summary: "One page gate failure.",
    };
    expect(TriageSchema.parse(triage)).toEqual(triage);
    expect(TriageSchema.safeParse({ ...triage, items: [{ ...triage.items[0], routeTo: "intern" }] }).success).toBe(false);
    const design = {
      findings: [
        { page: "/", width: 375, severity: "blocking", what: "Title wraps to 4 lines", where: "hero h1", fix: "text-3xl text-balance" },
      ],
    };
    expect(DesignReviewSchema.parse(design)).toEqual(design);
    expect(SummarySchema.parse({ text: "## Context summary" })).toEqual({ text: "## Context summary" });
  });
});

describe("run events", () => {
  const base = { seq: 1, runId: "run_1", ts: "2026-09-25T10:00:00.000Z" };

  it("covers the whole catalogue", () => {
    // docs/architecture/05-data-model-and-api.md §4, in order.
    const catalogue = `run.received run.phase run.finished plan.created plan.rejected plan.approved
      task.started task.turn task.finished task.failed task.retried task.checkpoint text tool.call
      tool.result file.diff command.output scope.violation integration.report rework.requested
      gate.started gate.passed gate.failed review.finding review.summary screenshot design.review
      cost.tick budget.warning budget.exhausted context.compacted context.rebuilt sandbox.status
      deploy.status domain.status message system.pressure`.split(/\s+/);
    expect([...RUN_EVENT_TYPES]).toEqual(catalogue);
  });

  it("round-trips representative events", () => {
    const events: RunEvent[] = [
      { ...base, type: "run.phase", payload: { from: "directing", to: "designing" } },
      { ...base, type: "tool.call", taskId: "t1", payload: { taskId: "t1", name: "write_file", argsSummary: "src/a.ts (812 B)" } },
      { ...base, type: "file.diff", payload: { taskId: "t1", path: "src/a.ts", stat: { additions: 10, deletions: 2 }, blob: "blobs/run_1/3.patch" } },
      {
        ...base,
        type: "gate.failed",
        payload: { name: "tsc", parsed: [{ file: "src/a.ts", line: 3, code: "TS2322", message: "Type error" }], routedTo: "fixer" },
      },
      { ...base, type: "task.finished", payload: { taskId: "t1", report: { kind: "report", data: TaskReportSchema.parse(report) }, cost: { usd: 0.42 } } },
      { ...base, type: "message", payload: { author: "agent", type: "building", text: "Creando la página de producto" } },
      { ...base, type: "plan.approved", payload: {} },
      { ...base, type: "run.finished", payload: { status: "done", summary: "ok", cost: { usd: 1.2, inputTokens: 1000 } } },
    ];
    for (const e of events) expect(RunEventSchema.parse(e)).toEqual(e);
  });

  it("rejects mismatched payloads and unknown types", () => {
    expect(RunEventSchema.safeParse({ ...base, type: "run.phase", payload: { from: "x", to: "done" } }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...base, type: "text.delta", payload: {} }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...base, type: "run.finished", payload: { status: "verifying", summary: "", cost: { usd: 0 } } }).success).toBe(false);
  });
});
