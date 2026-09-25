/**
 * scriptedProvider: a deterministic in-memory provider for unit tests.
 *
 * What this file protects: tests of the agent loop can script turn-by-turn answers
 * without touching disk or network, and can assert on the exact requests received
 * (`calls`). A script function gets the 0-based call index to model multi-turn loops.
 */
import type { GenerateEvent, GenerateRequest, Provider } from "../types.js";

export type Script = GenerateEvent[] | ((req: GenerateRequest, callIndex: number) => GenerateEvent[]);

export interface ScriptedProvider extends Provider {
  readonly calls: GenerateRequest[];
}

export function scriptedProvider(script: Script, id = "scripted"): ScriptedProvider {
  const calls: GenerateRequest[] = [];
  return {
    id,
    calls,
    async *generate(req: GenerateRequest): AsyncGenerator<GenerateEvent> {
      const index = calls.length;
      calls.push(req);
      const events = typeof script === "function" ? script(req, index) : script;
      for (const ev of events) {
        if (req.abortSignal.aborted) {
          const err = new Error("generation aborted");
          err.name = "AbortError";
          throw err;
        }
        yield ev;
      }
    },
  };
}

/** Convenience: a text answer that finishes with `stop` and reports zero usage. */
export function textTurn(text: string): GenerateEvent[] {
  return [
    { type: "text-delta", text },
    { type: "usage", input: 0, output: 0, cachedInput: 0, cacheWrite: 0, costUsd: 0 },
    { type: "finish", reason: "stop" },
  ];
}

/** Convenience: a single tool call that finishes with `tool-calls`. */
export function toolCallTurn(id: string, name: string, args: unknown): GenerateEvent[] {
  return [
    { type: "tool-call", id, name, args },
    { type: "usage", input: 0, output: 0, cachedInput: 0, cacheWrite: 0, costUsd: 0 },
    { type: "finish", reason: "tool-calls" },
  ];
}

/** Drains a provider stream into an array (tests and simple callers). */
export async function collect(stream: AsyncIterable<GenerateEvent>): Promise<GenerateEvent[]> {
  const out: GenerateEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}
