/**
 * `CmsPort` over `@forja/db-cms` (05 §6): the only engine file that imports that package.
 *
 * Protects:
 * - Two small connection pools per project, over the project's internal network
 *   (`forja-db-<id>:5432`, reachable because the engine attaches itself to `forja-int-<id>`):
 *   `cms_ro` for introspection and queries, `cms_rw` for writes. Never the superuser, never
 *   `app_rw`. No column transforms (the CMS maps names itself).
 * - The introspected structure is cached for a few seconds per project and refreshed once
 *   when a call fails with TABLE_NOT_FOUND / PROPERTY_NOT_FOUND (the app migrated meanwhile).
 * - File fields `{name}` are turned into signed public URLs (`/api/files/<token>`).
 * - `CmsError`s keep their code and status on the wire; a database that does not answer is
 *   409 SERVER_NOT_READY (the UI's wake flow), never a 500.
 * - `release(projectId)` closes the pools (archive, delete, re-provision with new passwords).
 */
import postgres from "postgres";
import {
  createRecord,
  deleteRecord,
  executeQuery,
  introspect,
  isCmsError,
  link,
  tablesStructureResult,
  unlink,
  updateRecord,
  type CmsStructure,
} from "@forja/db-cms";
import { EngineError } from "../http/errors.js";
import type { CmsPort, LinkInput } from "./cms.js";

export interface DbCmsAdapterOptions {
  /** `postgres://cms_ro:…@forja-db-<id>:5432/app` and the `cms_rw` twin. */
  urls(projectId: string): Promise<{ ro: string; rw: string }>;
  /** Signed public URL of an upload (`{name}` of file fields). */
  fileUrl(projectId: string, fileNameId: string): string;
  structureTtlMs?: number;
}

interface Pools {
  ro: postgres.Sql;
  rw: postgres.Sql;
  structure: { value: CmsStructure; at: number } | null;
}

const CONNECTION_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH", "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_ENDED", "CONNECTION_DESTROYED", "57P03"]);

function translate(err: unknown): never {
  if (isCmsError(err)) {
    throw new EngineError(err.status as 400, err.code, err.message, { ...err.details });
  }
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && CONNECTION_ERRORS.has(code)) {
    throw new EngineError(409, "SERVER_NOT_READY", "The project's database is not reachable yet; try again in a moment.");
  }
  throw err;
}

export function createDbCmsAdapter(opts: DbCmsAdapterOptions): CmsPort {
  const pools = new Map<string, Promise<Pools>>();
  const ttl = opts.structureTtlMs ?? 5_000;

  const open = (url: string) =>
    postgres(url, { max: 2, idle_timeout: 30, connect_timeout: 10, onnotice: () => {}, connection: { application_name: "forja-cms" } });

  function poolsFor(projectId: string): Promise<Pools> {
    let p = pools.get(projectId);
    if (!p) {
      p = opts.urls(projectId).then((u) => ({ ro: open(u.ro), rw: open(u.rw), structure: null }));
      pools.set(projectId, p);
      p.catch(() => pools.delete(projectId));
    }
    return p;
  }

  async function structure(projectId: string, fresh = false): Promise<CmsStructure> {
    const p = await poolsFor(projectId);
    if (!fresh && p.structure && Date.now() - p.structure.at < ttl) return p.structure.value;
    const value = await introspect(p.ro);
    p.structure = { value, at: Date.now() };
    return value;
  }

  /** Runs `fn` with the cached structure; refreshes it once on a stale-structure error. */
  async function run<T>(projectId: string, fn: (p: Pools, s: CmsStructure) => Promise<T>): Promise<T> {
    try {
      const p = await poolsFor(projectId);
      try {
        return await fn(p, await structure(projectId));
      } catch (err) {
        if (isCmsError(err, "TABLE_NOT_FOUND") || isCmsError(err, "PROPERTY_NOT_FOUND")) {
          return await fn(p, await structure(projectId, true));
        }
        throw err;
      }
    } catch (err) {
      return translate(err);
    }
  }

  const decode = (projectId: string) => ({ resolveFileUrl: (name: string) => opts.fileUrl(projectId, name) });

  async function release(projectId: string): Promise<void> {
    const p = pools.get(projectId);
    pools.delete(projectId);
    if (!p) return;
    const resolved = await p.catch(() => null);
    if (resolved) await Promise.all([resolved.ro.end({ timeout: 2 }), resolved.rw.end({ timeout: 2 })]).catch(() => undefined);
  }

  return {
    async tablesStructure(projectId) {
      try {
        return tablesStructureResult(await structure(projectId, true));
      } catch (err) {
        return translate(err);
      }
    },
    query: (projectId, tableName, queryOptions) =>
      run(projectId, (p, s) => executeQuery(p.ro, s, tableName, queryOptions, decode(projectId))),
    createRecord: (projectId, tableName, data) => run(projectId, (p, s) => createRecord(p.rw, s, tableName, data, decode(projectId))),
    updateRecord: (projectId, tableName, recordId, data) =>
      run(projectId, (p, s) => updateRecord(p.rw, s, tableName, recordId, data, decode(projectId))),
    deleteRecord: (projectId, tableName, recordId) => run(projectId, (p, s) => deleteRecord(p.rw, s, tableName, recordId)),
    link: (projectId, i: LinkInput) => run(projectId, (p, s) => link(p.rw, s, i.tableName, i.recordId, i.propertyId, i.referenceId)),
    unlink: (projectId, i: LinkInput) => run(projectId, (p, s) => unlink(p.rw, s, i.tableName, i.recordId, i.propertyId, i.referenceId)),
    release,
    async close() {
      await Promise.all([...pools.keys()].map((id) => release(id)));
    },
  };
}
