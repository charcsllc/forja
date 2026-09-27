/**
 * RecordingStore: one JSON file per recorded generation, `<dir>/<key>.json`.
 *
 * What this file protects:
 * - Writes are atomic (temp file + rename), so an interrupted test never leaves a
 *   half-written recording that later replays as a truncated stream.
 * - The stored `request` is the key material, kept so a miss can explain itself
 *   (`nearest`) instead of printing an opaque hash.
 * - Recordings are test fixtures committed to the repo: they must never contain keys.
 *   Nothing here ever sees one (keys live in the adapters, not in requests).
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerateEvent } from "../types.js";
import { canonicalStringify, REPLAY_KEY_VERSION, type ReplayKeyMaterial } from "./canonical.js";

export interface Recording {
  version: number;
  key: string;
  recordedAt: string;
  request: ReplayKeyMaterial;
  events: GenerateEvent[];
}

export interface NearestKey {
  key: string;
  /** Fields of the key material that differ from the requested one. */
  differs: string[];
  /** Messages shared from the start with the request. */
  commonMessagePrefix: number;
}

export class RecordingStore {
  constructor(readonly dir: string) {}

  pathFor(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error(`invalid replay key: ${key}`);
    return join(this.dir, `${key}.json`);
  }

  async get(key: string): Promise<Recording | undefined> {
    let text: string;
    try {
      text = await readFile(this.pathFor(key), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const rec = JSON.parse(text) as Recording;
    if (rec.version !== REPLAY_KEY_VERSION) {
      throw new Error(`recording ${key} has version ${rec.version}, expected ${REPLAY_KEY_VERSION}; re-record it`);
    }
    return rec;
  }

  async put(rec: Omit<Recording, "version" | "recordedAt"> & { recordedAt?: string }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const full: Recording = { version: REPLAY_KEY_VERSION, recordedAt: rec.recordedAt ?? new Date().toISOString(), key: rec.key, request: rec.request, events: rec.events };
    const target = this.pathFor(rec.key);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(full, null, 2)}\n`, "utf8");
    await rename(tmp, target);
  }

  async list(): Promise<Recording[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: Recording[] = [];
    for (const name of names.sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const rec = await this.get(name.slice(0, -5));
      if (rec) out.push(rec);
    }
    return out;
  }

  /** The `limit` recordings closest to `material`, best first. */
  async nearest(material: ReplayKeyMaterial, limit = 3): Promise<NearestKey[]> {
    const recs = await this.list();
    const scored = recs.map((rec) => {
      const differs: string[] = [];
      for (const field of ["system", "tools", "effort", "model"] as const) {
        if (canonicalStringify(rec.request[field]) !== canonicalStringify(material[field])) differs.push(field);
      }
      let prefix = 0;
      const a = rec.request.messages;
      const b = material.messages;
      while (prefix < a.length && prefix < b.length && canonicalStringify(a[prefix]) === canonicalStringify(b[prefix])) prefix++;
      if (prefix !== a.length || a.length !== b.length) differs.push(`messages (recorded ${a.length}, requested ${b.length}, first ${prefix} equal)`);
      return { key: rec.key, differs, commonMessagePrefix: prefix, score: (4 - Math.min(differs.length, 4)) * 10_000 + prefix };
    });
    scored.sort((x, y) => y.score - x.score || x.key.localeCompare(y.key));
    return scored.slice(0, limit).map(({ key, differs, commonMessagePrefix }) => ({ key, differs, commonMessagePrefix }));
  }
}
