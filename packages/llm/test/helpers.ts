/**
 * Test helpers: a scripted `fetch` that replays SSE bodies (never touches the network),
 * a request builder and the NVIDIA fixtures.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequirements } from "../src/gateway/types.js";
import type { AgentRole, GenerateRequest } from "../src/types.js";

export const FIXTURES = fileURLToPath(new URL("./fixtures/nvidia/", import.meta.url));
export const fixtureText = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
export const fixtureJson = <T = Record<string, unknown>>(name: string): T => JSON.parse(fixtureText(name)) as T;

export interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export type FetchHandler = (call: RecordedCall, index: number) => Response | Promise<Response>;

export function fakeFetch(handler: FetchHandler): typeof fetch & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call: RecordedCall = {
      url: String(input),
      init,
      body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
      headers: { ...(init.headers as Record<string, string>) },
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch & { calls: RecordedCall[] };
  fn.calls = calls;
  return fn;
}

const enc = new TextEncoder();

/** A 200 SSE response whose body arrives in exactly these chunks. */
export function sseResponse(chunks: Array<string | Uint8Array>, init: ResponseInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? enc.encode(c) : c);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

/** Splits bytes into fixed-size chunks (cuts through lines, `\r\n` and UTF-8 sequences). */
export function chunkBytes(text: string, size: number): Uint8Array[] {
  const bytes = enc.encode(text);
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

/** An SSE body from chunk objects (`data: <json>\n\n` each) plus `[DONE]`. */
export function sseBody(chunks: unknown[], done = true): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
}

export function delta(d: Record<string, unknown>, finish: string | null = null): unknown {
  return { choices: [{ index: 0, delta: d, finish_reason: finish }] };
}

export function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    role: "frontend",
    system: "You are a coding agent. Use tools when needed. Be brief.",
    messages: [{ role: "user", content: "Read the file src/app/page.tsx using the tool." }],
    tools: [
      {
        name: "read_file",
        description: "Read a file from the project",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      },
    ],
    maxOutputTokens: 1024,
    abortSignal: new AbortController().signal,
    budget: { remainingUsd: () => 1, charge: () => undefined },
    ...overrides,
  };
}

/** Plausible role requirements (the real ones are declared in @forja/agents). */
const IMPLEMENTER: ModelRequirements = { capabilities: ["nativeTools"], minContextTokens: 100_000, preferredTier: "strong" };
export const REQUIREMENTS: Partial<Record<AgentRole, ModelRequirements>> = {
  director: { capabilities: ["nativeTools"], minContextTokens: 100_000, preferredTier: "frontier" },
  database: IMPLEMENTER,
  backend: IMPLEMENTER,
  frontend: IMPLEMENTER,
  fixer: { capabilities: ["nativeTools"], minContextTokens: 32_000, preferredTier: "fast" },
  summarizer: { capabilities: [], minContextTokens: 64_000, preferredTier: "fast" },
  reviewer: { capabilities: ["nativeTools"], minContextTokens: 100_000, preferredTier: "frontier", differentFamilyThan: ["frontend", "backend"] },
  designer: { capabilities: ["nativeTools", "vision"], minContextTokens: 64_000, preferredTier: "frontier" },
};

