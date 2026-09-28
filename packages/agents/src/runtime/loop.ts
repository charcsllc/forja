/**
 * The uniform agent loop (docs/architecture/02 §4, 03 §4 step 3): model ↔ tools until an
 * accepted `submit_*`, the turn limit, the budget or an abort.
 *
 * What this protects:
 * - Tool arguments are validated with the tool's zod schema BEFORE execution; invalid
 *   arguments, unknown tools and tool failures go back to the model as error results, so
 *   it can correct itself. A tool bug never crashes the task (it becomes `TOOL_ERROR`).
 * - The assistant turn is kept with its provider-native message (`native`) so reasoning
 *   blocks are echoed back untouched (02 §4 invariant 1).
 * - A model that answers with text instead of calling its `submit_*` gets ONE reminder
 *   turn (`maxNudges`); the next time the task ends as `no-submit` with the last text
 *   (03 §1). `tool_choice` is never forced.
 * - Every tool output is redacted before it reaches the model or an event.
 * - Long contexts are compacted past `softLimit` of the model's context (02 §4.7): the
 *   first user message (the task) and the last assistant turn stay verbatim; the rest
 *   becomes a `[context summary]` from the summarizer (or, without one, old tool outputs
 *   are elided in place).
 * - Abort (agent/stop) ends the loop within one event of the stream; a per-turn timeout
 *   bounds a stuck provider (a free-tier first byte was observed at 131 s, so the default
 *   is generous).
 */
import type { AgentRole } from "@forja/contracts";
import type { AgentMessage, BudgetHandle, Effort, FinishReason, GenerateEvent, Provider, ToolCall } from "@forja/llm";
import type { AnyTool, ToolContext } from "../tools/types.js";
import { protocolFor, type ToolExchange, type ToolProtocolName } from "./protocol.js";
import { estimateTokens } from "./tokens.js";

export const DEFAULT_TURN_TIMEOUT_MS = 20 * 60_000;

export type LoopEvent =
  | { type: "turn.started"; turn: number }
  | { type: "route"; turn: number; provider: string; model: string; attempt: number }
  | {
      type: "usage";
      turn: number;
      provider: string | null;
      model: string | null;
      input: number;
      output: number;
      cachedInput: number;
      cacheWrite: number;
      costUsd: number;
      latencyMs: number;
      ttftMs: number | null;
    }
  | { type: "text"; turn: number; text: string }
  | { type: "tool.call"; turn: number; id: string; name: string; argsSummary: string }
  | { type: "tool.result"; turn: number; id: string; name: string; ok: boolean; summary: string; durationMs: number }
  | { type: "submitted"; turn: number; name: string; payload: unknown; terminal: boolean }
  | { type: "nudge"; turn: number; reason: "no-tool-call" | "output-limit" }
  | { type: "context.compacted"; fromTurn: number; toTurn: number; tokensBefore: number; tokensAfter: number }
  | { type: "llm.error"; turn: number; message: string; provider: string | null; model: string | null };

export type LoopOutcome = "submitted" | "no-submit" | "max-turns" | "budget" | "aborted" | "llm-error";

export interface LoopResult {
  outcome: LoopOutcome;
  submission?: { tool: string; payload: unknown };
  /** The whole conversation, to continue it (director phases) or to checkpoint it. */
  messages: AgentMessage[];
  turns: number;
  lastText: string;
  error?: unknown;
  usage: { calls: number; input: number; output: number; costUsd: number };
}

/** Compacts the older part of a conversation into a summary text (the summarizer). */
export type Compactor = (older: AgentMessage[], abortSignal: AbortSignal) => Promise<string>;

export interface AgentLoopOptions {
  role: AgentRole;
  provider: Provider;
  system: string;
  messages: AgentMessage[];
  /** Tools offered on every turn, including the `submit_*` tools. */
  tools: readonly AnyTool[];
  /** Submissions that end this loop when accepted (other submit tools are just recorded). */
  terminalTools: readonly string[];
  toolContext: ToolContext;
  budget: BudgetHandle;
  maxTurns: number;
  maxOutputTokens: number;
  effort?: Effort;
  /** A resolved `provider:model`; absent = the gateway routes by role. */
  model?: string;
  protocol?: ToolProtocolName;
  maxNudges?: number;
  turnTimeoutMs?: number;
  /** The model's context window; with `softLimit` it triggers compaction. */
  contextTokens?: number;
  /** Fraction of `contextTokens` (AGENT_CONTEXT_SOFT_LIMIT, 0.6). */
  softLimit?: number;
  compact?: Compactor;
  onEvent?: (event: LoopEvent) => void;
  /** Clock for latency (tests). */
  now?: () => number;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  const s = raw.trim();
  if (s === "") return {};
  try {
    return JSON.parse(s);
  } catch {
    return raw;
  }
}

