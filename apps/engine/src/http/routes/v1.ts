/**
 * API v1: the Totalum-compatible surface the UI talks to (envelope `{errors, data}`,
 * docs/research/02, 05 §2). Projects, sandbox lifecycle, files, versions, secrets,
 * uploads, logs, database, the signed public surface and the stubs of 05 §2.1 (phase 1),
 * and the agent: launch, agent/start|stop|status, full-conversation (phase 2,
 * services/runs). While a run works, file writes, rebuilds and restores answer
 * AGENT_RUNNING (03 §8).
 *
 * ⚠️ Every sandbox- or DB-needing endpoint goes through `requireLive` (05 §2.2): asleep →
 * wake + 409 SERVER_NOT_READY; git-only endpoints answer without waking.
 */
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { names } from "@forja/sandbox";
import type { AppDeps } from "../app.js";
import { EngineError, engineError, notFound, notImplemented } from "../errors.js";
import { body, git, intParam, ok, str } from "../v1-helpers.js";
import { publicRoutes } from "./public.js";
import {
  clearRecovery,
  deleteProject,
  readRebuildStatus,
  requireLive,
  startProvision,
  startRebuild,
  startRestart,
  startRestore,
} from "../../services/lifecycle.js";
import {
  createProjectRow,
  getLiveProject,
  listProjects,
  toProject,
  updateProjectMeta,
} from "../../services/projects.js";
import { RESERVED_SECRET_NAMES, SECRET_NAME_RE, toDotenv, type SecretEnvironment } from "../../services/secrets.js";
import { publicFileUrl, storeUpload } from "../../services/uploads.js";
import type { EngineContext } from "../../services/context.js";
import { agentStatus, fullConversation, startRun, stopRun } from "../../services/runs/service.js";

const SOURCE_URL_TTL_SECONDS = 30 * 60;
const CLIENT_HEADER = "x-forja-client";
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function clientId(c: Context): string {
  const h = c.req.header(CLIENT_HEADER);
  return h && CLIENT_ID_RE.test(h) ? h : "api";
}

function decodeContent(content: unknown, encoding: unknown): Uint8Array {
  if (typeof content !== "string") throw new EngineError(400, "MISSING_DATA", "content is required");
  if (encoding === "utf8") return Buffer.from(content, "utf8");
  if (encoding !== undefined && encoding !== "base64") throw new EngineError(400, "INVALID_ENCODING", 'encoding must be "base64" or "utf8"');
  const compact = content.replace(/\s+/g, "");
  if (compact.length % 4 === 1 || !BASE64_RE.test(compact)) throw new EngineError(400, "INVALID_CONTENT", "content is not valid base64");
  return Buffer.from(compact, "base64");
}

/** 03 §8: manual writes, rebuilds and restores wait while a run works on the project. */
function refuseDuringRun(p: { processStatus: string }): void {
  if (p.processStatus === "init") throw engineError("AGENT_RUNNING", "The agent is working on this project; wait until it finishes.");
}

type InputFile = { name: string; url: string; imageDescription: string };

/** `agent/start.inputFiles` (research/02 §5): keeps well-formed entries only. */
function inputFiles(v: unknown): InputFile[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .filter((f) => typeof f.name === "string" && typeof f.url === "string")
    .map((f) => ({ name: f.name as string, url: f.url as string, imageDescription: typeof f.imageDescription === "string" ? f.imageDescription : "" }))
    .slice(0, 20);
}

/** `launch.files` (`{name, description?, url}`) → the agent/start shape. */
function launchFiles(v: unknown): InputFile[] {
  if (!Array.isArray(v)) return [];
  return inputFiles(v.map((f) => (f && typeof f === "object" ? { ...(f as object), imageDescription: (f as { description?: unknown }).description } : f)));
}

async function requireRepo(ctx: EngineContext, projectId: string) {
  const repo = ctx.repo(projectId);
  if (!(await repo.exists())) throw new EngineError(409, "SERVER_NOT_READY", "The project is still being created.");
  return repo;
}

