/**
 * The signed public surface `GET /v1/public/<token>` (05 §2.3). No `api-key`: the HMAC token
 * (project + resource + expiry) is the authorisation. The UI streams it to browsers as
 * `/api/files/<token>`, so the engine itself is never exposed.
 *
 * Resources: `uploads/<fileNameId>` (30 days), `source/<commitSha>` (zip, 30 min),
 * `preview-image` (phase 3; 404 until then).
 *
 * Protects: content type comes from the upload's sniffed MIME; every answer carries
 * `nosniff`, a restrictive CSP (`sandbox`) and an explicit disposition; archives and
 * anything not viewable are `attachment`. A token for a deleted project answers 404.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { verifyPublicToken } from "../../auth/signed-url.js";
import type { AppDeps } from "../app.js";
import { EngineError } from "../errors.js";

const INLINE_PREFIXES = ["image/", "video/", "audio/", "text/plain", "application/pdf"];

function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function secureHeaders(h: Headers): void {
  h.set("x-content-type-options", "nosniff");
  h.set("content-security-policy", "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  h.set("referrer-policy", "no-referrer");
}

export function publicRoutes(deps: AppDeps): Hono {
  const r = new Hono();
  const { ctx } = deps;

  r.get("/:token", async (c) => {
    const verdict = verifyPublicToken(deps.masterKey, c.req.param("token"));
    if (!verdict.ok) throw new EngineError(403, "INVALID_TOKEN", "Invalid or expired link");
    const { p: projectId, r: resource, exp } = verdict.payload;
    const project = await ctx.store.getProject(projectId);
    if (!project) throw new EngineError(404, "NOT_FOUND", "Not found");
    const headers = new Headers();
    secureHeaders(headers);

    if (resource.startsWith("uploads/")) {
      const fileNameId = resource.slice("uploads/".length);
      const row = await ctx.store.getUpload(projectId, fileNameId);
      if (!row) throw new EngineError(404, "NOT_FOUND", "Not found");
      const abs = path.resolve(ctx.config.DATA_DIR, row.path);
      const root = path.resolve(ctx.config.DATA_DIR, "projects", projectId, "uploads");
      if (!abs.startsWith(`${root}${path.sep}`)) throw new EngineError(404, "NOT_FOUND", "Not found");
      const s = await stat(abs).catch(() => null);
      if (!s?.isFile()) throw new EngineError(404, "NOT_FOUND", "Not found");
      const inline = INLINE_PREFIXES.some((pre) => row.mime.startsWith(pre));
      headers.set("content-type", row.mime);
      headers.set("content-length", String(s.size));
      headers.set("content-disposition", contentDisposition(inline ? "inline" : "attachment", row.originalName));
      // Immutable content (random name); cache for at most the token's remaining life, max 1 day.
      const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000));
      headers.set("cache-control", `private, max-age=${Math.min(remaining, 86_400)}`);
      headers.set("etag", `"${row.sha256.slice(0, 32)}"`);
      const stream = Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream;
      return new Response(stream, { status: 200, headers });
    }

    if (resource.startsWith("source/")) {
      const sha = resource.slice("source/".length);
      const repo = ctx.repo(projectId);
      if (!(await repo.exists())) throw new EngineError(404, "NOT_FOUND", "Not found");
      const full = await repo.resolve(sha);
      if (!full) throw new EngineError(404, "NOT_FOUND", "Not found");
      const { stream } = await repo.archiveStream(full);
      headers.set("content-type", "application/zip");
      headers.set("content-disposition", contentDisposition("attachment", `${projectId}-${full.slice(0, 7)}.zip`));
      headers.set("cache-control", "private, no-store");
      headers.set("x-commit-sha", full);
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
    }

    // `preview-image` and anything else: nothing to serve (captures arrive in phase 3).
    throw new EngineError(404, "NOT_FOUND", "Not found");
  });

  return r;
}
