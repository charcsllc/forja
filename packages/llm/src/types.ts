/**
 * The uniform generation contract (docs/architecture/02 §4). Types only.
 *
 * What this file protects: every provider adapter, the replay provider and the agent
 * runtime speak exactly these shapes, so the orchestrator never sees a provider quirk.
 * Assistant turns keep the provider's native message (`native`) so it can be echoed back
 * verbatim (thinking blocks, thought signatures, encrypted reasoning; invariant 1).
 */

// TODO(phase-0): switch AgentRole/Effort to @forja/contracts once it exports them.
export const AGENT_ROLES = [
  "director", "designer", "brand", "imagery", "copywriter", "database", "backend", "frontend",
  "supervisor", "qa", "reviewer", "security", "docs", "fixer", "summarizer",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Generic effort; each adapter translates it (02 §3). */
export type Effort = "low" | "medium" | "high" | "xhigh";

/** JSON Schema object as sent to the provider (derived from the tool's zod schema). */
export type JsonSchema = { [key: string]: unknown };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string /* base64 */ }
  | { type: "image-url"; url: string };

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export type AgentMessage =
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      /** Provider-native message, echoed back untouched on the next turn. */
      native?: { provider: string; model: string; raw: unknown };
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

/** Budget handle owned by the ledger (02 §6). Minimal surface for phase 0. */
export interface BudgetHandle {
  remainingUsd(): number;
  charge(costUsd: number): void;
}

export interface GenerateRequest {
  role: AgentRole;
  system: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  effort?: Effort;
  maxOutputTokens: number;
  abortSignal: AbortSignal;
  budget: BudgetHandle;
  /** Resolved `provider:model` chosen by the router. Part of the replay key. */
  model?: string;
}

export type FinishReason = "stop" | "tool-calls" | "length" | "refusal" | "error";

export type GenerateEvent =
  /**
   * Always the first event of a generation: which `provider`/`model` serves it. A later
   * `route` (higher `attempt`) only ever arrives before any other event of that attempt:
   * the previous attempt failed before producing output and the gateway retried or fell
   * back, so nothing already received has to be discarded.
   */
  | { type: "route"; provider: string; model: string; attempt: number }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call"; id: string; name: string; args: unknown }
  /** `input` excludes `cachedInput` (uncached prompt tokens only); `output` includes reasoning. */
  | { type: "usage"; input: number; output: number; cachedInput: number; cacheWrite: number; costUsd: number }
  | { type: "finish"; reason: FinishReason }
  | { type: "provider-message"; raw: unknown };

/** What every adapter (and the replay/scripted providers) implements. */
export interface Provider {
  readonly id: string;
  generate(req: GenerateRequest): AsyncIterable<GenerateEvent>;
}
