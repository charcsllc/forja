/**
 * The replay provider: record real generations once, replay them in tests for free.
 *
 * Modes:
 * - `record`: always call `inner`, stream its events through, save them on a clean finish.
 * - `replay`: serve a recording on hit; on miss call `inner` and record (if given), else fail.
 * - `replay-or-fail` (CI): serve a recording or throw `ReplayMissError`. Never calls `inner`,
 *   so a CI run can never spend money even if a key is configured.
 *
 * What this file protects: a stream that errors or is aborted is NOT saved (a partial
 * recording would replay as a truncated answer forever), and replay honours `abortSignal`.
 */
import type { GenerateEvent, GenerateRequest, Provider } from "../types.js";
import { keyMaterial, replayKey } from "./canonical.js";
import { RecordingStore, type NearestKey } from "./store.js";

export type ReplayMode = "record" | "replay" | "replay-or-fail";

export interface ReplayProviderOptions {
  dir: string;
  mode: ReplayMode;
  inner?: Provider;
}

export class ReplayMissError extends Error {
  constructor(
    readonly key: string,
    readonly dir: string,
    readonly nearest: NearestKey[],
  ) {
    const lines = [
      `No LLM recording for key ${key} in ${dir} (mode replay-or-fail).`,
      nearest.length === 0
        ? "The store is empty."
        : "Nearest recordings:\n" + nearest.map((n) => `  - ${n.key}: differs in ${n.differs.join(", ") || "nothing (hash recipe changed?)"}`).join("\n"),
      "If the prompt or tools changed on purpose, re-record with mode \"record\" and a real provider.",
    ];
    super(lines.join("\n"));
    this.name = "ReplayMissError";
  }
}

function abortError(): Error {
  const err = new Error("generation aborted");
  err.name = "AbortError";
  return err;
}

export function createReplayProvider(opts: ReplayProviderOptions): Provider & { store: RecordingStore } {
  const store = new RecordingStore(opts.dir);

  async function* recordThrough(req: GenerateRequest, key: string): AsyncGenerator<GenerateEvent> {
    if (!opts.inner) throw new Error(`replay provider in mode "${opts.mode}" needs an inner provider to record key ${key}`);
    const events: GenerateEvent[] = [];
    for await (const ev of opts.inner.generate(req)) {
      events.push(ev);
      yield ev;
    }
    if (req.abortSignal.aborted) return;
    await store.put({ key, request: keyMaterial(req), events });
  }

  async function* generate(req: GenerateRequest): AsyncGenerator<GenerateEvent> {
    const material = keyMaterial(req);
    const key = replayKey(material);
    if (opts.mode === "record") {
      yield* recordThrough(req, key);
      return;
    }
    const rec = await store.get(key);
    if (!rec) {
      if (opts.mode === "replay" && opts.inner) {
        yield* recordThrough(req, key);
        return;
      }
      throw new ReplayMissError(key, opts.dir, await store.nearest(material));
    }
    for (const ev of rec.events) {
      if (req.abortSignal.aborted) throw abortError();
      yield ev;
    }
  }

  return { id: `replay${opts.inner ? `(${opts.inner.id})` : ""}`, store, generate };
}
