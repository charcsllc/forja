/**
 * Final outputs of the agents: the payloads of `submit_report`, `submit_review`,
 * `submit_triage`, `submit_design_review` and `submit_summary`.
 *
 * Protects: the only deliverable the orchestrator reads from a task
 * (docs/prompts/_base-engineer.md "How every task ends" and the role prompts). Text an
 * agent writes after its `submit_*` call is ignored.
 */
import { z } from "zod";
import { AgentRoleSchema } from "./plan";

// ─── submit_report ─────────────────────────────────────────────────────────

export const TaskReportStatusSchema = z.enum(["done", "partial", "blocked"]);
export type TaskReportStatus = z.infer<typeof TaskReportStatusSchema>;

export const AcceptanceResultSchema = z.object({
  criterion: z.string().min(1),
  met: z.boolean(),
  /** Command or file that proves it. */
  evidence: z.string(),
});
export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;

/** A decision taken inside a task (lighter than a plan ADR). */
export const ReportDecisionSchema = z.object({
  title: z.string().min(1),
  why: z.string().min(1),
});
export type ReportDecision = z.infer<typeof ReportDecisionSchema>;

export const NewDependencySchema = z.object({
  name: z.string().min(1),
  why: z.string().min(1),
});
export type NewDependency = z.infer<typeof NewDependencySchema>;

export const EnvNeedSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "Environment variable names are UPPER_SNAKE_CASE"),
  description: z.string().min(1),
  required: z.boolean(),
});
export type EnvNeed = z.infer<typeof EnvNeedSchema>;

/** Supervisor: variables with no value and no default; the user will be asked. */
export const SecretKeyNeededSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});
export type SecretKeyNeeded = z.infer<typeof SecretKeyNeededSchema>;

export const TaskReportSchema = z.object({
  status: TaskReportStatusSchema,
  summary: z.string().min(1),
  filesChanged: z.array(z.string()),
  acceptance: z.array(AcceptanceResultSchema),
  decisions: z.array(ReportDecisionSchema).default([]),
  /** Risks, deviations, anything not verified. Required content for partial/blocked. */
  concerns: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
  newDependencies: z.array(NewDependencySchema).default([]),
  envNeeds: z.array(EnvNeedSchema).default([]),
  secretKeysNeeded: z.array(SecretKeyNeededSchema).optional(),
  /** Screenshot paths (frontend: 375, 768 and 1440 per page). */
  screenshots: z.array(z.string()).optional(),
});
export type TaskReport = z.infer<typeof TaskReportSchema>;

// ─── submit_review (reviewer and security) ─────────────────────────────────────

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

/** `critical` and `high` block the run. */
export const BLOCKING_SEVERITIES: ReadonlySet<Severity> = new Set(["critical", "high"]);

export const ReviewCategorySchema = z.enum([
  "correctness",
  "architecture",
  "security",
  "performance",
  "maintainability",
  "tests",
  "spec-mismatch",
  "a11y",
]);
export type ReviewCategory = z.infer<typeof ReviewCategorySchema>;

/**
 * One finding. The reviewer sends `category` + `why`; security sends `cwe` +
 * `scenario` (+ `verified`). At least one classification and one explanation are required.
 */
export const ReviewFindingSchema = z
  .object({
    severity: SeveritySchema,
    category: ReviewCategorySchema.optional(),
    cwe: z.string().regex(/^CWE-\d+$/, "Expected CWE-<number>").optional(),
    file: z.string().min(1),
    line: z.number().int().positive().optional(),
    title: z.string().min(1),
    why: z.string().optional(),
    scenario: z.string().optional(),
    fix: z.string().min(1),
    verified: z.boolean().optional(),
  })
  .refine((f) => f.category !== undefined || f.cwe !== undefined, {
    message: "A finding needs a category or a cwe",
    path: ["category"],
  })
  .refine((f) => Boolean(f.why) || Boolean(f.scenario), {
    message: "A finding needs a why or a scenario",
    path: ["why"],
  });
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewVerdictSchema = z.enum(["approve", "request-changes"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/** A verdict `approve` with a blocking finding is invalid. */
export const ReviewSchema = z
  .object({
    findings: z.array(ReviewFindingSchema),
    summary: z.string().min(1),
    verdict: ReviewVerdictSchema,
  })
  .refine(
    (r) => r.verdict !== "approve" || !r.findings.some((f) => BLOCKING_SEVERITIES.has(f.severity)),
    { message: "verdict approve is invalid with a critical or high finding", path: ["verdict"] },
  );
export type Review = z.infer<typeof ReviewSchema>;

// ─── submit_triage (qa) ──────────────────────────────────────────────────────

export const TriageItemSchema = z.object({
  /** Gate name, e.g. `tsc`, `routes`, `e2e`. */
  gate: z.string().min(1),
  routeTo: AgentRoleSchema,
  /** The exact expectation that failed, quoted. */
  what: z.string().min(1),
  /** File:line, URL + selector, or the command. */
  where: z.string().min(1),
  /** Trimmed output, screenshot path or console text. */
  evidence: z.string().min(1),
  reproduce: z.string().min(1),
  /** A hypothesis, clearly marked as such. */
  suspectedCause: z.string().optional(),
});
export type TriageItem = z.infer<typeof TriageItemSchema>;

export const TriageSchema = z.object({
  items: z.array(TriageItemSchema),
  summary: z.string().min(1),
});
export type Triage = z.infer<typeof TriageSchema>;

// ─── submit_design_review (designer) ─────────────────────────────────────────

export const DesignSeveritySchema = z.enum(["blocking", "major", "minor"]);
export type DesignSeverity = z.infer<typeof DesignSeveritySchema>;

export const DesignFindingSchema = z.object({
  page: z.string().min(1),
  /** Viewport width in CSS px (375, 768, 1440). */
  width: z.number().int().positive(),
  severity: DesignSeveritySchema,
  what: z.string().min(1),
  where: z.string().min(1),
  fix: z.string().min(1),
});
export type DesignFinding = z.infer<typeof DesignFindingSchema>;

export const DesignReviewSchema = z.object({
  findings: z.array(DesignFindingSchema),
});
export type DesignReview = z.infer<typeof DesignReviewSchema>;

// ─── submit_summary (summarizer) ─────────────────────────────────────────────

export const SummarySchema = z.object({ text: z.string().min(1) });
export type Summary = z.infer<typeof SummarySchema>;
