/**
 * API v2 (plain JSON, 05 §3), phase 1 slice:
 *   ALL  /v2/projects/:id/preview[/*]   internal preview proxy for the UI server (04 §4)
 *   GET  /v2/projects/:id/budget        the budget page's report (zeros until phase 2's ledger)
 *   POST /v2/projects/:id/undelete      within PROJECT_PURGE_AFTER_DAYS of a delete
 *   POST /v2/projects/:id/archive       put an Active project to sleep now (ops/tests; phase 4 adds the idle timer)
 *
 * ⚠️ Preview proxy: `*.localhost` does not resolve inside containers, so the UI server asks
 * the engine, which forwards over `forja-apps` to `forja-app-<id>:3000` (or
 * `forja-verify-<id>:3000` with `?target=verify`). Bodies stream both ways; redirects pass
 * through as-is (`redirect: "manual"`); hop-by-hop headers are stripped both ways; the
 * engine's `api-key` is NEVER forwarded to the sandbox; 503 while the app is not ready.
 */
import { Hono, type Context } from "hono";
import { APP_PORT, names } from "@forja/sandbox";
import { isRoutableProjectSlug } from "@forja/contracts";
import type { AppDeps } from "../app.js";
import { EngineError } from "../errors.js";
import { startArchive, undeleteProject } from "../../services/lifecycle.js";
import { toProject } from "../../services/projects.js";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

/** Request headers never forwarded to a sandbox. */
const DROP_REQUEST = new Set([...HOP_BY_HOP, "host", "api-key", "content-length", "accept-encoding", "x-request-id"]);

function forwardHeaders(from: Headers, drop: Set<string>): Headers {
  const out = new Headers();
  const connectionListed = new Set(
    (from.get("connection") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  from.forEach((value, key) => {
    const k = key.toLowerCase();
    if (drop.has(k) || connectionListed.has(k) || k === "set-cookie") return;
    out.append(key, value);
  });
  return out;
}

async function proxyPreview(deps: AppDeps, c: Context): Promise<Response> {
  const { ctx } = deps;
  const id = c.req.param("id") ?? "";
  if (!isRoutableProjectSlug(id)) throw new EngineError(404, "PROJECT_NOT_FOUND", "Project not found");
  const project = await ctx.store.getProject(id);
  if (!project) throw new EngineError(404, "PROJECT_NOT_FOUND", "Project not found");

  const incoming = new URL(c.req.url);
  const target = incoming.searchParams.get("target") === "verify" ? "verify" : "app";
  if (target === "app" && project.serverStatus !== "Active") {
    throw new EngineError(503, "SERVER_NOT_READY", `The preview is not ready (${project.serverStatus}).`);
  }
  const container = target === "verify" ? names.verifyContainer(id) : names.appContainer(id);
  const prefix = `/v2/projects/${id}/preview`;
  const rest = incoming.pathname.startsWith(prefix) ? incoming.pathname.slice(prefix.length) : "";
  incoming.searchParams.delete("target");
  const qs = incoming.searchParams.toString();
  const origin = ctx.previewOrigin?.(id, target) ?? `http://${container}:${APP_PORT}`;
  const upstream = `${origin}${rest.startsWith("/") ? rest : `/${rest}`}${qs ? `?${qs}` : ""}`;

  const method = c.req.method.toUpperCase();
  const headers = forwardHeaders(c.req.raw.headers, DROP_REQUEST);
  headers.set("accept-encoding", "identity");
  const hasBody = method !== "GET" && method !== "HEAD" && c.req.raw.body !== null;

  let res: Response;
  try {
    res = await fetch(upstream, {
      method,
      headers,
      body: hasBody ? c.req.raw.body : undefined,
      redirect: "manual",
      signal: c.req.raw.signal,
      // Required by undici to stream a request body.
      ...(hasBody ? { duplex: "half" } : {}),
    } as RequestInit);
  } catch {
    throw new EngineError(503, "SERVER_NOT_READY", "The preview did not answer.");
  }

  const out = forwardHeaders(res.headers, HOP_BY_HOP);
  for (const cookie of res.headers.getSetCookie()) out.append("set-cookie", cookie);
  if (res.headers.has("content-encoding")) {
    // fetch already decoded the body: the original length and encoding no longer apply.
    out.delete("content-encoding");
    out.delete("content-length");
  }
  return new Response(method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers: out });
}

function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function v2Routes(deps: AppDeps): Hono {
  const r = new Hono();
  const { ctx } = deps;

  r.all("/projects/:id/preview", (c) => proxyPreview(deps, c));
  r.all("/projects/:id/preview/*", (c) => proxyPreview(deps, c));

  r.get("/projects/:id/budget", async (c) => {
    const id = c.req.param("id");
    const p = isRoutableProjectSlug(id) ? await ctx.store.getProject(id) : null;
    if (!p) throw new EngineError(404, "PROJECT_NOT_FOUND", "Project not found");
    const since = monthStart();
    const runs = await ctx.store.listRuns(p.id, since);
    c.header("Cache-Control", "no-store");
    return c.json({
      project: {
        monthSpentUsd: runs.reduce((a, run) => a + run.spentUsd, 0),
        monthBudgetUsd: ctx.config.BUDGET_PER_PROJECT_MONTH_USD,
      },
      runs: runs.map((run) => ({
        id: run.id,
        startedAt: (run.startedAt ?? run.createdAt).toISOString(),
        status: run.status,
        spentUsd: run.spentUsd,
        budgetUsd: run.budgetUsd ?? ctx.config.BUDGET_PER_RUN_USD,
      })),
      global: {
        monthSpentUsd: await ctx.store.monthSpentUsd(since),
        monthBudgetUsd: ctx.config.BUDGET_GLOBAL_MONTH_USD,
      },
    });
  });

  r.post("/projects/:id/undelete", async (c) => {
    const id = c.req.param("id");
    if (!isRoutableProjectSlug(id)) throw new EngineError(404, "PROJECT_NOT_FOUND", "Project not found");
    const p = await undeleteProject(ctx, id);
    return c.json(await toProject(ctx, (await ctx.store.getProject(p.id)) ?? p));
  });

  r.post("/projects/:id/archive", async (c) => {
    const id = c.req.param("id");
    const p = isRoutableProjectSlug(id) ? await ctx.store.getProject(id) : null;
    if (!p) throw new EngineError(404, "PROJECT_NOT_FOUND", "Project not found");
    await startArchive(ctx, p);
    return c.json({ projectId: p.id, status: "Archiving" });
  });

  return r;
}
