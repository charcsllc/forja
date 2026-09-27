/**
 * `npm run eval -- --role <role> [--json] [--executor fake|noop]`
 *
 * What this file protects: phase 0 has no agent runtime, so the only executors are the
 * harness's own (`fake` = golden answers, `noop` = does nothing). The banner says so, so
 * nobody mistakes a green fake run for a prompt that works. Phase 2 adds `--executor real`.
 */
import { CASES } from "./cases/index.js";
import { fakeExecutor, noopExecutor, runEvals } from "./runner.js";
import { AGENT_ROLES, type AgentRole } from "./types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<number> {
  const role = arg("role") ?? process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (role !== undefined && !(AGENT_ROLES as readonly string[]).includes(role)) {
    console.error(`unknown role "${role}"; roles: ${AGENT_ROLES.join(", ")}`);
    return 2;
  }
  const executorName = arg("executor") ?? "fake";
  const executor = executorName === "fake" ? fakeExecutor : executorName === "noop" ? noopExecutor : undefined;
  if (!executor) {
    console.error(`executor "${executorName}" is not available in phase 0 (fake | noop); the real runtime arrives in phase 2`);
    return 2;
  }
  const run = await runEvals({ role: role as AgentRole | undefined, cases: CASES, executeTask: executor });
  if (process.argv.includes("--json")) console.log(run.json);
  else {
    console.log(`agents:eval — executor: ${executorName} (phase 0: validates the harness and the cases, not a prompt)\n`);
    console.log(run.table);
  }
  return run.failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
