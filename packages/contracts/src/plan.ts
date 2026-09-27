/**
 * The run plan: roles, intents, run/task statuses, the `RunPlan` the director submits,
 * and its deterministic validator.
 *
 * Protects: the contract between the director and every other agent
 * (docs/architecture/03-agents-and-orchestration.md §1–§3). A plan that fails
 * `validatePlan` goes back to the director with the error list, verbatim.
 */
import { z } from "zod";
import type { AgentProcessStatus } from "./v1/status";

// ─── Enums ─────────────────────────────────────────────────────────────────

export const AGENT_ROLES = [
  "director",
  "designer",
  "brand",
  "imagery",
  "copywriter",
  "database",
  "backend",
  "frontend",
  "supervisor",
  "qa",
  "reviewer",
  "security",
  "docs",
  "fixer",
  "summarizer",
] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const INTENTS = ["question", "tweak", "bugfix", "feature", "refactor", "infra", "full"] as const;
export const IntentSchema = z.enum(INTENTS);
export type Intent = z.infer<typeof IntentSchema>;

export const RUN_STATUSES = [
  "received",
  "directing",
  "answering",
  "designing",
  "modelling",
  "implementing",
  "integrating",
  "verifying",
  "fixing",
  "reviewing",
  "documenting",
  "finishing",
  "cancelling",
  "done",
  "failed",
  "limit-reached",
  "cancelled",
] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "done",
  "failed",
  "limit-reached",
  "cancelled",
]);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Projection to API v1 (03 §2): any non-terminal status → `init`; terminal → `done`;
 * no run at all → `idle`.
 */
export function toAgentProcessStatus(status: RunStatus | null | undefined): AgentProcessStatus {
  if (!status) return "idle";
  return isTerminalRunStatus(status) ? "done" : "init";
}

export const TASK_STATUSES = [
  "pending",
  "running",
  "checking",
  "done",
  "failed",
  "cancelled",
  "skipped",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// ─── Intent classification (`submit_intent`) ─────────────────────────────────

export const IntentClassificationSchema = z.object({
  intent: IntentSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});
export type IntentClassification = z.infer<typeof IntentClassificationSchema>;

/** Below this confidence the orchestrator takes the most complete candidate pipeline. */
export const INTENT_CONFIDENCE_THRESHOLD = 0.6;

// ─── Spec ──────────────────────────────────────────────────────────────────

export const PageSpecSchema = z.object({
  route: z.string().min(1),
  purpose: z.string().min(1),
  sections: z.array(z.string()),
  /** Named content slots the copywriter fills. */
  contentSlots: z.array(z.string()).default([]),
  /** What the page shows in each state; absent = not applicable. */
  states: z
    .object({
      empty: z.string(),
      loading: z.string(),
      error: z.string(),
      success: z.string(),
    })
    .partial()
    .default({}),
  /** Entities or queries the page reads. */
  data: z.array(z.string()).default([]),
});
export type PageSpec = z.infer<typeof PageSpecSchema>;

export const FeatureSpecSchema = z.object({
  name: z.string().min(1),
  userStories: z.array(z.string()).min(1),
  businessRules: z.array(z.string()).default([]),
});
export type FeatureSpec = z.infer<typeof FeatureSpecSchema>;

export const EntityFieldSpecSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  required: z.boolean(),
  unique: z.boolean().optional(),
  constraints: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type EntityFieldSpec = z.infer<typeof EntityFieldSpecSchema>;

export const EntityRelationSpecSchema = z.object({
  name: z.string().min(1),
  target: z.string().min(1),
  kind: z.enum(["oneToOne", "oneToMany", "manyToOne", "manyToMany"]),
  onDelete: z.enum(["cascade", "restrict", "set null", "no action"]).optional(),
});
export type EntityRelationSpec = z.infer<typeof EntityRelationSpecSchema>;

export const EntitySpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  fields: z.array(EntityFieldSpecSchema).min(1),
  relations: z.array(EntityRelationSpecSchema).default([]),
  invariants: z.array(z.string()).default([]),
});
export type EntitySpec = z.infer<typeof EntitySpecSchema>;

export const FlowSpecSchema = z.object({
  name: z.string().min(1),
  steps: z.array(z.string()).min(1),
  expected: z.string().min(1),
});
export type FlowSpec = z.infer<typeof FlowSpecSchema>;

export const NonFunctionalSpecSchema = z.object({
  seo: z.boolean(),
  auth: z.enum(["none", "email", "oauth"]),
  i18n: z.array(z.string()),
  a11y: z.literal("AA"),
  performanceBudget: z.string().optional(),
});
export type NonFunctionalSpec = z.infer<typeof NonFunctionalSpecSchema>;

export const SpecSchema = z.object({
  goal: z.string().min(1),
  users: z.array(z.string()),
  pages: z.array(PageSpecSchema),
  features: z.array(FeatureSpecSchema),
  dataModel: z.array(EntitySpecSchema),
  integrations: z.array(z.string()),
  nonFunctional: NonFunctionalSpecSchema,
});
export type Spec = z.infer<typeof SpecSchema>;

