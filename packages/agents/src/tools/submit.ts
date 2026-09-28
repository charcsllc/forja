/**
 * The `submit_*` tools: how every role ends its task (03 §1, 11 "Orquestación").
 *
 * What this protects: the payload is validated with the zod schema from
 * `@forja/contracts` BEFORE it is accepted, plus any orchestrator rule injected through
 * `ToolContext.submitValidators` (e.g. `validatePlan` and the phase's role set for
 * `submit_plan`). A rejected payload goes back to the model with the exact errors, so it
 * can fix and resubmit; the loop only ends on an accepted submission.
 */
import {
  DecisionSchema,
  DirectorMessageSchema,
  IntentClassificationSchema,
  RunPlanSchema,
  SummarySchema,
  TaskReportSchema,
  validatePlan,
} from "@forja/contracts";
import type { z } from "zod";
import { defineTool, fail, ok, type ToolContext, type ToolSpec } from "./types.js";

async function accept(name: string, payload: unknown, ctx: ToolContext, builtIn: string[] = []) {
  const extra = (await ctx.submitValidators?.[name]?.(payload)) ?? [];
  const errors = [...builtIn, ...extra];
  if (errors.length > 0) {
    return fail(`REJECTED: ${name} was not accepted. Fix every problem and call ${name} again:\n- ${errors.join("\n- ")}`, `${errors.length} problem(s)`);
  }
  return ok(`Accepted. Your ${name.replace("submit_", "")} was recorded.`, "accepted");
}

function submitTool<S extends z.ZodTypeAny>(name: string, description: string, input: S, builtIn?: (payload: z.infer<S>) => string[]): ToolSpec<S> {
  return defineTool({
    name,
    kind: "submit",
    description,
    input,
    summarize: () => "",
    execute: (args, ctx) => accept(name, args, ctx, builtIn?.(args)),
  });
}

export const submitIntentTool = submitTool(
  "submit_intent",
  "Classify the user's request. Always your first submission. intent: question | tweak | bugfix | feature | refactor | infra | full; confidence 0–1; reason: one sentence.",
  IntentClassificationSchema,
);

export const submitPlanTool = submitTool(
  "submit_plan",
  "Submit the RunPlan (spec, decisions, tasks, budgetWeights, verification). It is validated: unique task ids, known dependsOn, no cycles, disjoint write scopes for tasks without a dependency, one owner per hot file, at least one acceptance criterion and a positive weight per task. A rejected plan comes back with the exact errors.",
  RunPlanSchema,
  (plan) => {
    const v = validatePlan(plan);
    return v.ok ? [] : v.errors;
  },
);

export const submitDecisionTool = submitTool(
  "submit_decision",
  "Record an architecture decision (ADR) taken during the run: title, context, options, decision, consequences.",
  DecisionSchema,
);

export const submitMessageTool = submitTool(
  "submit_message",
  "Deliver your message to the user (the answer to a question, or the closing message of the run) in the user's language, in plain words, with no task ids, role names or provider names. Field: text.",
  DirectorMessageSchema,
);

export const submitReportTool = submitTool(
  "submit_report",
  "Finish your task with your report: status (done | partial | blocked), summary, filesChanged, acceptance (criterion, met, evidence), decisions, concerns, followUps, newDependencies, envNeeds. The orchestrator reads only this; text after it is ignored.",
  TaskReportSchema,
);

export const submitSummaryTool = submitTool(
  "submit_summary",
  "Deliver the summary block (field text) exactly in the structure your role prompt describes.",
  SummarySchema,
);
