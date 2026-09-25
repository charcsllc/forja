/**
 * In-process fake of the v1 wire format (Node `http`, no framework) for the simulator's
 * own tests.
 *
 * What this file protects: the simulator is proven in both directions. With no flaws the
 * fake honours every synchronous transition of research/02 §3.3 and every simulator must
 * pass; each `flaws` switch breaks exactly one transition and the matching simulator
 * must report it. Progress is driven by status READS (not wall time), so tests are
 * deterministic at any poll interval.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ConversationMessage, DeployStatus, RebuildStatus, RunStatus, ServerStatus } from "../src/types.js";

export interface FakeServerFlaws {
  /** agent/start answers before the run exists: the first status read shows the previous "done". */
  runInitAsync?: boolean;
  /** Realtime messages get a fresh createdAt on every read. */
  runUnstableCreatedAt?: boolean;
  /** The run ends without a finished/error/limit-reached message. */
  runNoTerminalMessage?: boolean;
  /** The first deployments/status after deploy still shows the previous "success". */
  deployStale?: boolean;
  /** The first rebuild/status after rebuild shows "idle". */
  rebuildIdleFirst?: boolean;
  /** The first project read after restart still shows "Active". */
  restartStaysActive?: boolean;
  /** versionRecovery appears only after the first read. */
  restoreAsync?: boolean;
  /** pull-status is null on the first read. */
  pullAsync?: boolean;
  /** The woken server becomes Active but keeps pointing the preview at the cached snapshot. */
  wakeNeverLive?: boolean;
  /** launch creates a suffixed project but returns the requested id. */
  launchWrongId?: boolean;
}

export interface FakeServerOptions {
  apiKey?: string;
  flaws?: FakeServerFlaws;
  /** Status reads an in-progress transition takes to finish. Default 2; must be >= 2. */
  ticks?: number;
  /** launch answers `agent.started: false` (legitimate variant: the workspace sends the prompt). */
  launchDoesNotStart?: boolean;
}

interface Progress {
  reads: number;
  /** Flawed reads still to serve before the correct state shows. */
  lag: number;
}

interface FakeProject {
  projectId: string;
  agentProcessStatus: RunStatus;
  agentServerStatus: ServerStatus;
  conversation: ConversationMessage[];
  run: (Progress & { startedAt: string; realtime: ConversationMessage[] }) | null;
  deployment: { status: DeployStatus; createdAt: string } | null;
  deployProgress: Progress | null;
  rebuild: { status: RebuildStatus; progress: Progress | null };
  pull: { status: "pulling" | "success" | "error" | null; progress: Progress | null };
  restart: Progress | null;
  recovery: (Progress & { versionId: string; startedAt: string }) | null;
  /** What the project read shows; computed on each read from `recovery`. */
  recoveryView: { status: "recovering"; versionId: string; startedAt: string } | null;
  wake: Progress | null;
  temporalDevelopmentProjectUrl: string;
  cachedDevelopmentUrl: string;
  developmentUrlFieldToUse: "temporalDevelopmentProjectUrl" | "cachedDevelopmentUrl";
  productionProjectUrl?: string;
}

export interface FakeServer {
  url: string;
  apiKey: string;
  projects: Map<string, FakeProject>;
  close(): Promise<void>;
}

let clock = 0;
const iso = () => new Date(Date.UTC(2026, 0, 1) + ++clock * 1000).toISOString();

function newProject(projectId: string): FakeProject {
  return {
    projectId,
    agentProcessStatus: "done",
    agentServerStatus: "Active",
    conversation: [],
    run: null,
    deployment: null,
    deployProgress: null,
    rebuild: { status: "idle", progress: null },
    pull: { status: null, progress: null },
    restart: null,
    recovery: null,
    recoveryView: null,
    wake: null,
    temporalDevelopmentProjectUrl: `http://${projectId}.forja.localhost`,
    cachedDevelopmentUrl: `http://files.forja.localhost/${projectId}/snapshot.html`,
    developmentUrlFieldToUse: "temporalDevelopmentProjectUrl",
  };
}

function seed(projects: Map<string, FakeProject>): void {
  const demo = newProject("demo");
  demo.conversation = [
    { author: "user", message: "a landing page for a bakery", messageType: "regular", createdAt: iso() },
    { author: "agent", message: "Your app is ready.", messageType: "finished", createdAt: iso(), versionId: "v1" },
  ];
  demo.deployment = { status: "success", createdAt: iso() };
  demo.productionProjectUrl = "demo.apps.forja.localhost";
  projects.set(demo.projectId, demo);

  const sleepy = newProject("sleepy");
  sleepy.agentServerStatus = "Archived";
  sleepy.developmentUrlFieldToUse = "cachedDevelopmentUrl";
  sleepy.temporalDevelopmentProjectUrl = "";
  sleepy.conversation = [...demo.conversation];
  projects.set(sleepy.projectId, sleepy);
}