export function v1Routes(deps: AppDeps): Hono {
  const r = new Hono();
  const { ctx } = deps;

  // ── Instance ──────────────────────────────────────────────────────────────

  r.get("/account", (c) =>
    ok(c, {
      credits: null,
      mode: "self-hosted",
      budgets: {
        perRunUsd: deps.config.BUDGET_PER_RUN_USD,
        perProjectMonthUsd: deps.config.BUDGET_PER_PROJECT_MONTH_USD,
        globalMonthUsd: deps.config.BUDGET_GLOBAL_MONTH_USD,
      },
    }),
  );

  r.get("/credit-costs", (c) => ok(c, {}));

  r.get("/system/public-config", (c) =>
    ok(c, {
      publishScheme: ctx.config.PUBLISH_TLS ? "https" : "http",
      publishDomain: ctx.config.PUBLISH_DOMAIN,
      previewDomain: ctx.config.PREVIEW_DOMAIN,
    }),
  );

  r.route("/public", publicRoutes(deps));

  // ── Projects ──────────────────────────────────────────────────────────────

  r.get("/projects", async (c) => {
    const q = c.req.query();
    const sort = q.sortDirection === "asc" || q.sortDirection === "desc" ? q.sortDirection : undefined;
    return ok(
      c,
      await listProjects(ctx, {
        limit: intParam(q.limit, { min: 1 }),
        skip: intParam(q.skip),
        search: q.search || undefined,
        sortDirection: sort,
      }),
    );
  });

  r.post("/projects", async (c) => {
    const b = await body(c);
    const { project, requestedProjectId } = await createProjectRow(ctx, {
      projectId: str(b.projectId) ?? "",
      description: str(b.description),
      label: str(b.label),
    });
    await startProvision(ctx, project.id);
    const fresh = (await ctx.store.getProject(project.id)) ?? project;
    const data = await toProject(ctx, fresh);
    if (requestedProjectId !== project.id) data.requestedProjectId = requestedProjectId;
    return ok(c, data);
  });

  r.post("/projects/launch", async (c) => {
    const b = await body(c);
    const prompt = str(b.prompt);
    if (!prompt || !prompt.trim()) throw new EngineError(400, "MISSING_PROMPT", "prompt is required");
    const description = (str(b.description) ?? prompt).slice(0, 200);
    const { project, requestedProjectId } = await createProjectRow(ctx, {
      projectId: str(b.projectId) ?? "",
      description,
      label: str(b.label),
    });
    await startProvision(ctx, project.id);
    const warnings: { step: string; code: string; message: string; endpoint?: string }[] = [];
    if (b.figma) {
      warnings.push({ step: "figma", code: "NOT_IMPLEMENTED", message: "Figma import arrives in a later engine version." });
    }
    // The run is created now (agentProcessStatus = init before we answer); it waits for the
    // sandbox the provision job is creating. If it cannot start, the workspace sends the
    // stashed prompt itself (agent.started = false) and gets the reason from agent/start.
    let agent: { started: boolean; status: string; message?: string } = { started: false, status: "idle" };
    try {
      const fresh = (await ctx.store.getProject(project.id)) ?? project;
      const started = await startRun(ctx, fresh, { prompt, inputFiles: launchFiles(b.files) });
      warnings.push(...started.warnings);
      agent = { started: true, status: "init" };
    } catch (err) {
      if (!(err instanceof EngineError)) throw err;
      warnings.push({ step: "agent", code: err.code, message: err.message, endpoint: `/projects/${project.id}/agent/start` });
      agent = { started: false, status: "idle", message: err.message };
    }
    return ok(c, {
      projectId: project.id,
      ...(requestedProjectId !== project.id ? { requestedProjectId } : {}),
      agent,
      warnings,
    });
  });

  r.get("/projects/:id", async (c) => ok(c, await toProject(ctx, await getLiveProject(ctx, c.req.param("id")))));

  r.patch("/projects/:id", async (c) => {
    const b = await body(c);
    const patch: { label?: string | null; description?: string | null } = {};
    if ("label" in b) patch.label = b.label === null ? null : (str(b.label) ?? undefined);
    if ("description" in b) patch.description = b.description === null ? null : (str(b.description) ?? undefined);
    return ok(c, await toProject(ctx, await updateProjectMeta(ctx, c.req.param("id"), patch)));
  });

  r.delete("/projects/:id", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    // A run working on the project is stopped first (no merge; its branch goes with the repo).
    await stopRun(ctx, p).catch((err: unknown) => {
      if (!(err instanceof EngineError && err.code === "NO_PROCESS_RUNNING")) throw err;
    });
    await deleteProject(ctx, p);
    return ok(c, { projectId: p.id, deleted: true });
  });

  // ── Agent (phase 2: services/runs) ────────────────────────────────────────

  r.get("/projects/:id/agent/status", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    return ok(c, await agentStatus(ctx, p));
  });

  r.get("/projects/:id/agent/full-conversation", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const q = c.req.query();
    return ok(c, await fullConversation(ctx, p, { limit: intParam(q.limit, { min: 1, max: 10_000 }), offsetFromEnd: intParam(q.offsetFromEnd) }));
  });

  r.post("/projects/:id/agent/start", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const b = await body(c);
    const prompt = str(b.prompt);
    if (!prompt || !prompt.trim()) throw new EngineError(400, "MISSING_PROMPT", "prompt is required");
    const { run, warnings } = await startRun(ctx, p, {
      prompt,
      inputFiles: inputFiles(b.inputFiles),
      ...("model" in b ? { model: b.model } : {}),
      ...("effort" in b ? { effort: b.effort } : {}),
      ...("fastMode" in b ? { fastMode: b.fastMode } : {}),
    });
    return ok(c, { started: true, status: "init", runId: run.id, warnings });
  });

  r.post("/projects/:id/agent/stop", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    return ok(c, await stopRun(ctx, p));
  });

  r.post("/projects/:id/agent/server/start-or-restart", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    await startRestart(ctx, p);
    const now = await ctx.store.getProject(p.id);
    return ok(c, { status: now?.serverStatus ?? p.serverStatus });
  });

  // ── Files ─────────────────────────────────────────────────────────────────

  r.get("/projects/:id/files/tree", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const repo = await requireRepo(ctx, p.id);
    const q = c.req.query();
    return ok(
      c,
      await git(() =>
        repo.tree({ path: q.path, limit: intParam(q.limit, { min: 1, max: 10_000 }), offset: intParam(q.offset) }),
      ),
    );
  });

  r.get("/projects/:id/files/content", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const filePath = c.req.query("path");
    if (!filePath) throw new EngineError(400, "MISSING_PATH", "path is required");
    const repo = await requireRepo(ctx, p.id);
    return ok(c, await git(() => repo.readFile(filePath)));
  });

  r.put("/projects/:id/files/content", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const b = await body(c);
    const filePath = str(b.path);
    if (!filePath) throw new EngineError(400, "MISSING_PATH", "path is required");
    const bytes = decodeContent(b.content, b.encoding);
    await requireLive(ctx, p);
    refuseDuringRun(p);
    const repo = await requireRepo(ctx, p.id);
    const result = await git(() =>
      repo.writeFile(filePath, bytes, {
        clientId: clientId(c),
        baseCommitSha: str(b.baseCommitSha) || undefined,
      }),
    );
    await ctx.store.updateProject(p.id, { lastActivityAt: new Date() });
    return ok(c, {
      path: result.path,
      bytesWritten: result.bytesWritten,
      created: result.created,
      commitSha: result.commitSha,
      rebuildRequired: result.rebuildRequired,
      pending: result.pending,
    });
  });

  r.post(
    "/projects/:id/files/upload",
    bodyLimit({
      maxSize: (deps.ctx.config.UPLOAD_MAX_MB + 1) * 1024 * 1024,
      onError: () => {
        throw engineError("FILE_TOO_LARGE", `The file is larger than ${deps.ctx.config.UPLOAD_MAX_MB} MB.`);
      },
    }),
    async (c) => {
      const p = await getLiveProject(ctx, c.req.param("id"));
      const type = c.req.header("content-type") ?? "";
      if (!type.toLowerCase().startsWith("multipart/form-data")) {
        throw new EngineError(400, "MISSING_FILE", "Send the file as multipart/form-data in the field `file`.");
      }
      const form = await c.req.parseBody().catch(() => {
        throw new EngineError(400, "MISSING_FILE", "The multipart body could not be read.");
      });
      const file = form.file;
      if (!(file instanceof File)) throw new EngineError(400, "MISSING_FILE", "The multipart field `file` is required.");
      const bytes = new Uint8Array(await file.arrayBuffer());
      return ok(c, await storeUpload(ctx, p.id, { name: file.name, bytes }));
    },
  );

  r.get("/projects/:id/source-code", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const repo = await requireRepo(ctx, p.id);
    const head = await git(() => repo.flush());
    if (!head) throw new EngineError(409, "SERVER_NOT_READY", "The project has no commits yet.");
    const filesCount = await git(() => repo.filesCount(head));
    return ok(c, {
      downloadUrl: publicFileUrl(ctx, p.id, `source/${head}`, SOURCE_URL_TTL_SECONDS),
      filesCount,
      lastCommitSha: head,
    });
  });

  // ── Rebuild, restart, logs ────────────────────────────────────────────────

  r.post("/projects/:id/rebuild", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    await requireLive(ctx, p);
    refuseDuringRun(p);
    return ok(c, await startRebuild(ctx, p));
  });

  r.get("/projects/:id/rebuild/status", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    return ok(c, await readRebuildStatus(ctx, p));
  });

  r.get("/projects/:id/backend/dev/logs", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    await requireLive(ctx, p);
    const tailLines = intParam(c.req.query("tail"), { min: 1, max: 10_000 }) ?? 1000;
    const since = c.req.query("since");
    const logs = await ctx.sandbox.logs(names.appContainer(p.id), { tail: tailLines, ...(since ? { since } : {}) });
    return ok(c, { logs });
  });

  // Production logs arrive with publishing (phase 4): an empty, well-formed answer.
  r.get("/projects/:id/backend/prod/logs", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    return ok(c, { records: [] });
  });

  // ── Versions ──────────────────────────────────────────────────────────────

  r.get("/projects/:id/versions", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const repo = ctx.repo(p.id);
    if (!(await repo.exists())) return ok(c, { versions: [], totalCount: 0 });
    const q = c.req.query();
    const log = await git(() => repo.log({ limit: intParam(q.limit, { min: 1, max: 1000 }) ?? 10, skip: intParam(q.skip) ?? 0 }));
    return ok(c, {
      versions: log.versions.map((v) => ({
        _id: v.commitSha,
        name: v.tag ?? v.commitSha.slice(0, 7),
        commitSha: v.commitSha,
        commitMessage: v.message,
        tag: v.tag,
        createdAt: v.createdAt,
      })),
      totalCount: log.totalCount,
    });
  });

  r.get("/projects/:id/version-diff", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const sha = c.req.query("commitSha");
    if (!sha) throw new EngineError(400, "MISSING_COMMIT_SHA", "commitSha is required");
    const repo = await requireRepo(ctx, p.id);
    const d = await git(() => repo.diff(sha));
    return ok(c, { commitSha: d.commitSha, diff: d.diff });
  });

  r.post("/projects/:id/versions/:versionId/recover", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    await requireLive(ctx, p);
    refuseDuringRun(p);
    const versionId = c.req.param("versionId");
    await startRestore(ctx, p, versionId);
    return ok(c, { versionId, status: "recovering" });
  });

  r.delete("/projects/:id/versions/recovery", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    await clearRecovery(ctx, p);
    return ok(c, { cleared: true });
  });

  // ── Secrets ───────────────────────────────────────────────────────────────

  r.post("/projects/:id/secrets", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const b = await body(c);
    const name = str(b.secretName)?.trim();
    const value = str(b.secretValue);
    const environment = (str(b.environment) ?? "both") as SecretEnvironment;
    if (!name || value === undefined) throw new EngineError(400, "MISSING_SECRET_FIELDS", "secretName and secretValue are required");
    if (!SECRET_NAME_RE.test(name) || RESERVED_SECRET_NAMES.has(name.toUpperCase())) {
      throw new EngineError(400, "INVALID_SECRET_KEY_NAME", `"${name}" cannot be used as a secret name.`);
    }
    if (!["development", "production", "both"].includes(environment)) {
      throw new EngineError(400, "INVALID_ENVIRONMENT", 'environment must be "development", "production" or "both"');
    }
    const row = await ctx.secrets.setUser(p.id, name, environment, value);
    return ok(c, { _id: row.id, secretName: row.name, environment: row.environment });
  });

  r.delete("/projects/:id/secrets/:secretId", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const deleted = await ctx.secrets.deleteUser(p.id, c.req.param("secretId"));
    if (!deleted) throw new EngineError(404, "SECRET_NOT_FOUND", "Secret not found");
    return ok(c, { deleted: true });
  });

  // ── Database (CMS) ────────────────────────────────────────────────────────

  const tableName = (b: Record<string, unknown>, c?: Context): string => {
    const t = str(b.tableName) ?? c?.req.query("tableName");
    if (!t) throw new EngineError(400, "MISSING_TABLE_NAME", "tableName is required");
    return t;
  };
  const record = (b: Record<string, unknown>): Record<string, unknown> => {
    const d = b.data;
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new EngineError(400, "MISSING_DATA", "data is required");
    return d as Record<string, unknown>;
  };
  const liveForDb = async (c: Context) => {
    const p = await getLiveProject(ctx, c.req.param("id") ?? "");
    await requireLive(ctx, p);
    return p;
  };

  r.get("/projects/:id/database/tables-structure", async (c) => {
    const p = await liveForDb(c);
    return ok(c, await ctx.cms.tablesStructure(p.id));
  });

  r.post("/projects/:id/database/query", async (c) => {
    const p = await liveForDb(c);
    const b = await body(c);
    const qo = b.queryOptions && typeof b.queryOptions === "object" ? (b.queryOptions as Record<string, unknown>) : {};
    return ok(c, await ctx.cms.query(p.id, tableName(b), qo));
  });

  r.post("/projects/:id/database/records", async (c) => {
    const p = await liveForDb(c);
    const b = await body(c);
    return ok(c, await ctx.cms.createRecord(p.id, tableName(b), record(b)));
  });

  r.patch("/projects/:id/database/records/:recordId", async (c) => {
    const p = await liveForDb(c);
    const b = await body(c);
    return ok(c, await ctx.cms.updateRecord(p.id, tableName(b), c.req.param("recordId"), record(b)));
  });

  r.delete("/projects/:id/database/records/:recordId", async (c) => {
    const p = await liveForDb(c);
    const b = await body(c);
    return ok(c, await ctx.cms.deleteRecord(p.id, tableName(b, c), c.req.param("recordId")));
  });

  const linkInput = (c: Context, b: Record<string, unknown>) => {
    const propertyId = str(b.propertyId);
    const referenceId = str(b.referenceId);
    if (!propertyId || !referenceId) throw new EngineError(400, "MISSING_DATA", "propertyId and referenceId are required");
    return { tableName: tableName(b), recordId: c.req.param("recordId") ?? "", propertyId, referenceId };
  };

  r.post("/projects/:id/database/records/:recordId/link", async (c) => {
    const p = await liveForDb(c);
    return ok(c, await ctx.cms.link(p.id, linkInput(c, await body(c))));
  });

  r.delete("/projects/:id/database/records/:recordId/link", async (c) => {
    const p = await liveForDb(c);
    return ok(c, await ctx.cms.unlink(p.id, linkInput(c, await body(c))));
  });

  // ── Publishing, domains, integrations: stubs (05 §2.1) ────────────────────

  r.get("/projects/:id/deployments/status", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    return ok(c, { status: null });
  });
  r.post("/projects/:id/deployments/deploy", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    throw notImplemented("Publishing (deployments/deploy)");
  });
  r.on(["PUT", "DELETE"], "/projects/:id/domain", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    throw notImplemented("Custom domains");
  });

  r.get("/projects/:id/github/status", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    return ok(c, { connected: false, tokenValid: false, tokenExpired: false });
  });
  r.get("/projects/:id/github/pull-status", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    return ok(c, { status: null });
  });
  r.get("/projects/:id/github/env", async (c) => {
    const p = await getLiveProject(ctx, c.req.param("id"));
    const mask = !deps.config.ALLOW_ENV_EXPORT;
    return ok(c, {
      envDev: toDotenv(await ctx.secrets.renderUser(p.id, "development"), mask),
      envProd: toDotenv(await ctx.secrets.renderUser(p.id, "production"), mask),
    });
  });
  r.on(["POST", "DELETE"], "/projects/:id/github/connect", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    throw notImplemented("GitHub sync");
  });
  r.post("/projects/:id/github/pull", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    throw notImplemented("GitHub sync");
  });

  r.get("/projects/:id/figma/status", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    return ok(c, { connected: false });
  });
  r.on(["POST", "DELETE"], "/projects/:id/figma/connect", async (c) => {
    await getLiveProject(ctx, c.req.param("id"));
    throw notImplemented("Figma import");
  });
  r.post("/figma/validate", () => {
    throw notImplemented("Figma import");
  });

  r.all("/projects/:id/*", async (c) => {
    const id = c.req.param("id");
    if (!(await ctx.store.getProject(id))) throw notFound();
    throw notImplemented(`${c.req.method} ${c.req.path}`);
  });

  r.all("/*", (c) => {
    throw notImplemented(`${c.req.method} ${c.req.path}`);
  });

  return r;
}
