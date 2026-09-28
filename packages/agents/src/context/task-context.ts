/**
 * The orchestrator's context header: the first user message of every agent session
 * (docs/prompts/README.md step 5, 03 §4 step 2).
 *
 * What this protects: a task agent never sees the user's prompt, only its self-contained
 * task (03 §3); it always sees its limits, its write scope, the reports of the tasks it
 * depends on and the exact schema of its `submit_*`; implementers get the Next.js 16
 * sheet. Every block is bounded so the header cannot crowd out the work.
 */
import type { Intent, RunPlan, Task, TaskReport } from "@forja/contracts";
import { toJsonSchema } from "../tools/json-schema.js";
import { TOOL_REGISTRY } from "../tools/registry.js";
import { contextSheet } from "../prompts/assemble.js";
import { PLANNABLE_ROLES, roleDefinition } from "../roles/index.js";

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}\n… [${text.length - max} characters omitted]`);

function submitSchema(name: string): string {
  const tool = TOOL_REGISTRY.get(name);
  return tool ? JSON.stringify(toJsonSchema(tool.input)) : "{}";
}

export interface Limits {
  maxTurns: number;
  /** USD available to this session; null = no limit. */
  budgetUsd: number | null;
}

function limitsBlock(l: Limits): string {
  return `## Limits\n- At most ${l.maxTurns} turns in this session.\n- Budget: ${l.budgetUsd === null ? "not limited" : `${l.budgetUsd.toFixed(2)} USD`}.\n- Tasks run one after another on a single branch (AGENT_MAX_PARALLEL_TASKS = 1).`;
}

const PHASE_NOTE =
  "Browser tools (screenshots, axe), http_probe and the design, brand, copy, QA, review, security and docs specialists are not available in this version of the builder. Skip steps that need them and say so in your report's concerns.";

// ── Director: intake (intent + plan or answer) ───────────────────────────────

export interface DirectorIntakeInput {
  prompt: string;
  /** Attachments the user sent (name, URL the app can fetch, description). */
  inputFiles: { name: string; url: string; imageDescription?: string }[];
  /** Language code of the user (for the plan summary and the final message). */
  language: string;
  isFirstPrompt: boolean;
  projectAgentsMd: string | null;
  fileTree: string;
  recentConversation: { author: string; text: string }[];
  limits: Limits;
  budgetUsd: number | null;
}

export function renderDirectorIntake(i: DirectorIntakeInput): string {
  const roles = PLANNABLE_ROLES.map((r) => `- \`${r}\`: default write scope ${roleDefinition(r)?.defaultScope.map((g) => `\`${g}\``).join(", ")}`).join("\n");
  return [
    "# Context from the orchestrator",
    "",
    "## The user's request",
    i.prompt,
    i.inputFiles.length ? `\n## Attached files\n${i.inputFiles.map((f) => `- ${f.name}: ${f.url}${f.imageDescription ? ` — ${f.imageDescription}` : ""}`).join("\n")}` : "",
    "",
    `## User language\n\`${i.language}\`: write \`summary\` and every message to the user in this language; code, tasks and reports stay in English.`,
    i.isFirstPrompt ? "\nThis is the first prompt of the project: the repository is the unmodified template, and the intent is `full` unless the request is only a question." : "",
    i.recentConversation.length ? `\n## Recent conversation\n${i.recentConversation.map((m) => `- ${m.author}: ${clip(m.text.replace(/\s+/g, " "), 400)}`).join("\n")}` : "",
    "",
    "## Team available in this version",
    roles,
    "Only these roles may own plan tasks. Do not plan tasks for other roles; the orchestrator adds verification itself.",
    PHASE_NOTE,
    "",
    "## Project instructions (AGENTS.md)",
    i.projectAgentsMd ? clip(i.projectAgentsMd, 12_000) : "(none)",
    "",
    "## File tree (excerpt)",
    clip(i.fileTree, 8_000),
    "",
    limitsBlock(i.limits),
    "",
    "## What to do now",
    "1. Explore the repository only as much as you need (read_file, grep, glob, list_dir).",
    "2. Call `submit_intent` first.",
    `3. Then either \`submit_plan\` (schema: ${submitSchema("submit_plan")}) or, for a question, \`submit_message\` with the answer.`,
    "Keep the plan as small as the request allows: a tweak is one task.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export const DIRECTOR_AFTER_INTENT = (intent: Intent): string =>
  intent === "question"
    ? "Intent recorded: question. Answer it now from the repository with `submit_message` (in the user's language). Do not plan tasks."
    : `Intent recorded: ${intent}. Now call \`submit_plan\` with the complete RunPlan.`;

// ── Task agents ──────────────────────────────────────────────────────────────

export interface TaskContextInput {
  task: Task;
  plan: RunPlan;
  dependencyReports: { taskId: string; title: string; report: TaskReport }[];
  projectAgentsMd: string | null;
  fileTree: string;
  limits: Limits;
}

