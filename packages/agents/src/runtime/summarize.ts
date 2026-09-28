/**
 * The summarizer as a compactor (docs/prompts/roles/summarizer.md, 02 §4.7).
 *
 * What this protects: compaction is done by the `summarizer` role through the same loop
 * and its own `submit_summary` contract, never by truncating silently; the transcript it
 * reads is bounded (each tool output capped) so the summary call itself cannot overflow.
 */
import type { AgentMessage, BudgetHandle, Provider } from "@forja/llm";
import { submitSummaryTool } from "../tools/submit.js";
import type { ToolContext } from "../tools/types.js";
import { runAgentLoop, type Compactor, type LoopEvent } from "./loop.js";

const MAX_PART_CHARS = 2_000;

function clip(text: string, max = MAX_PART_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)} … [${text.length - max} more characters]`;
}

/** A readable transcript of messages for the summarizer. */
export function renderTranscript(messages: readonly AgentMessage[]): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("\n");
      out.push(`### user\n${clip(text, 6_000)}`);
    } else if (m.role === "assistant") {
      const calls = m.toolCalls.map((c) => `→ ${c.name}(${clip(JSON.stringify(c.args ?? {}), 600)})`).join("\n");
      out.push(`### assistant\n${[m.text.trim(), calls].filter(Boolean).join("\n")}`);
    } else {
      out.push(`### tool ${m.name}${m.isError ? " (error)" : ""}\n${clip(m.content)}`);
    }
  }
  return out.join("\n\n");
}

export interface SummarizerDeps {
  provider: Provider;
  /** The assembled summarizer system prompt. */
  system: string;
  toolContext: ToolContext;
  budget: BudgetHandle;
  maxOutputTokens: number;
  model?: string;
  onEvent?: (event: LoopEvent) => void;
}

export function createSummarizerCompactor(deps: SummarizerDeps): Compactor {
  return async (older, abortSignal) => {
    const r = await runAgentLoop({
      role: "summarizer",
      provider: deps.provider,
      system: deps.system,
      messages: [
        {
          role: "user",
          content: `Purpose: compaction. The agent continues the same task after your summary.\n\nTranscript segment to summarise:\n\n${renderTranscript(older)}\n\nCall submit_summary with the block.`,
        },
      ],
      tools: [submitSummaryTool],
      terminalTools: ["submit_summary"],
      toolContext: { ...deps.toolContext, role: "summarizer", scopeWrite: [], abortSignal },
      budget: deps.budget,
      maxTurns: 3,
      maxOutputTokens: deps.maxOutputTokens,
      ...(deps.model ? { model: deps.model } : {}),
      onEvent: deps.onEvent,
    });
    const payload = r.submission?.payload as { text?: string } | undefined;
    if (r.outcome !== "submitted" || !payload?.text) throw new Error(`summarizer ended with ${r.outcome}`);
    return payload.text;
  };
}