function issuesText(error: { issues: { path: (string | number)[]; message: string }[] }): string {
  return error.issues
    .slice(0, 20)
    .map((i) => `- ${i.path.length ? i.path.join(".") : "(arguments)"}: ${i.message}`)
    .join("\n");
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function nudgeText(terminal: readonly string[]): string {
  const names = terminal.join(" or ");
  return `You ended your turn without calling a tool. This task only ends when you call ${names} with the payload your instructions describe; text alone is ignored. Call ${names} now, or keep working with your tools.`;
}

const OUTPUT_LIMIT_TEXT =
  "Your last answer was cut off at the output limit. Continue with tool calls, and split large files into several smaller write_file or edit_file calls.";

/** Runs one agent to its terminal submission (or a limit). Never throws for model or tool problems. */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<LoopResult> {
  const now = opts.now ?? Date.now;
  const protocol = protocolFor(opts.protocol ?? "native");
  const prepared = protocol.prepare(opts.tools);
  const system = opts.system + prepared.systemSuffix;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const ctx = opts.toolContext;
  const emit = (e: LoopEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      // Observers never break the loop.
    }
  };
  const maxNudges = opts.maxNudges ?? 1;
  const messages: AgentMessage[] = [...opts.messages];
  const usage = { calls: 0, input: 0, output: 0, costUsd: 0 };
  let nudges = 0;
  let lastText = "";
  let lastInputTokens = 0;
  let turnsSinceCompaction = 0;
  let firstTurnOfWindow = 1;

  const result = (outcome: LoopOutcome, turns: number, extra: Partial<LoopResult> = {}): LoopResult => ({
    outcome,
    messages,
    turns,
    lastText,
    usage,
    ...extra,
  });

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    if (ctx.abortSignal.aborted) return result("aborted", turn - 1);
    if (opts.budget.remainingUsd() <= 0) return result("budget", turn - 1);

    // ── Compaction (02 §4.7) ──
    if (opts.contextTokens && turnsSinceCompaction > 0) {
      const limit = opts.contextTokens * (opts.softLimit ?? 0.6);
      const estimate = Math.max(lastInputTokens, estimateTokens(system, messages));
      if (estimate > limit) {
        const compacted = await compactMessages(messages, opts.compact, ctx.abortSignal).catch(() => null);
        if (compacted) {
          const after = estimateTokens(system, compacted);
          messages.splice(0, messages.length, ...compacted);
          emit({ type: "context.compacted", fromTurn: firstTurnOfWindow, toTurn: turn - 1, tokensBefore: estimate, tokensAfter: after });
          firstTurnOfWindow = turn;
          lastInputTokens = 0;
          turnsSinceCompaction = 0;
        }
      }
    }

    // ── One model turn ──
    emit({ type: "turn.started", turn });
    let text = "";
    const nativeCalls: ToolCall[] = [];
    let finish: FinishReason | null = null;
    let raw: unknown;
    let hasRaw = false;
    let provider: string | null = null;
    let model: string | null = null;
    const started = now();
    let firstByteAt: number | null = null;
    const timeout = AbortSignal.timeout(opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    const signal = AbortSignal.any([ctx.abortSignal, timeout]);
    try {
      const stream = opts.provider.generate({
        role: opts.role,
        system,
        messages: [...messages],
        tools: prepared.tools,
        effort: opts.effort,
        maxOutputTokens: opts.maxOutputTokens,
        abortSignal: signal,
        budget: opts.budget,
        ...(opts.model ? { model: opts.model } : {}),
      });
      for await (const ev of stream as AsyncIterable<GenerateEvent>) {
        if (signal.aborted) throw abortError();
        switch (ev.type) {
          case "route":
            provider = ev.provider;
            model = ev.model;
            emit({ type: "route", turn, provider: ev.provider, model: ev.model, attempt: ev.attempt });
            break;
          case "text-delta":
            firstByteAt ??= now();
            text += ev.text;
            break;
          case "reasoning-delta":
            firstByteAt ??= now();
            break;
          case "tool-call":
            firstByteAt ??= now();
            nativeCalls.push({ id: ev.id, name: ev.name, args: ev.args });
            break;
          case "usage":
            usage.calls += 1;
            usage.input += ev.input;
            usage.output += ev.output;
            usage.costUsd += ev.costUsd;
            lastInputTokens = ev.input + ev.cachedInput;
            emit({
              type: "usage",
              turn,
              provider,
              model,
              input: ev.input,
              output: ev.output,
              cachedInput: ev.cachedInput,
              cacheWrite: ev.cacheWrite,
              costUsd: ev.costUsd,
              latencyMs: now() - started,
              ttftMs: firstByteAt === null ? null : firstByteAt - started,
            });
            break;
          case "finish":
            finish = ev.reason;
            break;
          case "provider-message":
            raw = ev.raw;
            hasRaw = true;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      if (ctx.abortSignal.aborted) return result("aborted", turn);
      const message = timeout.aborted ? `The model did not answer within ${Math.round((opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS) / 1000)} s.` : err instanceof Error ? err.message : String(err);
      emit({ type: "llm.error", turn, message, provider, model });
      return result("llm-error", turn, { error: err });
    }
    turnsSinceCompaction += 1;

    const calls = protocol.extractCalls(text, nativeCalls, turn);
    messages.push({
      role: "assistant",
      text,
      toolCalls: protocol.name === "native" ? calls : [],
      ...(hasRaw ? { native: { provider: provider ?? opts.provider.id, model: model ?? opts.model ?? "", raw } } : {}),
    });
    if (text.trim()) {
      lastText = text.trim();
      emit({ type: "text", turn, text: lastText });
    }

    if (calls.length === 0) {
      if (finish === "length") {
        emit({ type: "nudge", turn, reason: "output-limit" });
        messages.push({ role: "user", content: OUTPUT_LIMIT_TEXT });
        continue;
      }
      if (nudges < maxNudges) {
        nudges += 1;
        emit({ type: "nudge", turn, reason: "no-tool-call" });
        messages.push({ role: "user", content: nudgeText(opts.terminalTools) });
        continue;
      }
      return result("no-submit", turn);
    }

    // ── Tools ──
    const exchanges: ToolExchange[] = [];
    let submission: { tool: string; payload: unknown } | undefined;
    for (const call of calls) {
      if (submission) {
        exchanges.push({ call, content: `Not executed: the task already ended with ${submission.tool}.`, isError: true });
        continue;
      }
      const t0 = now();
      const tool = byName.get(call.name);
      if (!tool) {
        const content = `UNKNOWN_TOOL: there is no tool named "${call.name}". Available: ${[...byName.keys()].join(", ")}.`;
        exchanges.push({ call, content, isError: true });
        emit({ type: "tool.call", turn, id: call.id, name: call.name, argsSummary: "" });
        emit({ type: "tool.result", turn, id: call.id, name: call.name, ok: false, summary: "unknown tool", durationMs: 0 });
        continue;
      }
      const parsed = tool.input.safeParse(parseArgs(call.args));
      if (!parsed.success) {
        const content = `INVALID_ARGUMENTS for ${tool.name}; nothing was executed. Fix these and call it again:\n${issuesText(parsed.error)}`;
        exchanges.push({ call, content, isError: true });
        emit({ type: "tool.call", turn, id: call.id, name: tool.name, argsSummary: "(invalid arguments)" });
        emit({ type: "tool.result", turn, id: call.id, name: tool.name, ok: false, summary: "invalid arguments", durationMs: 0 });
        continue;
      }
      let argsSummary = "";
      try {
        argsSummary = ctx.redact(tool.summarize?.(parsed.data) ?? "").slice(0, 300);
      } catch {
        argsSummary = "";
      }
      emit({ type: "tool.call", turn, id: call.id, name: tool.name, argsSummary });
      let okResult: boolean;
      let content: string;
      let summary: string;
      try {
        const r = await tool.execute(parsed.data, ctx);
        okResult = r.ok;
        content = ctx.redact(r.content);
        summary = ctx.redact(r.summary ?? (r.ok ? "ok" : content.split("\n")[0] ?? "error")).slice(0, 300);
      } catch (err) {
        if (ctx.abortSignal.aborted) return result("aborted", turn);
        okResult = false;
        content = ctx.redact(`TOOL_ERROR: ${tool.name} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        summary = content.slice(0, 300);
      }
      exchanges.push({ call, content, isError: !okResult });
      emit({ type: "tool.result", turn, id: call.id, name: tool.name, ok: okResult, summary, durationMs: now() - t0 });
      if (tool.kind === "submit" && okResult) {
        const terminal = opts.terminalTools.includes(tool.name);
        emit({ type: "submitted", turn, name: tool.name, payload: parsed.data, terminal });
        if (terminal) submission = { tool: tool.name, payload: parsed.data };
      }
    }
    messages.push(...protocol.resultMessages(exchanges));
    if (submission) return result("submitted", turn, { submission });
  }
  return result("max-turns", opts.maxTurns);
}

/**
 * Compaction: `[first user message + summary]` + the last assistant turn and what
 * follows it. Without a compactor, old tool outputs are elided in place (structure kept).
 * Returns null when there is nothing worth compacting.
 */
export async function compactMessages(messages: AgentMessage[], compact: Compactor | undefined, abortSignal: AbortSignal): Promise<AgentMessage[] | null> {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  const first = messages[0];
  if (lastAssistant <= 1 || !first || first.role !== "user") return null;
  const older = messages.slice(1, lastAssistant);
  if (older.length < 2) return null;
  const tail = messages.slice(lastAssistant);
  if (compact) {
    const summary = (await compact(older, abortSignal)).trim();
    if (!summary) return null;
    const firstText = typeof first.content === "string" ? first.content : first.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return [{ role: "user", content: `${firstText}\n\n[context summary]\n${summary}` }, ...tail];
  }
  const elided = older.map((m): AgentMessage => (m.role === "tool" && m.content.length > 400 ? { ...m, content: `[elided to save context: ${m.content.length} characters; re-run the tool if you need it again]` } : m));
  return [first, ...elided, ...tail];
}
