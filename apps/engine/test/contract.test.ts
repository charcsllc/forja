/**
 * The UI-polling simulators of packages/contract-tests, run in-process against the engine
 * with fake sandbox/repo and a queue that runs jobs asynchronously (as pg-boss does).
 * The same simulators run against a real engine in test/integration/run.ts.
 */
import { describe, expect, it } from "vitest";
import {
  createClient,
  simulateAgentStart,
  simulateLaunch,
  simulateRebuild,
  simulateRestart,
  simulateRestore,
  simulateWake,
  type SimulationResult,
} from "@forja/contract-tests";
import { ENGINE_KEY, activeProject, makeTestEngine, type TestEngine } from "./fakes.js";
import { scriptedTeam } from "./support/scripted-team.js";

const fast = { intervalMs: 20, maxAttempts: 200, capMs: 5_000 };

function clientFor(e: TestEngine) {
  return createClient({
    baseUrl: "http://engine.test",
    apiKey: ENGINE_KEY,
    fetch: ((url: string | URL, init?: RequestInit) => Promise.resolve(e.app.request(String(url), init))) as typeof fetch,
  });
}

const show = (r: SimulationResult) => JSON.stringify({ outcome: r.outcome, violations: r.violations }, null, 1);

describe("contract simulators (in-process)", () => {
  it("rebuild: no-op and real", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "sim-rebuild");
    e.queue.auto = true;
    const noop = await simulateRebuild(clientFor(e), id, fast);
    expect(noop.ok, show(noop)).toBe(true);
    expect(noop.outcome).toBe("success");
    await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "next.config.ts", content: "ZXhwb3J0IGRlZmF1bHQge30K", encoding: "base64" });
    const real = await simulateRebuild(clientFor(e), id, fast);
    expect(real.ok, show(real)).toBe(true);
    expect(real.outcome).toBe("success");
  });

  it("restart", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "sim-restart");
    e.queue.auto = true;
    const r = await simulateRestart(clientFor(e), id, fast);
    expect(r.ok, show(r)).toBe(true);
    expect(r.outcome).toBe("active");
  });

  it("restore", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "sim-restore");
    const v1 = (await e.json("GET", `/v1/projects/${id}/versions`)).body.data.versions[0]._id;
    await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "src/x.ts", content: "eA==", encoding: "base64" });
    e.queue.auto = true;
    const r = await simulateRestore(clientFor(e), id, v1, fast);
    expect(r.ok, show(r)).toBe(true);
    expect(r.outcome).toBe("restored");
  });

  it("wake", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "sim-wake");
    await e.call("POST", `/v2/projects/${id}/archive`);
    await e.queue.drain();
    e.queue.auto = true;
    const r = await simulateWake(clientFor(e), id, fast);
    expect(r.ok, show(r)).toBe(true);
    expect(r.outcome).toBe("awake");
  });

  it("launch with a scripted team: init before answering, a run to done, a terminal message", async () => {
    const llm = scriptedTeam();
    const e = makeTestEngine({ repo: "fake", llm });
    e.queue.auto = true;
    const r = await simulateLaunch(clientFor(e), { projectId: "sim-launch", prompt: "Add an about page" }, fast);
    expect(r.ok, show(r)).toBe(true);
    expect(r.outcome).toBe("done");
    expect(r.details.sentPendingPrompt).toBeUndefined();
    expect(r.details.finalMessageType).toBe("finished");
    expect(r.details.sawInit).toBe(true);
    // The page reached main through a merge, and the version carries the checks.
    const tree = (await e.json("GET", "/v1/projects/sim-launch/files/tree")).body.data.entries.map((x: { path: string }) => x.path);
    expect(tree).toContain("src/app/about/page.tsx");
    expect(e.store.versionRows.at(-1)?.checks).toMatchObject({ gates: [{ name: "typecheck", passed: true }, { name: "lint", passed: true }, { name: "build", passed: true }] });
  });

  it("agent/start with a scripted team", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam() });
    const id = await activeProject(e, "sim-start");
    e.queue.auto = true;
    const r = await simulateAgentStart(clientFor(e), id, "Add an about page", fast);
    expect(r.ok, show(r)).toBe(true);
    expect(r.outcome).toBe("done");
  });

  it("launch without a provider: agent.started=false and agent/start explains what to configure", async () => {
    const e = makeTestEngine({ repo: "fake" });
    e.queue.auto = true;
    const r = await simulateLaunch(clientFor(e), { projectId: "sim-nollm", prompt: "A bakery" }, { ...fast, waitForRun: false });
    expect(r.details.sentPendingPrompt).toBe(true);
    expect(r.outcome).toBe("start-failed");
    expect(r.violations.map((v) => v.code)).toEqual(["REQUEST_FAILED"]);
    expect(r.violations[0]?.message).toContain("NO_PROVIDER_ENABLED");
  });
});
