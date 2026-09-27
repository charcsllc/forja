/**
 * The eval runner: execute each case through an injected executor, then apply the case's
 * automatic checks and report a table plus JSON.
 *
 * What this file protects: a case fails loudly and never crashes the run (an executor
 * throw, a missing file or a throwing customCheck each become a failed check), and the
 * executor is injected so phase 0 can test the runner with `fakeExecutor` while phase 2
 * plugs in the real agent runtime without touching the checks.
 */
import { rm } from "node:fs/promises";
import type { AgentRole, CaseResult, EvalCase, EvalRunResult, ExecuteTask } from "./types.js";
import { changedPaths, materialize, readTree, writeFiles } from "./workdir.js";

export interface RunEvalsOptions {
  role?: AgentRole;
  cases: EvalCase[];
  executeTask: ExecuteTask;
  /** Delete each workdir after checking. Default true. */
  cleanup?: boolean;
}

async function runCase(c: EvalCase, executeTask: ExecuteTask, cleanup: boolean): Promise<CaseResult> {
  const t0 = Date.now();
  const checks: CaseResult["checks"] = [];
  const add = (name: string, ok: boolean, notes = "") => checks.push({ name, ok, notes });
  let workdir: string | undefined;
  try {
    const { report, workdir: wd } = await executeTask(c);
    workdir = wd;
    const tree = await readTree(wd);
    const changed = changedPaths(c.input.files, tree);
    const e = c.expect;

    if (e.reportStatus) add("reportStatus", report.status === e.reportStatus, `expected ${e.reportStatus}, got ${report.status}`);
    for (const path of e.filesChanged ?? []) add(`changed:${path}`, changed.includes(path), changed.includes(path) ? "" : "not created or modified");
    if (e.strictScope) {
      const allowed = new Set(e.filesChanged ?? []);
      const extra = changed.filter((p) => !allowed.has(p));
      add("strictScope", extra.length === 0, extra.length ? `unexpected changes: ${extra.join(", ")}` : "");
    }
    for (const { path, includes } of e.filesContain ?? []) {
      const content = tree.get(path);
      const missing = content === undefined ? includes : includes.filter((s) => !content.includes(s));
      add(`contains:${path}`, content !== undefined && missing.length === 0, content === undefined ? "file missing" : missing.length ? `missing ${missing.map((m) => JSON.stringify(m)).join(", ")}` : "");
    }
    for (const { path, excludes } of e.filesExclude ?? []) {
      const content = tree.get(path);
      const present = content === undefined ? [] : excludes.filter((s) => content.includes(s));
      add(`excludes:${path}`, content !== undefined && present.length === 0, content === undefined ? "file missing" : present.length ? `still has ${present.map((m) => JSON.stringify(m)).join(", ")}` : "");
    }
    if (e.customCheck) {
      try {
        const r = await e.customCheck(wd, report);
        add("customCheck", r.ok, r.notes);
      } catch (err) {
        add("customCheck", false, `threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (checks.length === 0) add("hasChecks", false, "case declares no expectations");
    return { role: c.role, id: c.id, title: c.title, passed: checks.every((k) => k.ok), checks, durationMs: Date.now() - t0 };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    add("execute", false, error);
    return { role: c.role, id: c.id, title: c.title, passed: false, checks, durationMs: Date.now() - t0, error };
  } finally {
    if (cleanup && workdir) await rm(workdir, { recursive: true, force: true });
  }
}

export function formatEvalTable(results: CaseResult[]): string {
  const header = ["role", "case", "result", "ms", "failed checks"];
  const rows = results.map((r) => [
    r.role,
    r.id,
    r.passed ? "PASS" : "FAIL",
    String(r.durationMs),
    r.checks.filter((k) => !k.ok).map((k) => (k.notes ? `${k.name} (${k.notes})` : k.name)).join("; "),
  ]);
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((row) => (row[i] ?? "").length)));
  const line = (row: string[]) => row.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const passed = results.filter((r) => r.passed).length;
  return [line(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line), "", `${passed}/${results.length} passed`].join("\n");
}

export async function runEvals(opts: RunEvalsOptions): Promise<EvalRunResult> {
  const cases = opts.role ? opts.cases.filter((c) => c.role === opts.role) : opts.cases;
  const results: CaseResult[] = [];
  for (const c of cases) results.push(await runCase(c, opts.executeTask, opts.cleanup ?? true));
  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    passed,
    failed: results.length - passed,
    table: formatEvalTable(results),
    json: JSON.stringify({ role: opts.role ?? null, passed, failed: results.length - passed, results }, null, 2),
  };
}

/**
 * Executor that "solves" each case with its golden answer: seed files + golden files,
 * golden report. Tests the runner and the cases' own consistency, not a model.
 */
export const fakeExecutor: ExecuteTask = async (c) => {
  if (!c.golden) throw new Error(`case ${c.id} has no golden answer`);
  const workdir = await materialize(c.input.files);
  await writeFiles(workdir, c.golden.files ?? {});
  return { report: c.golden.report, workdir };
};

/** Executor that does nothing: seed files untouched, `partial` report. Every case must fail it. */
export const noopExecutor: ExecuteTask = async (c) => ({
  report: { status: "partial", summary: "did nothing" },
  workdir: await materialize(c.input.files),
});
