/** @forja/agents/eval: golden-task harness (phase 0). */
export * from "./types.js";
export { fakeExecutor, formatEvalTable, noopExecutor, runEvals, type RunEvalsOptions } from "./runner.js";
export { changedPaths, materialize, readTree, safeJoin, writeFiles } from "./workdir.js";
export { CASES } from "./cases/index.js";
