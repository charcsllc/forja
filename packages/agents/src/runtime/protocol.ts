/**
 * Tool protocols (docs/architecture/02 §5): how tools reach the model and how its calls
 * come back.
 *
 * - `native` (default, every phase-2 model): tools travel as provider tool definitions;
 *   results go back as `tool` messages paired by call id.
 * - `xml` (extension point, v1 only for local models without native tools): tools are
 *   described in a "Tool protocol" section of the system prompt; the model writes ONE
 *   `<tool name="…">{json args}</tool>` block per turn; results go back as a `user`
 *   message of `<tool_result>` blocks. The loop is identical for both.
 *
 * What this protects: the agent loop never branches on the protocol; it asks the protocol
 * object to prepare the request, extract calls and shape results.
 */
import type { AgentMessage, ToolCall, ToolDefinition } from "@forja/llm";
import type { AnyTool } from "../tools/types.js";
import { toJsonSchema } from "../tools/json-schema.js";

export type ToolProtocolName = "native" | "xml";

export interface ToolExchange {
  call: ToolCall;
  content: string;
  isError: boolean;
}

export interface ToolProtocol {
  readonly name: ToolProtocolName;
  /** System prompt addition and the tool definitions for the request. */
  prepare(tools: readonly AnyTool[]): { systemSuffix: string; tools: ToolDefinition[] };
  /** Tool calls of one assistant turn (native events and/or its text). */
  extractCalls(text: string, nativeCalls: ToolCall[], turn: number): ToolCall[];
  /** Messages that carry the results back. */
  resultMessages(exchanges: ToolExchange[]): AgentMessage[];
}

export function toToolDefinition(tool: AnyTool): ToolDefinition {
  return { name: tool.name, description: tool.description, inputSchema: toJsonSchema(tool.input) };
}

export const nativeProtocol: ToolProtocol = {
  name: "native",
  prepare: (tools) => ({ systemSuffix: "", tools: tools.map(toToolDefinition) }),
  extractCalls: (_text, nativeCalls) => nativeCalls,
  resultMessages: (exchanges) =>
    exchanges.map((x) => ({ role: "tool" as const, toolCallId: x.call.id, name: x.call.name, content: x.content, isError: x.isError })),
};

const XML_CALL = /<tool\s+name\s*=\s*"([a-z][a-z0-9_]{0,63})"\s*>([\s\S]*?)<\/tool>/;

export const xmlProtocol: ToolProtocol = {
  name: "xml",
  prepare(tools) {
    const lines = [
      "",
      "## Tool protocol",
      "",
      "You call tools by writing exactly one block per turn, and nothing after it:",
      "",
      '<tool name="TOOL_NAME">{"arg": "value"}</tool>',
      "",
      "The body is a JSON object that matches the tool's schema. The result comes back in the next message inside <tool_result name=\"TOOL_NAME\">…</tool_result>. Available tools:",
      "",
      ...tools.map((t) => `### ${t.name}\n${t.description}\nSchema: ${JSON.stringify(toJsonSchema(t.input))}\n`),
    ];
    return { systemSuffix: lines.join("\n"), tools: [] };
  },
  extractCalls(text, nativeCalls, turn) {
    if (nativeCalls.length > 0) return nativeCalls;
    const m = XML_CALL.exec(text);
    if (!m) return [];
    const body = (m[2] ?? "").trim();
    let args: unknown = body;
    try {
      args = body ? JSON.parse(body) : {};
    } catch {
      // Left as a string: argument validation reports it to the model.
    }
    return [{ id: `xml-${turn}`, name: m[1] ?? "", args }];
  },
  resultMessages(exchanges) {
    if (exchanges.length === 0) return [];
    const content = exchanges
      .map((x) => `<tool_result name="${x.call.name}"${x.isError ? ' error="true"' : ""}>\n${x.content}\n</tool_result>`)
      .join("\n");
    return [{ role: "user", content }];
  },
};

export function protocolFor(name: ToolProtocolName): ToolProtocol {
  return name === "xml" ? xmlProtocol : nativeProtocol;
}