export function renderTaskContext(i: TaskContextInput): string {
  const def = roleDefinition(i.task.role);
  const spec = i.plan.spec;
  const specBlock = JSON.stringify(
    {
      goal: spec.goal,
      pages: spec.pages,
      features: spec.features,
      dataModel: spec.dataModel,
      integrations: spec.integrations,
      nonFunctional: spec.nonFunctional,
    },
    null,
    1,
  );
  return [
    "# Context from the orchestrator",
    "",
    `## Your task: ${i.task.title} (id \`${i.task.id}\`)`,
    i.task.description,
    "",
    "## Acceptance criteria",
    ...i.task.acceptance.map((a) => `- ${a}`),
    "",
    "## Write scope",
    i.task.scope.write.length ? i.task.scope.write.map((g) => `- \`${g}\``).join("\n") : "(read-only)",
    "Writes outside these globs are refused. `.env*` files are never writable: list the variables you need in `envNeeds`.",
    "",
    i.dependencyReports.length ? "## Reports of the tasks you depend on" : "",
    ...i.dependencyReports.map((d) => `### ${d.title} (\`${d.taskId}\`)\n${clip(JSON.stringify({ summary: d.report.summary, filesChanged: d.report.filesChanged, decisions: d.report.decisions, concerns: d.report.concerns }), 3_000)}`),
    "",
    "## Specification (shared by the whole team)",
    clip(specBlock, 16_000),
    i.plan.decisions.length ? `\n## Decisions\n${clip(i.plan.decisions.map((d) => `- ${d.title}: ${d.decision}`).join("\n"), 4_000)}` : "",
    "",
    "## Project instructions (AGENTS.md)",
    i.projectAgentsMd ? clip(i.projectAgentsMd, 10_000) : "(none)",
    "",
    "## File tree (excerpt)",
    clip(i.fileTree, 6_000),
    "",
    def?.needsFrameworkSheet ? contextSheet("next16") : "",
    "",
    PHASE_NOTE,
    "",
    limitsBlock(i.limits),
    "",
    "## How to finish",
    `Verify your work with \`bash\` (npm run typecheck, npm run lint${i.task.role === "database" ? ", npm run db:generate, npm run db:migrate, npm run db:seed" : ""}) before reporting, then call \`${def?.submitTools[0] ?? "submit_report"}\` with this schema: ${submitSchema(def?.submitTools[0] ?? "submit_report")}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ── Fixer and owner rework ───────────────────────────────────────────────────

export interface FixContextInput {
  gate: string;
  command: string;
  errors: { file?: string; line?: number; message: string }[];
  output: string;
  scope: readonly string[];
  limits: Limits;
  /** The task the failure is routed to, when it goes back to its owner. */
  ownerTask?: Task;
}

export function renderFixContext(i: FixContextInput): string {
  return [
    "# Context from the orchestrator",
    "",
    `## A verification gate failed: \`${i.gate}\``,
    `Command: \`${i.command}\``,
    "",
    "## Errors",
    i.errors.length ? clip(i.errors.map((e) => `- ${e.file ?? "?"}${e.line ? `:${e.line}` : ""}: ${e.message}`).join("\n"), 8_000) : "(not parsed; see the output)",
    "",
    "## Output (tail)",
    "```",
    clip(i.output, 6_000),
    "```",
    "",
    i.ownerTask ? `## The task that owns this code\n${i.ownerTask.title}: ${clip(i.ownerTask.description, 3_000)}\n` : "",
    "## Write scope",
    i.scope.length ? i.scope.map((g) => `- \`${g}\``).join("\n") : "(read-only)",
    "",
    contextSheet("next16"),
    "",
    limitsBlock(i.limits),
    "",
    `Fix the root cause, re-run \`${i.command}\` with bash until it passes, then call \`submit_report\` (schema: ${submitSchema("submit_report")}). Report every error you could not fix with the reason.`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function renderLocalGateRework(gate: string, command: string, output: string): string {
  return `The orchestrator ran \`${command}\` (${gate}) after your report and it failed. Fix it within your scope, re-run the command with bash until it passes, and call submit_report again.\n\n\`\`\`\n${clip(output, 6_000)}\n\`\`\``;
}

// ── Director: closing message ────────────────────────────────────────────────

export interface ClosingInput {
  prompt: string;
  language: string;
  intent: Intent;
  planSummary: string;
  reports: { title: string; status: string; summary: string; concerns: string[] }[];
  gates: { name: string; passed: boolean; detail?: string }[];
  skipped: string[];
  secretKeysNeeded: { name: string; description: string; isProvided: boolean }[];
  previewUrl: string;
  costUsd: number;
  minutes: number;
  limits: Limits;
}

export function renderClosingContext(i: ClosingInput): string {
  return [
    "# Context from the orchestrator: write the closing message",
    "",
    "## The user's request",
    i.prompt,
    "",
    `## Language: \`${i.language}\``,
    `## Intent: ${i.intent}. Plan: ${i.planSummary}`,
    "",
    "## What the team reported",
    ...i.reports.map((r) => `- [${r.status}] ${r.title}: ${clip(r.summary, 600)}${r.concerns.length ? ` Concerns: ${clip(r.concerns.join("; "), 600)}` : ""}`),
    i.skipped.length ? `\n## Not done\n${i.skipped.map((s) => `- ${s}`).join("\n")}` : "",
    "",
    "## Automatic checks",
    ...i.gates.map((g) => `- ${g.name}: ${g.passed ? "passed" : `FAILED${g.detail ? ` (${clip(g.detail, 300)})` : ""}`}`),
    i.secretKeysNeeded.length ? `\n## Settings the user must provide\n${i.secretKeysNeeded.map((s) => `- ${s.name}: ${s.description}${s.isProvided ? " (already provided)" : ""}`).join("\n")}` : "",
    "",
    `## Preview link: ${i.previewUrl}`,
    `## Cost and time: ${i.costUsd.toFixed(2)} USD, about ${Math.max(1, Math.round(i.minutes))} min`,
    "",
    "Call `submit_message` now with the closing message (structure and length rules are in your role prompt). Never hide a failed check.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
