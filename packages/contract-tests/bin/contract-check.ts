/**
 * contract-check: runs the UI-polling simulators against a live v1 backend and prints a
 * PASS/FAIL table (exit 1 on any violation). For phase 1+ and CI against a LOCAL engine.
 *
 *   FORJA_ENGINE_URL=http://localhost:4000 FORJA_ENGINE_KEY=… \
 *     npx tsx bin/contract-check.ts --project demo --sims deploy,rebuild [--version v1] [--json] [--yes]
 *
 * What this file protects: every simulator MUTATES the target (runs spend LLM budget,
 * deploys publish, restores rewrite history). It therefore refuses Totalum hosts outright
 * (AGENTS.md: never test against real projects) and refuses to run without `--yes`.
 */
import { createClient } from "../src/client.js";
import {
  formatResultsTable,
  simulateAgentStart,
  simulateDeploy,
  simulateGithubPull,
  simulateLaunch,
  simulateRebuild,
  simulateRestart,
  simulateRestore,
  simulateWake,
  type SimOptions,
  type SimulationResult,
} from "../src/simulator.js";

const ALL = ["launch", "agentStart", "deploy", "rebuild", "restart", "restore", "githubPull", "wake"] as const;
type SimName = (typeof ALL)[number];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<number> {
  const baseUrl = process.env.FORJA_ENGINE_URL;
  if (!baseUrl) {
    console.error("FORJA_ENGINE_URL is not set");
    return 2;
  }
  const host = new URL(baseUrl).hostname;
  if (/(^|\.)totalum\.app$/i.test(host)) {
    console.error(`refusing to run mutating contract checks against ${host}`);
    return 2;
  }
  if (!flag("yes")) {
    console.error("these checks mutate the target (runs, deploys, restores). Re-run with --yes against a disposable engine.");
    return 2;
  }
  const project = arg("project") ?? "contract-check";
  const version = arg("version");
  const sims = (arg("sims")?.split(",") ?? [...ALL]) as SimName[];
  const unknown = sims.filter((s) => !(ALL as readonly string[]).includes(s));
  if (unknown.length > 0) {
    console.error(`unknown simulators: ${unknown.join(", ")}; known: ${ALL.join(", ")}`);
    return 2;
  }
  const opts: SimOptions = {
    intervalMs: arg("interval-ms") ? Number(arg("interval-ms")) : undefined,
    maxAttempts: arg("max-attempts") ? Number(arg("max-attempts")) : undefined,
  };
  const client = createClient();
  const results: SimulationResult[] = [];
  let target = project;

  for (const sim of sims) {
    switch (sim) {
      case "launch": {
        const r = await simulateLaunch(client, { projectId: project, prompt: "A one-page site for a bakery with a contact form." }, opts);
        target = r.projectId;
        results.push(r);
        break;
      }
      case "agentStart":
        results.push(await simulateAgentStart(client, target, "Make the primary button blue.", opts));
        break;
      case "deploy":
        results.push(await simulateDeploy(client, target, opts));
        break;
      case "rebuild":
        results.push(await simulateRebuild(client, target, opts));
        break;
      case "restart":
        results.push(await simulateRestart(client, target, opts));
        break;
      case "restore":
        if (!version) {
          console.error("skipping restore: pass --version <versionId>");
          break;
        }
        results.push(await simulateRestore(client, target, version, opts));
        break;
      case "githubPull":
        results.push(await simulateGithubPull(client, target, opts));
        break;
      case "wake":
        results.push(await simulateWake(client, target, opts));
        break;
    }
  }

  console.log(flag("json") ? JSON.stringify(results, null, 2) : formatResultsTable(results));
  for (const r of results) for (const v of r.violations) console.log(`  ${r.simulator}: ${v.code} — ${v.message}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
