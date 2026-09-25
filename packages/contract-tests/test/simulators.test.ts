/**
 * Proves the simulator both ways against the in-process fake: every simulator passes on a
 * correct server, and each deliberately broken transition is reported with its code.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createClient, type V1Client } from "../src/client.js";
import {
  simulateAgentStart,
  simulateDeploy,
  simulateGithubPull,
  simulateLaunch,
  simulateRebuild,
  simulateRestart,
  simulateRestore,
  simulateWake,
  formatResultsTable,
  type SimOptions,
  type SimulationResult,
  type ViolationCode,
} from "../src/simulator.js";
import { startFakeServer, type FakeServer, type FakeServerOptions } from "./fake-server.js";

const FAST: SimOptions = { intervalMs: 5, fastIntervalMs: 2, maxAttempts: 20, capMs: 50 };

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function setup(opts: FakeServerOptions = {}): Promise<V1Client> {
  server = await startFakeServer(opts);
  return createClient({ baseUrl: server.url, apiKey: server.apiKey, env: {} });
}

function codes(r: SimulationResult): ViolationCode[] {
  return r.violations.map((v) => v.code);
}

function expectPass(r: SimulationResult): void {
  expect(r.violations, formatResultsTable([r])).toEqual([]);
  expect(r.ok).toBe(true);
}

describe("happy paths against a correct server", () => {
  it("agent/start: init synchronously, stable keys, finished at the end", async () => {
    const c = await setup();
    const r = await simulateAgentStart(c, "demo", "make the button blue", FAST);
    expectPass(r);
    expect(r.outcome).toBe("done");
    expect(r.details.sawInit).toBe(true);
    expect(r.details.finalMessageType).toBe("finished");
  });

  it("deploy: deploying then success, hostname without scheme", async () => {
    const c = await setup();
    const r = await simulateDeploy(c, "demo", FAST);
    expectPass(r);
    expect(r.outcome).toBe("success");
  });

  it("rebuild: rebuilding then success", async () => {
    const r = await simulateRebuild(await setup(), "demo", FAST);
    expectPass(r);
    expect(r.outcome).toBe("success");
  });

  it("restart: leaves Active synchronously, then Active again", async () => {
    const r = await simulateRestart(await setup(), "demo", FAST);
    expectPass(r);
    expect(r.outcome).toBe("active");
    expect(r.steps.some((s) => s.observed.includes("Starting"))).toBe(true);
  });

  it("restore: versionRecovery present synchronously, then cleared", async () => {
    const r = await simulateRestore(await setup(), "demo", "v1", FAST);
    expectPass(r);
    expect(r.outcome).toBe("restored");
  });

  it("github pull: pulling synchronously, then success", async () => {
    const r = await simulateGithubPull(await setup(), "demo", FAST);
    expectPass(r);
    expect(r.outcome).toBe("success");
  });

  it("wake: 409 SERVER_NOT_READY, then Active and live, then the action works", async () => {
    const r = await simulateWake(await setup(), "sleepy", FAST);
    expectPass(r);
    expect(r.outcome).toBe("awake");
  });

  it("wake on an awake server is a no-op with a warning", async () => {
    const r = await simulateWake(await setup(), "demo", FAST);
    expectPass(r);
    expect(r.outcome).toBe("not-asleep");
    expect(r.warnings).toHaveLength(1);
  });

  it("launch: navigates to data.projectId (suffixed when taken) and follows the run", async () => {
    const c = await setup();
    const r = await simulateLaunch(c, { projectId: "demo", prompt: "a bakery site" }, FAST);
    expectPass(r);
    expect(r.projectId).toBe("demo-2");
    expect(r.details.navigatedTo).toBe("/project/demo-2");
    expect(r.outcome).toBe("done");
  });

  it("launch with agent.started=false: the workspace sends the stashed prompt", async () => {
    const c = await setup({ launchDoesNotStart: true });
    const r = await simulateLaunch(c, { projectId: "fresh", prompt: "a bakery site" }, FAST);
    expectPass(r);
    expect(r.details.sentPendingPrompt).toBe(true);
    expect(r.outcome).toBe("done");
  });
});

describe("each broken transition is caught", () => {
  it("run answers done on the first poll after start", async () => {
    const r = await simulateAgentStart(await setup({ flaws: { runInitAsync: true } }), "demo", "x", FAST);
    expect(codes(r)).toContain("INIT_NOT_SYNCHRONOUS");
    expect(r.ok).toBe(false);
  });

  it("realtime createdAt changes between polls", async () => {
    const r = await simulateAgentStart(await setup({ flaws: { runUnstableCreatedAt: true }, ticks: 4 }), "demo", "x", FAST);
    expect(codes(r)).toContain("UNSTABLE_CREATED_AT");
  });

  it("run ends without a finished|error|limit-reached message", async () => {
    const r = await simulateAgentStart(await setup({ flaws: { runNoTerminalMessage: true } }), "demo", "x", FAST);
    expect(codes(r)).toEqual(["NO_TERMINAL_MESSAGE"]);
  });

  it("deploy reports the previous publish's success first", async () => {
    const r = await simulateDeploy(await setup({ flaws: { deployStale: true } }), "demo", FAST);
    expect(codes(r)).toContain("DEPLOY_NOT_SYNCHRONOUS");
    expect(r.outcome).toBe("success"); // what the UI would (wrongly) conclude
  });

  it("rebuild answers idle first", async () => {
    const r = await simulateRebuild(await setup({ flaws: { rebuildIdleFirst: true } }), "demo", FAST);
    expect(codes(r)).toEqual(["REBUILD_NOT_SYNCHRONOUS"]);
  });

  it("restart still shows Active on the first read", async () => {
    const r = await simulateRestart(await setup({ flaws: { restartStaysActive: true } }), "demo", FAST);
    expect(codes(r)).toEqual(["RESTART_STILL_ACTIVE"]);
  });

  it("restore sets versionRecovery asynchronously", async () => {
    const r = await simulateRestore(await setup({ flaws: { restoreAsync: true } }), "demo", "v1", FAST);
    expect(codes(r)).toEqual(["RESTORE_NOT_SYNCHRONOUS"]);
  });

  it("pull-status is null right after pull", async () => {
    const r = await simulateGithubPull(await setup({ flaws: { pullAsync: true } }), "demo", FAST);
    expect(codes(r)).toEqual(["PULL_NOT_SYNCHRONOUS"]);
  });

  it("woken server keeps serving the cached snapshot past the estimate", async () => {
    const r = await simulateWake(await setup({ flaws: { wakeNeverLive: true } }), "sleepy", FAST);
    expect(codes(r)).toEqual(["WAKE_EXCEEDED_ESTIMATE"]);
    expect(r.outcome).toBe("overrun");
  });

  it("launch returns the requested id instead of the created one", async () => {
    const r = await simulateLaunch(await setup({ flaws: { launchWrongId: true } }), { projectId: "shop", prompt: "a shop" }, FAST);
    expect(codes(r)).toEqual(["PROJECT_ID_NOT_AUTHORITATIVE"]);
  });

  it("a run that never ends times out instead of hanging", async () => {
    const r = await simulateAgentStart(await setup({ ticks: 1000 }), "demo", "x", { ...FAST, maxAttempts: 5 });
    expect(codes(r)).toEqual(["POLL_TIMEOUT"]);
  });
});

describe("formatResultsTable", () => {
  it("renders one row per result", async () => {
    const c = await setup({ flaws: { rebuildIdleFirst: true } });
    const table = formatResultsTable([await simulateDeploy(c, "demo", FAST), await simulateRebuild(c, "demo", FAST)]);
    expect(table).toMatch(/deploy\s+demo\s+success\s+PASS/);
    expect(table).toMatch(/rebuild\s+demo\s+success\s+FAIL\s+\d+\s+REBUILD_NOT_SYNCHRONOUS/);
  });
});