// ─── Decisions (ADRs, also `submit_decision`) ────────────────────────────────

export const DecisionSchema = z.object({
  id: z.string().optional(),
  title: z.string().min(1),
  context: z.string().min(1),
  options: z.array(z.string()).default([]),
  decision: z.string().min(1),
  consequences: z.string().min(1),
  /** Id of an earlier decision this one replaces. */
  supersedes: z.string().optional(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// ─── Tasks and plan ──────────────────────────────────────────────────────────

export const TaskScopeSchema = z.object({
  /** Globs the task may write. `!`-prefixed entries exclude literal paths. */
  write: z.array(z.string().min(1)),
  read: z.array(z.string().min(1)).optional(),
});
export type TaskScope = z.infer<typeof TaskScopeSchema>;

/**
 * A task. `acceptance` and `weight` are shape-checked here and rule-checked in
 * `validatePlan`, so the director gets one readable list of every problem.
 */
export const TaskSchema = z.object({
  id: z.string().min(1),
  role: AgentRoleSchema,
  title: z.string().min(1),
  /** Self-contained: the agent never sees the user's prompt. */
  description: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  scope: TaskScopeSchema,
  acceptance: z.array(z.string()),
  weight: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

export const VerificationSpecSchema = z.object({
  pages: z.array(z.string()),
  flows: z.array(FlowSpecSchema),
});
export type VerificationSpec = z.infer<typeof VerificationSpecSchema>;

export const RunPlanSchema = z.object({
  intent: IntentSchema,
  /** One sentence in the user's language. */
  summary: z.string().min(1),
  spec: SpecSchema,
  decisions: z.array(DecisionSchema),
  tasks: z.array(TaskSchema),
  /** Relative weight per task id; the orchestrator turns weights into money. */
  budgetWeights: z.record(z.string(), z.number()),
  verification: VerificationSpecSchema,
});
export type RunPlan = z.infer<typeof RunPlanSchema>;

// ─── Deterministic plan rules ──────────────────────────────────────────────────

/** Files that belong to exactly one task (or the orchestrator's supervisor task). */
export const HOT_FILES: readonly string[] = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "src/db/schema/index.ts",
  "src/app/layout.tsx",
  "src/app/globals.css",
  "next.config.ts",
  "src/env.ts",
  ".env.example",
];

const WILDCARD = /[*?[{]/;

function normalizePath(p: string): string {
  return p.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

function hasWildcard(glob: string): boolean {
  return WILDCARD.test(glob);
}

/** The literal part of a glob before its first wildcard character. */
function staticPrefix(glob: string): string {
  const match = WILDCARD.exec(glob);
  return match ? glob.slice(0, match.index) : glob;
}

/** Exact glob → RegExp for matching a literal path: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  const g = normalizePath(glob);
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g.charAt(i);
    if (c === "*") {
      if (g.charAt(i + 1) === "*") {
        // `**/` matches zero or more directories; a trailing `**` matches anything.
        if (g.charAt(i + 2) === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
      } else {
        const alternatives = g.slice(i + 1, end).split(",").map(escapeRegExp);
        out += `(?:${alternatives.join("|")})`;
        i = end;
      }
    } else {
      out += escapeRegExp(c);
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Whether two write globs may name a common file. Heuristic (no minimatch):
 * - two literal paths overlap iff they are equal;
 * - a literal path and a glob overlap iff the glob matches the path exactly
 *   (`globToRegExp`);
 * - two globs overlap iff the static prefix of one (the text before its first
 *   `*`, `?`, `[` or `{`) is a prefix of the other's. This over-approximates
 *   (`src/app/*.tsx` vs `src/app/x/**` is reported as overlapping), which is the
 *   safe direction for a scope check; it never misses a real overlap.
 */
export function globsOverlap(a: string, b: string): boolean {
  const x = normalizePath(a);
  const y = normalizePath(b);
  const wx = hasWildcard(x);
  const wy = hasWildcard(y);
  if (!wx && !wy) return x === y;
  if (!wx) return globToRegExp(y).test(x);
  if (!wy) return globToRegExp(x).test(y);
  const px = staticPrefix(x);
  const py = staticPrefix(y);
  return px.startsWith(py) || py.startsWith(px);
}

/** Whether a task scope may write `path` (positive globs minus `!` exclusions). */
export function scopeCoversPath(write: readonly string[], path: string): boolean {
  const target = normalizePath(path);
  const excluded = write
    .filter((g) => g.startsWith("!"))
    .some((g) => globToRegExp(g.slice(1)).test(target));
  if (excluded) return false;
  return write.filter((g) => !g.startsWith("!")).some((g) => globsOverlap(g, target));
}

/**
 * The glob pairs through which two scopes may write a common file (empty = disjoint).
 * `!` exclusions are honoured when the
 * other side is a literal path; between two wildcard globs they are ignored
 * (over-approximation, see `globsOverlap`).
 */
export function findScopeOverlaps(a: readonly string[], b: readonly string[]): string[] {
  const conflicts: string[] = [];
  const pa = a.filter((g) => !g.startsWith("!"));
  const pb = b.filter((g) => !g.startsWith("!"));
  for (const ga of pa) {
    for (const gb of pb) {
      if (!globsOverlap(ga, gb)) continue;
      if (!hasWildcard(ga) && !scopeCoversPath(b, ga)) continue;
      if (!hasWildcard(gb) && !scopeCoversPath(a, gb)) continue;
      conflicts.push(`${ga} ∩ ${gb}`);
    }
  }
  return conflicts;
}

export type PlanValidation = { ok: true } | { ok: false; errors: string[] };

export interface ValidatePlanOptions {
  /**
   * Task ids that already exist outside this plan (a partial re-plan from
   * `submit_decision` may depend on them). They satisfy `dependsOn` but take no part
   * in the scope checks.
   */
  knownTaskIds?: Iterable<string>;
  /** Override the hot file list (tests, templates with another layout). */
  hotFiles?: readonly string[];
}

/**
 * Deterministic rules of 03 §3. Accepts unknown input: a shape error is reported as
 * `schema: <path>: <message>` and stops the rule checks.
 *
 * Rules: unique task ids; `dependsOn` references exist and form a DAG; every task has
 * at least one non-empty acceptance criterion; weights (`task.weight` and every
 * `budgetWeights` entry) are finite and > 0 and `budgetWeights` keys name tasks; write
 * scopes of tasks with no dependency path between them are disjoint; each hot file is
 * writable by at most one task.
 */
export function validatePlan(input: unknown, options: ValidatePlanOptions = {}): PlanValidation {
  const parsed = RunPlanSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `schema: ${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const plan = parsed.data;
  const errors: string[] = [];
  const external = new Set(options.knownTaskIds ?? []);
  const hotFiles = options.hotFiles ?? HOT_FILES;

  // Unique ids.
  const byId = new Map<string, Task>();
  for (const task of plan.tasks) {
    if (byId.has(task.id)) errors.push(`task "${task.id}": duplicate task id`);
    else byId.set(task.id, task);
  }

  // Per-task rules.
  for (const task of plan.tasks) {
    if (task.acceptance.filter((c) => c.trim().length > 0).length === 0) {
      errors.push(`task "${task.id}": needs at least one acceptance criterion`);
    }
    if (!Number.isFinite(task.weight) || task.weight <= 0) {
      errors.push(`task "${task.id}": weight must be > 0 (got ${task.weight})`);
    }
    for (const dep of task.dependsOn) {
      if (dep === task.id) errors.push(`task "${task.id}": depends on itself`);
      else if (!byId.has(dep) && !external.has(dep)) {
        errors.push(`task "${task.id}": dependsOn references unknown task "${dep}"`);
      }
    }
  }

  for (const [id, weight] of Object.entries(plan.budgetWeights)) {
    if (!byId.has(id)) errors.push(`budgetWeights: "${id}" is not a task of this plan`);
    if (!Number.isFinite(weight) || weight <= 0) {
      errors.push(`budgetWeights: "${id}" must be > 0 (got ${weight})`);
    }
  }

  // Cycles (DFS over in-plan edges).
  const cycle = findCycle(plan.tasks, byId);
  if (cycle) errors.push(`dependsOn forms a cycle: ${cycle.join(" → ")}`);

  // Scope rules need reachability; skip them on a cyclic graph (already an error).
  if (!cycle) {
    const ancestors = computeAncestors(plan.tasks, byId);
    const related = (a: string, b: string): boolean =>
      (ancestors.get(a)?.has(b) ?? false) || (ancestors.get(b)?.has(a) ?? false);

    const tasks = [...byId.values()];
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const a = tasks[i];
        const b = tasks[j];
        if (!a || !b || related(a.id, b.id)) continue;
        const overlap = findScopeOverlaps(a.scope.write, b.scope.write);
        if (overlap.length > 0) {
          errors.push(
            `tasks "${a.id}" and "${b.id}" have no dependency between them but their write scopes overlap: ${overlap.join(", ")}`,
          );
        }
      }
    }

    for (const hot of hotFiles) {
      const owners = tasks.filter((t) => scopeCoversPath(t.scope.write, hot)).map((t) => t.id);
      if (owners.length > 1) {
        errors.push(`hot file "${hot}" is writable by ${owners.length} tasks: ${owners.join(", ")}`);
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function findCycle(tasks: readonly Task[], byId: ReadonlyMap<string, Task>): string[] | null {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep) || dep === id) continue; // reported elsewhere
      const found = visit(dep);
      if (found) return found;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };

  for (const task of tasks) {
    const found = visit(task.id);
    if (found) return found;
  }
  return null;
}

/** Transitive `dependsOn` closure per task (acyclic graph assumed). */
function computeAncestors(
  tasks: readonly Task[],
  byId: ReadonlyMap<string, Task>,
): Map<string, Set<string>> {
  const memo = new Map<string, Set<string>>();
  const walk = (id: string): Set<string> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    memo.set(id, result);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep) || dep === id) continue;
      result.add(dep);
      for (const a of walk(dep)) result.add(a);
    }
    return result;
  };
  for (const task of tasks) walk(task.id);
  return memo;
}
