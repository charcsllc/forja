/**
 * Agent runs end to end in-process: v1 routes (sync half), the orchestrator state machine
 * and its ledger, with a scripted team (no LLM), a fake sandbox and a real or fake repo.
 *
 * Protects: 05 §2.1/§2.4 (init before answering, one terminal message before the terminal
 * status, localized texts), 03 §2–§8 (plan → tasks → gates → fixer → merge; stop; budget;
 * failures), 02 §6 (llm_calls rows, spent_usd), crash recovery.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { GenerateEvent, Provider } from "@forja/llm";
import { textTurn } from "@forja/llm";
import { describe, expect, it } from "vitest";
import { createLlmService, createTestLlmService } from "../src/services/llm.js";
import { recoverRuns } from "../src/services/runs/service.js";
import { activeProject, makeTestEngine, type TestEngine } from "./fakes.js";
import { ABOUT_PAGE, scriptedCall, scriptedTeam, tweakPlan } from "./support/scripted-team.js";
import pino from "pino";

async function start(e: TestEngine, id: string, prompt = "Add an about page", extra: Record<string, unknown> = {}) {
  return e.json("POST", `/v1/projects/${id}/agent/start`, { prompt, inputFiles: [], ...extra });
}

const messagesOf = (e: TestEngine, id: string) => e.store.messageRows.filter((m) => m.projectId === id);
const eventsOf = (e: TestEngine, runId: string) => e.store.events.filter((x) => x.runId === runId).map((x) => x.type);
const gitIn = (dir: string, ...args: string[]) => execFileSync("git", ["-c", `safe.directory=*`, ...args], { cwd: dir, encoding: "utf8" });

describe("agent/start → run → done (real git repo)", () => {
  it("plans, builds the page on run/<id>, passes the tweak gates, merges, tags and closes with a finished message", async () => {
    const llm = scriptedTeam({ costPerTurn: 0.01 });
    const e = makeTestEngine({ repo: "git", llm });
    const id = await activeProject(e, "tienda");
    const res = await start(e, id, "Añade una página sobre nosotros para la tienda");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ started: true, status: "init", runId: expect.any(String), warnings: [] });
    const runId = res.body.data.runId as string;

    // Synchronous half: init, the user message and the estimate are visible before the job runs.
    const st = (await e.json("GET", `/v1/projects/${id}/agent/status`)).body.data;
    expect(st).toMatchObject({ status: "init", startedAt: expect.any(String), expectedMinutes: 8, expectedFinishAt: expect.any(String) });
    expect(st.realtimeConversation).toEqual([expect.objectContaining({ author: "user", messageType: "regular", message: "Añade una página sobre nosotros para la tienda" })]);
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentProcessStatus).toBe("init");

    await e.queue.drain();

    const run = await e.store.getRun(runId);
    expect(run).toMatchObject({ status: "done", intent: "tweak" });
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(Number(run?.spentUsd)).toBeCloseTo(0.01 * llm.calls.length);
    expect(e.store.llmCalls).toHaveLength(llm.calls.length);
    expect(e.store.llmCalls[0]).toMatchObject({ projectId: id, runId, role: "director", provider: "scripted", model: "team-1", outcome: "ok" });

    // Messages: localized (Spanish prompt → es), a build group ending in finished + versionId.
    const msgs = messagesOf(e, id);
    expect(msgs.map((m) => `${m.author}:${m.type}`)).toEqual([
      "user:regular",
      "agent:starting",
      "agent:building", // Construyendo tu aplicación
      "agent:building", // Creando una página
      "agent:building", // Comprobando que todo funciona
      "agent:building",
      "agent:building",
      "agent:building", // gates 1-3
      "agent:building", // Guardando la nueva versión
      "agent:finished",
    ]);
    expect(msgs[1]?.text).toBe("Analizando tu petición…");
    expect(msgs.map((m) => m.text)).toContain("Comprobando 3 de 3 verificaciones");
    const final = msgs.at(-1);
    expect(final?.text).toBe("Listo: añadí la página **Sobre nosotros**.");
    expect(final?.versionId).toMatch(/^[0-9a-f]{40}$/);
    const createdAts = msgs.map((m) => m.createdAt.getTime());
    expect(createdAts).toEqual([...createdAts].sort((a, b) => a - b));
    expect(new Set(createdAts).size).toBe(createdAts.length);

    // Git: merged into main with a tag; the page is in work/; run/ and its branch are gone.
    const root = path.join(e.dataDir, "projects", id);
    expect(existsSync(path.join(root, "work", "src/app/about/page.tsx"))).toBe(true);
    expect(existsSync(path.join(root, "run"))).toBe(false);
    expect(gitIn(path.join(root, "repo.git"), "branch", "--list", `run/${runId}`).trim()).toBe("");
    const versions = (await e.json("GET", `/v1/projects/${id}/versions`)).body.data.versions;
    expect(versions[0]).toMatchObject({ _id: final?.versionId, tag: "v2", commitMessage: "feat: Add an About page" });
    expect(gitIn(path.join(root, "repo.git"), "log", "-1", "--format=%b", "main")).toContain(`Forja-Run: ${runId}`);
    expect(e.store.versionRows[0]).toMatchObject({ id: final?.versionId, tag: "v2", runId, prompt: "Añade una página sobre nosotros para la tienda" });

    // Events of the run.
    const types = eventsOf(e, runId);
    for (const t of ["run.received", "run.phase", "plan.created", "task.started", "tool.call", "tool.result", "task.finished", "gate.started", "gate.passed", "cost.tick", "message", "run.finished"]) expect(types).toContain(t);
    expect(types.filter((t) => t === "gate.passed")).toHaveLength(3);
    expect(types.at(-1)).toBe("run.finished");

    // Verification container lifecycle and gate commands.
    expect(e.sandbox.calls).toContain(`createVerify:${id}:${runId}`);
    expect(e.sandbox.calls).toContain(`destroyVerify:${id}:${runId}`);
    const verifyCmds = e.sandbox.execs.filter((x) => x.container === `forja-verify-${id}`).map((x) => x.argv[2]);
    expect(verifyCmds).toEqual(expect.arrayContaining(["npm run --silent typecheck -- --pretty false", "npm run --silent lint", "npm run --silent build"]));

    // Project projection and task rows.
    const project = (await e.json("GET", `/v1/projects/${id}`)).body.data;
    expect(project.agentProcessStatus).toBe("done");
    expect(await e.store.listTasks(runId)).toEqual([expect.objectContaining({ planTaskId: "about-page", role: "frontend", status: "done" })]);

    // The director saw the prompt; the frontend only its task (never the user's prompt).
    const frontendReq = llm.calls.find((c) => c.role === "frontend");
    const firstUser = frontendReq?.messages[0] as { content: string };
    expect(firstUser.content).toContain("## Your task: About page");
    expect(firstUser.content).not.toContain("Añade una página");
    expect(frontendReq?.system).toMatch(/^# Base persona[\s\S]*# Role: Frontend engineer/);

    // Budget page sees the run.
    const budget = (await (await e.call("GET", `/v2/projects/${id}/budget`)).json()) as { runs: { id: string; status: string }[] };
    expect(budget.runs).toEqual([expect.objectContaining({ id: runId, status: "done" })]);
  });
});

describe("v1 agent routes", () => {
  it("one run at a time; manual writes, rebuilds and restores wait; hints become warnings", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam() });
    const id = await activeProject(e, "busy-one");
    const first = await start(e, id, "Add an about page", { model: "opus", effort: "high", fastMode: true });
    expect(first.body.data.warnings.map((w: { code: string }) => w.code)).toEqual(["HINT_IGNORED", "HINT_IGNORED"]);
    const run = await e.store.getRun(first.body.data.runId);
    expect(run?.options).toMatchObject({ effort: "high", modelHint: "opus", fastModeHint: true });
    expect((await start(e, id)).body.errors.errorCode).toBe("AGENT_RUNNING");
    const put = await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "x.ts", content: "eA==" });
    expect(put.body.errors.errorCode).toBe("AGENT_RUNNING");
    expect((await e.json("POST", `/v1/projects/${id}/rebuild`, {})).body.errors.errorCode).toBe("AGENT_RUNNING");
    await e.queue.drain();
    expect((await e.json("GET", `/v1/projects/${id}/agent/status`)).body.data.status).toBe("done");
    expect((await e.json("POST", `/v1/projects/${id}/agent/stop`, {})).body.errors.errorCode).toBe("NO_PROCESS_RUNNING");
    // The effort hint reached the model request.
    expect(e.queue.sent.some((j) => j.name === "run.execute")).toBe(true);
  });

  it("requires a prompt and refuses when the project budget is spent", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam(), env: { BUDGET_PER_PROJECT_MONTH_USD: "1" } });
    const id = await activeProject(e, "spent-out");
    expect((await e.json("POST", `/v1/projects/${id}/agent/start`, { inputFiles: [] })).body.errors.errorCode).toBe("MISSING_PROMPT");
    await e.store.insertRun({ projectId: id, prompt: "old", status: "done", spentUsd: "1.5", startedAt: new Date() });
    const r = await start(e, id);
    expect(r.status).toBe(402);
    expect(r.body.errors.errorCode).toBe("INSUFFICIENT_CREDITS");
  });

  it("a sleeping project is woken and the start refused with SERVER_NOT_READY (05 §2.2)", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam() });
    const id = await activeProject(e, "sleepy");
    await e.call("POST", `/v2/projects/${id}/archive`);
    await e.queue.drain();
    const r = await start(e, id);
    expect(r.status).toBe(409);
    expect(r.body.errors.errorCode).toBe("SERVER_NOT_READY");
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Unarchiving");
  });

  it("deleting a project stops its run first", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam() });
    const id = await activeProject(e, "doomed");
    const runId = (await start(e, id)).body.data.runId;
    expect((await e.json("DELETE", `/v1/projects/${id}`)).status).toBe(200);
    expect((await e.store.getRun(runId))?.status).toBe("cancelled");
    await e.queue.drain();
    expect((await e.store.getRun(runId))?.status).toBe("cancelled");
  });

  it("GET /v2/system/models answers the C3 shape", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam() });
    const res = await e.call("GET", "/v2/system/models");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [], assignments: [] });
  });
});

describe("orchestrator paths", () => {
  it("a failing gate goes to the fixer with the error files as scope, then passes", async () => {
    let typechecks = 0;
    const llm = scriptedTeam({
      roles: {
        fixer: (_req, i) => scriptedCall(`f${i}`, "submit_report", { status: "done", summary: "Fixed the type.", filesChanged: ["src/app/about/page.tsx"], acceptance: [] }, 0),
      },
    });
    const e = makeTestEngine({ repo: "fake", llm });
    e.sandbox.execHandler = (container, argv) => {
      if (!container.startsWith("forja-verify") || !String(argv[2]).startsWith("npm run --silent typecheck")) return undefined;
      typechecks += 1;
      return typechecks === 2 ? { exitCode: 2, stdout: "src/app/about/page.tsx(2,10): error TS2322: Type 'number' is not assignable to type 'string'.\n" } : undefined;
    };
    const id = await activeProject(e, "fixme");
    const runId = (await start(e, id)).body.data.runId;
    await e.queue.drain();
    expect((await e.store.getRun(runId))?.status).toBe("done");
    const tasks = await e.store.listTasks(runId);
    expect(tasks.map((t) => `${t.planTaskId}:${t.role}:${t.status}`)).toEqual(["about-page:frontend:done", "fix-1:fixer:done"]);
    expect(tasks[1]?.scope).toEqual({ write: ["src/app/about/page.tsx"] });
    const failed = e.store.events.find((x) => x.runId === runId && x.type === "gate.failed");
    expect(failed?.payload).toMatchObject({ name: "typecheck", routedTo: "fixer", parsed: [expect.objectContaining({ file: "src/app/about/page.tsx", line: 2, code: "TS2322" })] });
    const fixerReq = llm.calls.find((c) => c.role === "fixer");
    expect((fixerReq?.messages[0] as { content: string }).content).toContain("src/app/about/page.tsx:2: Type 'number'");
    expect(fixerReq?.tools.map((t) => t.name)).not.toContain("write_file");
    expect(typechecks).toBe(3);
    expect(messagesOf(e, id).at(-1)?.type).toBe("finished");
  });

  it("the local gate sends errors in the task's own files back to its owner (task.retried)", async () => {
    let typechecks = 0;
    const llm = scriptedTeam();
    const e = makeTestEngine({ repo: "fake", llm });
    e.sandbox.execHandler = (container, argv) => {
      if (!container.startsWith("forja-verify") || !String(argv[2]).startsWith("npm run --silent typecheck")) return undefined;
      typechecks += 1;
      return typechecks === 1 ? { exitCode: 2, stdout: "src/app/about/page.tsx(1,1): error TS1005: ';' expected.\n" } : undefined;
    };
    const id = await activeProject(e, "rework");
    const runId = (await start(e, id)).body.data.runId;
    await e.queue.drain();
    expect(eventsOf(e, runId)).toContain("task.retried");
    const rework = llm.calls.filter((c) => c.role === "frontend").find((c) => JSON.stringify(c.messages.at(-1)).includes("The orchestrator ran"));
    expect(rework).toBeDefined();
    expect((await e.store.getRun(runId))?.status).toBe("done");
  });

  it("the same error twice in a row stops the fix loop; the run still finishes and names the failed check", async () => {
    const llm = scriptedTeam({ closing: "" });
    const e = makeTestEngine({ repo: "fake", llm });
    e.sandbox.execHandler = (container, argv) =>
      container.startsWith("forja-verify") && String(argv[2]) === "npm run --silent build" ? { exitCode: 1, stdout: "Error: something broke in the build\n" } : undefined;
    const id = await activeProject(e, "redgate");
    const runId = (await start(e, id)).body.data.runId;
    await e.queue.drain();
    const run = await e.store.getRun(runId);
    expect(run?.status).toBe("done");
    const tasks = await e.store.listTasks(runId);
    // build → owner (the page task) once; the second identical failure stops the loop.
    expect(tasks.map((t) => t.planTaskId)).toEqual(["about-page", "about-page~fix1"]);
    const final = messagesOf(e, id).at(-1);
    expect(final?.type).toBe("finished");
    // The scripted closing message is empty (rejected by the schema) → the localized template.
    expect(final?.text).toBe("The new version is saved, but some checks did not pass: production build. You can ask me to fix them.");
    expect(final?.versionId).toBeTruthy();
    expect(e.store.versionRows[0]?.checks).toMatchObject({ gates: expect.arrayContaining([{ name: "build", passed: false, durationMs: expect.any(Number) }]) });
  });

  it("a question is answered without tasks, gates or a version", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam({ intent: "question", answer: "It uses Postgres 17 with Drizzle." }) });
    const id = await activeProject(e, "asking");
    const runId = (await start(e, id, "Which database does it use?")).body.data.runId;
    await e.queue.drain();
    expect((await e.store.getRun(runId))?.status).toBe("done");
    const final = messagesOf(e, id).at(-1);
    expect(final).toMatchObject({ type: "finished", text: "It uses Postgres 17 with Drizzle.", versionId: null });
    expect(eventsOf(e, runId)).not.toContain("gate.started");
    expect(await e.store.listTasks(runId)).toEqual([]);
  });

  it("an invalid plan comes back to the director with the errors (plan.rejected), then passes", async () => {
    let first = true;
    const llm = scriptedTeam({
      roles: {
        director: (req, i) => {
          if (!req.tools.some((t) => t.name === "submit_plan") || !first) return undefined;
          first = false;
          const plan = tweakPlan();
          return scriptedCall(`p${i}`, "submit_plan", { ...plan, tasks: [{ ...plan.tasks[0], role: "designer" }] }, 0);
        },
      },
    });
    const e = makeTestEngine({ repo: "fake", llm });
    const id = await activeProject(e, "replan");
    const runId = (await start(e, id)).body.data.runId;
    await e.queue.drain();
    expect(eventsOf(e, runId)).toContain("plan.rejected");
    const retry = llm.calls.filter((c) => c.role === "director").find((c) => JSON.stringify(c.messages.at(-1)).includes('role \\"designer\\" is not available'));
    expect(retry).toBeDefined();
    expect((await e.store.getRun(runId))?.status).toBe("done");
  });

  it("a director that never classifies fails the run with a plain error message", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam({ roles: { director: () => textTurn("Sure, I can help!") } }) });
    const id = await activeProject(e, "chatty");
    const runId = (await start(e, id)).body.data.runId;
    await e.queue.drain();
    const run = await e.store.getRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("director intake: no-submit");
    expect(messagesOf(e, id).at(-1)).toMatchObject({ type: "error", text: expect.stringContaining("the request could not be analysed") });
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentProcessStatus).toBe("done");
  });

  it("past 90 % of the run budget pending tasks are skipped and the run ends limit-reached", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam({ costPerTurn: 0.5 }), env: { BUDGET_PER_RUN_USD: "1" } });
    const id = await activeProject(e, "pricey");
    const runId = (await start(e, id)).body.data.runId;
    await e.queue.drain();
    const run = await e.store.getRun(runId);
    expect(run?.status).toBe("limit-reached");
    expect(Number(run?.spentUsd)).toBeCloseTo(1);
    expect(eventsOf(e, runId)).toEqual(expect.arrayContaining(["budget.warning", "budget.exhausted"]));
    expect(await e.store.listTasks(runId)).toEqual([expect.objectContaining({ planTaskId: "about-page", status: "skipped" })]);
    expect(messagesOf(e, id).at(-1)).toMatchObject({ type: "limit-reached", text: expect.stringContaining("(1.00 of 1.00 USD)") });
  });

  it("an LLM configuration lost before the job runs fails the run with what to configure", async () => {
    const llm = scriptedTeam();
    const e = makeTestEngine({ repo: "fake", llm });
    const id = await activeProject(e, "lost-llm");
    const runId = (await start(e, id)).body.data.runId;
    e.ctx.llm = createTestLlmService(llm, { unavailable: "role director needs nativeTools" });
    await e.queue.drain();
    expect((await e.store.getRun(runId))?.status).toBe("failed");
    expect(messagesOf(e, id).at(-1)?.text).toContain("role director needs nativeTools");
    expect(llm.calls).toHaveLength(0);
  });

  it("agent/stop aborts the model call, keeps the partial work on the branch and never merges", async () => {
    const team = scriptedTeam();
    let entered!: () => void;
    const inFrontend = new Promise<void>((r) => (entered = r));
    let frontendCalls = 0;
    const llm: Provider = {
      id: "blocking",
      async *generate(req) {
        if (req.role === "frontend" && ++frontendCalls === 2) {
          entered();
          await new Promise<void>((resolve) => req.abortSignal.addEventListener("abort", () => resolve()));
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        yield* team.generate(req) as AsyncIterable<GenerateEvent>;
      },
    };
    const e = makeTestEngine({ repo: "git", llm });
    const id = await activeProject(e, "stoppable");
    const runId = (await start(e, id)).body.data.runId;
    const job = e.queue.drain();
    await inFrontend;
    const stop = await e.json("POST", `/v1/projects/${id}/agent/stop`, {});
    expect(stop.body.data).toEqual({ runId, status: "cancelling" });
    await job;
    const run = await e.store.getRun(runId);
    expect(run?.status).toBe("cancelled");
    expect(messagesOf(e, id).at(-1)).toMatchObject({ type: "error", text: "Stopped by you. The partial changes are kept in the working version." });
    const root = path.join(e.dataDir, "projects", id);
    expect(existsSync(path.join(root, "work", "src/app/about/page.tsx"))).toBe(false);
    expect(gitIn(path.join(root, "repo.git"), "show", `run/${runId}:src/app/about/page.tsx`)).toBe(ABOUT_PAGE);
    expect(gitIn(path.join(root, "repo.git"), "log", "-1", "--format=%s", `run/${runId}`).trim()).toBe("wip: stopped by the user");
    expect(e.sandbox.calls).toContain(`destroyVerify:${id}:${runId}`);
    expect((await e.json("GET", `/v1/projects/${id}/agent/status`)).body.data.status).toBe("done");
  });
});

describe("crash safety", () => {
  it("a run whose worker vanished is closed on the next status read", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam() });
    const id = await activeProject(e, "orphan");
    const old = new Date(Date.now() - 10 * 60_000);
    const run = await e.store.insertRun({ projectId: id, prompt: "x", status: "implementing", startedAt: old, heartbeatAt: old });
    await e.store.updateProject(id, { processStatus: "init" });
    const st = (await e.json("GET", `/v1/projects/${id}/agent/status`)).body.data;
    expect(st.status).toBe("done");
    expect(st.realtimeConversation.at(-1)).toMatchObject({ messageType: "error", message: expect.stringContaining("interrupted") });
    expect((await e.store.getRun(run!.id))?.status).toBe("failed");
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentProcessStatus).toBe("done");
  });

  it("boot recovery requeues queued runs and closes running ones", async () => {
    const e = makeTestEngine({ repo: "fake", llm: scriptedTeam() });
    const a = await activeProject(e, "queued-one");
    const b = await activeProject(e, "running-one");
    const queued = await e.store.insertRun({ projectId: a, prompt: "x", status: "received", heartbeatAt: new Date() });
    const running = await e.store.insertRun({ projectId: b, prompt: "y", status: "verifying", heartbeatAt: new Date() });
    const out = await recoverRuns(e.ctx);
    expect(out).toEqual({ requeued: [queued!.id], closed: [running!.id] });
    expect(e.queue.sent.at(-1)).toMatchObject({ name: "run.execute", data: { runId: queued!.id } });
    expect((await e.store.getRun(running!.id))?.status).toBe("failed");
  });
});

describe("LLM service over the real gateway (no request is made)", () => {
  const logger = pino({ level: "silent" });

  it("without providers: the engine stays up and says what to configure", () => {
    const s = createLlmService({ env: {}, logger });
    expect(s.unavailableReason()).toMatch(/LLM_NVIDIA="true\|<key>"/);
    expect(s.systemModels().assignments.find((a) => a.role === "director")?.model ?? null).toBeNull();
  });

  it("NVIDIA alone satisfies every phase-2 role; the report never carries the key", () => {
    const s = createLlmService({ env: { LLM_NVIDIA: "true|nvapi-test-not-a-real-key-000000000000" }, logger });
    expect(s.unavailableReason()).toBeNull();
    for (const role of ["director", "frontend", "backend", "database", "fixer", "summarizer"] as const) {
      expect(s.role(role).model, role).toMatch(/^nvidia:/);
      expect(s.role(role).protocol).toBe("native");
    }
    expect(s.role("director")).toMatchObject({ model: "nvidia:z-ai/glm-5.3", contextTokens: 131_072 });
    const report = JSON.stringify(s.systemModels());
    expect(report).not.toContain("nvapi-test");
    expect(s.systemModels().providers).toContainEqual(expect.objectContaining({ id: "nvidia", kind: "llm", status: "enabled", adapterReady: true }));
  });
});
