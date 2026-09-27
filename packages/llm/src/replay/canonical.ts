/**
 * Canonical serialisation and the replay key.
 *
 * What this file protects: the same logical request always hashes to the same key,
 * whatever the object key order, and fields that do not change the model's answer
 * (`abortSignal`, `budget`, `maxOutputTokens`, `role`) never enter the key. Changing the
 * key recipe invalidates every recording, so it is versioned (`REPLAY_KEY_VERSION`).
 */
import { createHash } from "node:crypto";
import type { GenerateRequest } from "../types.js";

export const REPLAY_KEY_VERSION = 1;

/** The part of a request that determines the answer. */
export interface ReplayKeyMaterial {
  system: string;
  messages: GenerateRequest["messages"];
  tools: GenerateRequest["tools"];
  effort: GenerateRequest["effort"] | null;
  model: string | null;
}

export function keyMaterial(req: Pick<GenerateRequest, "system" | "messages" | "tools" | "effort" | "model">): ReplayKeyMaterial {
  return {
    system: req.system,
    messages: req.messages,
    tools: req.tools,
    effort: req.effort ?? null,
    model: req.model ?? null,
  };
}

/** JSON with sorted object keys; `undefined` properties dropped (as JSON.stringify does). */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortDeep(v)));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined && typeof v !== "function") out[k] = sortDeep(v);
    }
    return out;
  }
  return value;
}

export function replayKey(material: ReplayKeyMaterial): string {
  return createHash("sha256")
    .update(canonicalStringify({ v: REPLAY_KEY_VERSION, ...material }))
    .digest("hex");
}
