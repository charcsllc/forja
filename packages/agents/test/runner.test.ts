/**
 * Runner tests. Protects: golden answers pass every case, a do-nothing executor fails
 * every case, each check kind reports what went wrong, and failures never crash the run.
 */
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CASES } from "../src/eval/cases/index.js";
import { fakeExecutor, noopExecutor, runEvals } from "../src/eval/runner.js";
import { AGENT_ROLES, type EvalCase, type ExecuteTask } from "../src/eval/types.js";
import { changedPaths, materialize, safeJoin, writeFiles } from "../src/eval/workdir.js";

const base: EvalCase = {
  role: "fixer",
  id: "t",
  title: "t",
  input: { task: "t", files: { "a.ts": "import { x } from './x';\n", "b.ts": "b" } },
  expect: {},
};

function withGolden(c: EvalCase, files: Record<string, string>, status: "done" | "partial" = "done"): EvalCase {
  return { ...c, golden: { files, report: { status } } };
}

describe("golden set", () => {
  it("has exactly one case per role and unique ids", () => {
    expect(CASES.map((c) => c.role).sort()).toEqual([...AGENT_ROLES].sort());
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it("every golden answer passes its own case", async () => {
    const run = await runEvals({ cases: CASES, executeTask: fakeExecutor });
    expect(run.failed, run.table).toBe(0);
    expect(run.passed).toBe(15);
  });

  it("a do-nothing executor fails every case", async () => {
    const run = await runEvals({ cases: CASES, executeTask: noopExecutor });
    expect(run.results.filter((r) => r.passed).map((r) => r.id)).toEqual([]);
  });

  it("filters by role", async () => {
    const run = await runEvals({ role: "director", cases: CASES, executeTask: fakeExecutor });
    expect(run.results.map((r) => r.id)).toEqual(["director-intent-tweak"]);
    expect(JSON.parse(run.json)).toMatchObject({ role: "director", passed: 1, failed: 0 });
  });
});

describe("checks", () => {
  it("filesChanged, filesContain and filesExclude", async () => {
    const c: EvalCase = {
      ...base,
      expect: {
        filesChanged: ["a.ts", "c.ts"],
        filesContain: [{ path: "a.ts", includes: ["export", "zzz"] }, { path: "missing.ts", includes: ["x"] }],
        filesExclude: [{ path: "a.ts", excludes: ["import"] }],
      },
    };
    const run = await runEvals({ cases: [withGolden(c, { "a.ts": "export const a = 1; import 'y';\n" })], executeTask: fakeExecutor });
    const failed = Object.fromEntries(run.results[0]!.checks.filter((k) => !k.ok).map((k) => [k.name, k.notes]));
    expect(failed).toEqual({
      "changed:c.ts": "not created or modified",
      "contains:a.ts": 'missing "zzz"',
      "contains:missing.ts": "file missing",
      "excludes:a.ts": 'still has "import"',
    });
  });

  it("strictScope reports changes outside filesChanged, including deletions", async () => {
    const c: EvalCase = { ...base, expect: { filesChanged: ["a.ts"], strictScope: true } };
    const exec: ExecuteTask = async () => {
      const wd = await materialize({ "a.ts": "changed" });
      await writeFiles(wd, { "extra.ts": "x" });
      return { report: { status: "done" }, workdir: wd };
    };
    const run = await runEvals({ cases: [c], executeTask: exec });
    expect(run.results[0]!.checks.find((k) => k.name === "strictScope")?.notes).toBe("unexpected changes: b.ts, extra.ts");
  });

  it("reportStatus and customCheck (which receives the report)", async () => {
    const c: EvalCase = {
      ...base,
      expect: {
        reportStatus: "done",
        customCheck: async (_wd, report) => ({ ok: report.summary === "yes", notes: `summary=${report.summary}` }),
      },
    };
    const run = await runEvals({ cases: [withGolden(c, {}, "partial")], executeTask: fakeExecutor });
    expect(run.results[0]!.checks.map((k) => [k.name, k.ok])).toEqual([["reportStatus", false], ["customCheck", false]]);
  });

  it("an executor or check that throws fails the case, not the run", async () => {
    const boom: ExecuteTask = async () => {
      throw new Error("runtime crashed");
    };
    const throwing: EvalCase = { ...base, id: "t2", expect: { customCheck: async () => { throw new Error("bad check"); } } };
    const run = await runEvals({ cases: [base, withGolden(throwing, {})], executeTask: async (c) => (c.id === "t" ? boom(c) : fakeExecutor(c)) });
    expect(run.results.map((r) => r.passed)).toEqual([false, false]);
    expect(run.results[0]!.error).toBe("runtime crashed");
    expect(run.results[1]!.checks[0]!.notes).toBe("threw: bad check");
    expect(run.table).toMatch(/0\/2 passed/);
  });

  it("a case with no expectations fails instead of passing vacuously", async () => {
    const run = await runEvals({ cases: [withGolden(base, {})], executeTask: fakeExecutor });
    expect(run.results[0]!.checks).toEqual([{ name: "hasChecks", ok: false, notes: "case declares no expectations" }]);
  });

  it("cleans up workdirs by default", async () => {
    let wd = "";
    const exec: ExecuteTask = async (c) => {
      const r = await fakeExecutor(c);
      wd = r.workdir;
      return r;
    };
    await runEvals({ cases: [CASES[0]!], executeTask: exec });
    expect(existsSync(wd)).toBe(false);
  });
});

describe("workdir", () => {
  it("refuses paths that escape the workdir", () => {
    expect(() => safeJoin("/tmp/x", "../etc/passwd")).toThrow(/escapes/);
    expect(() => safeJoin("/tmp/x", "/etc/passwd")).toThrow(/escapes/);
    expect(safeJoin("/tmp/x", "a/../b.ts")).toBe("/tmp/x/b.ts");
  });

  it("changedPaths sees creations, edits and deletions", () => {
    expect(changedPaths({ a: "1", b: "2", c: "3" }, new Map([["a", "1"], ["b", "x"], ["d", "4"]]))).toEqual(["b", "c", "d"]);
  });
});