export async function startFakeServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const apiKey = opts.apiKey ?? "test-key";
  const flaws = opts.flaws ?? {};
  const ticks = opts.ticks ?? 2;
  const projects = new Map<string, FakeProject>();
  seed(projects);

  function detail(p: FakeProject) {
    return {
      projectId: p.projectId,
      description: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      plan: "self-hosted",
      agentProcessStatus: p.agentProcessStatus,
      agentServerStatus: p.agentServerStatus,
      deployment: p.deployment,
      versionRecovery: p.recoveryView,
      importInProgress: null,
      secrets: [],
      customDomain: null,
      temporalDevelopmentProjectUrl: p.temporalDevelopmentProjectUrl || undefined,
      cachedDevelopmentUrl: p.cachedDevelopmentUrl,
      developmentUrlFieldToUse: p.developmentUrlFieldToUse,
      productionProjectUrl: p.productionProjectUrl,
    };
  }

  function startRun(p: FakeProject, prompt: string): void {
    p.conversation.push({ author: "user", message: prompt, messageType: "regular", createdAt: iso() });
    const startedAt = iso();
    p.run = { reads: 0, lag: flaws.runInitAsync ? 1 : 0, startedAt, realtime: [{ author: "agent", message: "Starting…", messageType: "starting", createdAt: iso() }] };
    if (!flaws.runInitAsync) p.agentProcessStatus = "init";
  }

  function readRun(p: FakeProject) {
    const run = p.run;
    if (run) {
      if (run.lag > 0) {
        run.lag -= 1;
        return { projectId: p.projectId, status: p.agentProcessStatus, startedAt: null, realtimeConversation: [] };
      }
      p.agentProcessStatus = "init";
      run.reads += 1;
      if (run.reads === 1) run.realtime.push({ author: "agent", message: "Writing src/app/page.tsx", messageType: "building", createdAt: iso() });
      if (run.reads >= ticks) {
        const final: ConversationMessage = flaws.runNoTerminalMessage
          ? { author: "agent", message: "Still thinking…", messageType: "building", createdAt: iso() }
          : { author: "agent", message: "Done: your page is live in the preview.", messageType: "finished", createdAt: iso(), versionId: `v${clock}` };
        p.conversation.push(...run.realtime, final);
        p.run = null;
        p.agentProcessStatus = "done";
        return { projectId: p.projectId, status: "done" as const, startedAt: null, realtimeConversation: [] };
      }
      const realtime = flaws.runUnstableCreatedAt ? run.realtime.map((m) => ({ ...m, createdAt: iso() })) : run.realtime;
      return { projectId: p.projectId, status: "init" as const, startedAt: run.startedAt, expectedMinutes: 2, realtimeConversation: realtime };
    }
    return { projectId: p.projectId, status: p.agentProcessStatus, startedAt: null, realtimeConversation: [] };
  }

  /** Advances whatever is in progress on the project; called on each project read. */
  function tickProjectRead(p: FakeProject): void {
    if (p.restart) {
      if (p.restart.lag > 0) {
        p.restart.lag -= 1;
        p.agentServerStatus = "Active";
      } else {
        p.agentServerStatus = "Starting";
        if (++p.restart.reads >= ticks) {
          p.agentServerStatus = "Active";
          p.restart = null;
        }
      }
    }
    const rec = p.recovery;
    if (rec) {
      if (rec.lag > 0) {
        rec.lag -= 1;
        p.recoveryView = null;
      } else if (++rec.reads > ticks) {
        p.recovery = null;
        p.recoveryView = null;
      } else {
        p.recoveryView = { status: "recovering", versionId: rec.versionId, startedAt: rec.startedAt };
      }
    }
    if (p.wake && ++p.wake.reads >= ticks) {
      p.agentServerStatus = "Active";
      if (!flaws.wakeNeverLive) {
        p.developmentUrlFieldToUse = "temporalDevelopmentProjectUrl";
        p.temporalDevelopmentProjectUrl = `http://${p.projectId}.forja.localhost`;
        p.wake = null;
      }
    }
  }

  function send(res: ServerResponse, status: number, data: unknown, error?: { code: string; message: string }): void {
    const body = JSON.stringify(error ? { errors: { errorCode: error.code, errorMessage: error.message }, data: null } : { errors: null, data });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return {};
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers["api-key"] !== apiKey) return send(res, 401, null, { code: "UNAUTHORIZED", message: "bad api-key" });
    const url = new URL(req.url ?? "/", "http://fake");
    if (!url.pathname.startsWith("/v1/")) return send(res, 404, null, { code: "NOT_FOUND", message: url.pathname });
    const seg = url.pathname.slice(4).split("/").map(decodeURIComponent);
    const method = req.method ?? "GET";
    const body = method === "GET" ? {} : await readBody(req);
    const route = `${method} ${seg.map((s, i) => (i === 1 && seg[0] === "projects" && s !== "launch" ? ":id" : s)).join("/")}`;

    if (route === "POST projects/launch") {
      const requested = String(body.projectId ?? "");
      let created = requested;
      for (let n = 2; projects.has(created); n++) created = `${requested}-${n}`;
      if (flaws.launchWrongId) created = `${requested}-x7`;
      const p = newProject(created);
      projects.set(created, p);
      const started = !opts.launchDoesNotStart;
      if (started) startRun(p, String(body.prompt ?? ""));
      const answeredId = flaws.launchWrongId ? requested : created;
      return send(res, 200, {
        projectId: answeredId,
        ...(answeredId !== requested ? { requestedProjectId: requested } : {}),
        agent: { started },
        warnings: started ? [] : [{ step: "agent", message: "run not started" }],
      });
    }

    const p = seg[1] ? projects.get(seg[1]) : undefined;
    if (seg[0] === "projects" && seg[1] && !p) return send(res, 404, null, { code: "PROJECT_NOT_FOUND", message: seg[1] });
    if (!p) return send(res, 404, null, { code: "NOT_FOUND", message: route });

    switch (route) {
      case "GET projects/:id":
        tickProjectRead(p);
        return send(res, 200, detail(p));
      case "POST projects/:id/agent/start":
        if (p.agentServerStatus !== "Active") return send(res, 409, null, { code: "SERVER_NOT_READY", message: "waking" });
        startRun(p, String(body.prompt ?? ""));
        return send(res, 200, { started: true });
      case "GET projects/:id/agent/status":
        return send(res, 200, readRun(p));
      case "GET projects/:id/agent/full-conversation":
        return send(res, 200, { conversation: p.conversation, totalCount: p.conversation.length, hasMore: false });
      case "POST projects/:id/deployments/deploy":
        p.deployProgress = { reads: 0, lag: flaws.deployStale ? 1 : 0 };
        if (!flaws.deployStale) p.deployment = { status: "deploying", createdAt: iso() };
        return send(res, 200, { status: "deploying" });
      case "GET projects/:id/deployments/status": {
        const d = p.deployProgress;
        if (d) {
          if (d.lag > 0) d.lag -= 1;
          else {
            p.deployment = { status: "deploying", createdAt: p.deployment?.status === "deploying" ? p.deployment.createdAt : iso() };
            if (++d.reads >= ticks) {
              p.deployment = { status: "success", createdAt: p.deployment.createdAt };
              p.productionProjectUrl = `${p.projectId}.apps.forja.localhost`;
              p.deployProgress = null;
            }
          }
        }
        return send(res, 200, p.deployment ? { status: p.deployment.status, createdAt: p.deployment.createdAt } : null);
      }
      case "POST projects/:id/rebuild":
        p.rebuild = { status: "rebuilding", progress: { reads: 0, lag: flaws.rebuildIdleFirst ? 1 : 0 } };
        return send(res, 200, { status: "rebuilding", startedAt: iso() });
      case "GET projects/:id/rebuild/status": {
        const r = p.rebuild;
        if (r.progress) {
          if (r.progress.lag > 0) {
            r.progress.lag -= 1;
            return send(res, 200, { status: "idle" });
          }
          if (++r.progress.reads >= ticks) p.rebuild = { status: "success", progress: null };
        }
        return send(res, 200, { status: p.rebuild.status });
      }
      case "POST projects/:id/agent/server/start-or-restart":
        p.restart = { reads: 0, lag: flaws.restartStaysActive ? 1 : 0 };
        if (!flaws.restartStaysActive) p.agentServerStatus = "Starting";
        return send(res, 200, { status: "Starting" });
      default:
        break;
    }

    if (method === "POST" && seg[2] === "versions" && seg[3] && seg[4] === "recover" && seg.length === 5) {
      p.recovery = { versionId: seg[3], startedAt: iso(), reads: 0, lag: flaws.restoreAsync ? 1 : 0 };
      if (!flaws.restoreAsync) p.recoveryView = { status: "recovering", versionId: seg[3], startedAt: p.recovery.startedAt };
      return send(res, 200, { status: "recovering" });
    }
    if (route === "POST projects/:id/github/pull") {
      p.pull = { status: flaws.pullAsync ? null : "pulling", progress: { reads: 0, lag: flaws.pullAsync ? 1 : 0 } };
      return send(res, 200, { status: "pulling", message: "Pulling", filesUpdated: 0 });
    }
    if (route === "GET projects/:id/github/pull-status") {
      const g = p.pull;
      if (g.progress) {
        if (g.progress.lag > 0) g.progress.lag -= 1;
        else {
          g.status = "pulling";
          if (++g.progress.reads >= ticks) p.pull = { status: "success", progress: null };
        }
      }
      return send(res, 200, { status: p.pull.status, createdAt: iso() });
    }
    if (route === "GET projects/:id/backend/dev/logs") {
      const live = p.agentServerStatus === "Active" && p.developmentUrlFieldToUse === "temporalDevelopmentProjectUrl";
      if (!live) {
        if (!p.wake) {
          p.wake = { reads: 0, lag: 0 };
          p.agentServerStatus = "Unarchiving";
        }
        return send(res, 409, null, { code: "SERVER_NOT_READY", message: "The server is starting; poll agentServerStatus until Active" });
      }
      return send(res, 200, { logs: "ready on :3000" });
    }
    return send(res, 404, null, { code: "NOT_FOUND", message: route });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => send(res, 500, null, { code: "FAKE_SERVER_ERROR", message: String(err) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey,
    projects,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
