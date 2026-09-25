/** Small helpers for golden cases. Protects: checks read files through the confined join. */
import { readFile } from "node:fs/promises";
import { safeJoin } from "../workdir.js";
import type { CheckResult } from "../types.js";

export async function readText(workdir: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(safeJoin(workdir, path), "utf8");
  } catch {
    return undefined;
  }
}

export function check(ok: boolean, failNotes: string, okNotes = ""): CheckResult {
  return { ok, notes: ok ? okNotes : failNotes };
}

/** Narrows an unknown `report.output` to a plain object. */
export function outputOf(output: unknown): Record<string, unknown> {
  return output !== null && typeof output === "object" && !Array.isArray(output) ? (output as Record<string, unknown>) : {};
}

export const NEXT_PAGE = `export default function Home() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-4xl font-semibold">Bakery Lumen</h1>
      <button className="rounded-md bg-neutral-900 px-4 py-2 text-white">Order now</button>
    </main>
  );
}
`;
