/**
 * Token estimation for the compaction trigger. Deliberately rough (4 characters per
 * token): the provider's own `usage.input` of the previous turn is preferred when known;
 * this only fills the gap between turns.
 */
import type { AgentMessage } from "@forja/llm";

export function estimateTokens(system: string, messages: readonly AgentMessage[]): number {
  let chars = system.length;
  for (const m of messages) {
    if (m.role === "user") chars += typeof m.content === "string" ? m.content.length : m.content.reduce((a, p) => a + (p.type === "text" ? p.text.length : 1000), 0);
    else if (m.role === "assistant") chars += m.text.length + m.toolCalls.reduce((a, c) => a + JSON.stringify(c.args ?? {}).length + c.name.length, 0);
    else chars += m.content.length;
  }
  return Math.ceil(chars / 4);
}
