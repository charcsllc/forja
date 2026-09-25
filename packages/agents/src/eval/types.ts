/**
 * Eval case and result shapes for `agents:eval` (docs/prompts/README.md).
 *
 * What this file protects: every check is automatic and deterministic. A case states
 * its input (task + seed files) and machine-checkable expectations; nothing here asks a
 * model to grade another model. `golden` is the reference answer: it documents intent
 * and feeds `fakeExecutor`, which tests the runner itself.
 *
 * TODO(phase-0): switch AgentRole / AgentReport to @forja/contracts (reports).
 */

export const AGENT_ROLES = [
  "director", "designer", "brand", "imagery", "copywriter", "database", "backend", "frontend",
  "supervisor", "qa", "reviewer", "security", "docs", "fixer", "summarizer",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** What a role hands back through its `submit_*` tool, reduced to what evals check. */
export interface AgentReport {
  status: "done" | "partial" | "failed";
  summary?: string;
  /** Role-specific structured output (intent, review findings, summary…). */
  output?: unknown;
}

export interface CheckResult {
  ok: boolean;
  notes: string;
}

export interface EvalCase {
  role: AgentRole;
  id: string;
  title: string;
  input: {
    /** The task as the orchestrator would hand it to the role. */
    task: string;
    /** Seed repository: path → UTF-8 content. */
    files: Record<string, string>;
  };
  expect: {
    /** Each path must be created or modified. */
    filesChanged?: string[];
    /** When true, any change outside `filesChanged` fails (roles with no or narrow write scope). */
    strictScope?: boolean;
    filesContain?: { path: string; includes: string[] }[];
    filesExclude?: { path: string; excludes: string[] }[];
    reportStatus?: "done" | "partial";
    customCheck?: (workdir: string, report: AgentReport) => Promise<CheckResult>;
  };
  /** Reference solution: files written on top of the seed, and the report. */
  golden?: {
    files?: Record<string, string>;
    report: AgentReport;
  };
}

export interface ExecuteResult {
  report: AgentReport;
  /** Directory holding the repository after the role ran. */
  workdir: string;
}

export type ExecuteTask = (evalCase: EvalCase) => Promise<ExecuteResult>;

export interface CaseResult {
  role: AgentRole;
  id: string;
  title: string;
  passed: boolean;
  checks: { name: string; ok: boolean; notes: string }[];
  durationMs: number;
  error?: string;
}

export interface EvalRunResult {
  results: CaseResult[];
  passed: number;
  failed: number;
  table: string;
  json: string;
}
