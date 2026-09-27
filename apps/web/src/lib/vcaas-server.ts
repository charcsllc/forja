/**
 * ═══ THE SERVER LAYER — SPLIT OUT SO THE CLIENT CAN BE A STRAIGHT COPY ══════
 *
 * ⚠️ THIS FILE EXISTS BECAUSE `src/lib/vcaas.ts` IS NOW A VERBATIM COPY of
 * totalum-platform's client, and the platform keeps its key-holding half in
 * `vcaas-server.ts`. Same split, same file name, so both repos can take each
 * other's changes without a merge. Everything below is this project's original
 * server code, moved rather than rewritten.
 *
 * ⚠️ NEVER IMPORT THIS FROM A CLIENT COMPONENT. It reads the API key.
 */
import { readFileSync } from "node:fs";

/**
 * Base URL for every Totalum API endpoint. Single source of truth.
 * 📖 API reference: https://www.totalum.app/totalum-api.md
 */
const VCAAS_BASE_URL = "https://api-accounts.totalum.app/api/v1/vcaas";

/**
 * ═══ TWO BACKENDS, ONE CONTRACT (Forja Engine, phase 1) ══════════════════════
 *
 * ⭐ `FORJA_ENGINE_URL` SET ⇒ THE SELF-HOSTED ENGINE; UNSET ⇒ TOTALUM, EXACTLY AS BEFORE.
 * The engine speaks the same v1 contract under `${FORJA_ENGINE_URL}/v1`, so every
 * route and every client function is unchanged; only the base URL and the key differ.
 * See `docs/architecture/05-data-model-and-api.md` §2 and `08-migration-plan.md` (Fase 1).
 */
export type BackendKind = "engine" | "totalum";

/** The engine's root URL without a trailing slash, or `null` when the engine is not configured. */
export function getEngineUrl(): string | null {
  const raw = (process.env.FORJA_ENGINE_URL || "").trim().replace(/\/+$/, "");
  return raw || null;
}

export function getBackendKind(): BackendKind {
  return getEngineUrl() ? "engine" : "totalum";
}

/**
 * The base every `/api/vcaas/*` path is appended to. Read per call (not at module load)
 * so the same build serves either backend depending on the runtime environment.
 */
function activeBaseUrl(): string {
  const engine = getEngineUrl();
  return engine ? `${engine}/v1` : VCAAS_BASE_URL;
}

/**
 * ═══⭐⭐⭐ EVERY UPSTREAM URL MUST STAY INSIDE `/api/v1/vcaas/` ═══════════════
 *
 * ⚠️⚠️ THIS APP HOLDS AN ACCOUNT-WIDE KEY AND HAS NO LOGIN. The key authorises far
 * more than the VCaaS surface — API-key management, billing, account settings — so
 * the only thing keeping a request on the intended surface is that every proxied
 * path lands under `/api/v1/vcaas/`.
 *
 * ⚠️⚠️ AND A NAIVE JOIN DOES NOT GUARANTEE IT. Paths are built from route params,
 * which the framework hands over already decoded, so a traversal segment (dot-dot, in
 * any of its encoded or backslash spellings) can survive into the joined string; `fetch`
 * then normalises it and the request can land OUTSIDE `/api/v1/vcaas/`, on another part
 * of the account API the key also authorises.
 *
 * ⚠️ SO THE CHECK RUNS ON THE URL `fetch` WILL ACTUALLY REQUEST, not on the string
 * we built. Filtering dot segments out of the input is a losing game (encodings,
 * backslashes, double-decoding); resolving the URL first and then checking where it
 * points is the one test that cannot be talked around. Both request helpers go through
 * here, so no route can forget it.
 */
export class VcaasPathError extends Error {
  constructor(path: string) {
    super(`Refused to proxy a path outside the VCaaS API: ${JSON.stringify(path)}`);
    this.name = "VcaasPathError";
  }
}

/** Resolve `path` against the API base and refuse anything that escapes it. */
export function resolveVcaasUrl(path: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) throw new VcaasPathError(String(path));
  return resolveUnderBase(activeBaseUrl(), path);
}

/**
 * ⚠️ THE SAME GUARANTEE FOR THE ENGINE'S OTHER SURFACES (`/v2/...`, `/v1/public/...`),
 * which the preview, budget and file routes reach without going through `/v1` of the
 * catch-all. `prefix` is the engine-relative surface the request must stay inside, e.g.
 * `/v2/projects/<id>/preview`. Throws when the engine is not configured.
 */
export function resolveEngineUrl(prefix: string, path = ""): string {
  const engine = getEngineUrl();
  if (!engine) throw new VcaasPathError(`${prefix}${path}`);
  if (path && !path.startsWith("/")) throw new VcaasPathError(path);
  return resolveUnderBase(`${engine}${prefix}`, path);
}

/**
 * The check itself, relative to whichever base is active. The origin AND the base's
 * pathname prefix are both compared against the RESOLVED url.
 */
function resolveUnderBase(baseUrl: string, path: string): string {
  if (typeof path !== "string" || (path !== "" && !path.startsWith("/"))) throw new VcaasPathError(String(path));

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    // A malformed FORJA_ENGINE_URL: refuse rather than guess.
    throw new VcaasPathError(path);
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new VcaasPathError(path);
  const origin = base.origin;
  const prefix = base.pathname.replace(/\/+$/, ""); // "/api/v1/vcaas" or "/v1"

  /**
   * ⚠️ DEFENCE IN DEPTH — REFUSE AN ENCODED TRAVERSAL IN THE PATH ITSELF. The real
   * request cannot reach here still-encoded (route params arrive decoded, so a traversal
   * arrives as `/../…` and the origin+prefix check below stops it). But a
   * `%2e`/`%2f`/`%5c` left in the PATH would pass that check as an opaque segment and
   * could be decoded by the upstream server into a traversal. The QUERY STRING is left
   * untouched — `files/content?path=src%2Fapp%2Fpage.tsx` is legitimate and common.
   */
  const pathOnly = path.split("?", 1)[0].toLowerCase();
  if (/%2e|%2f|%5c/.test(pathOnly)) throw new VcaasPathError(path);

  const url = new URL(`${origin}${prefix}${path}`);
  const inside = url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  if (url.origin !== origin || !inside) throw new VcaasPathError(path);
  return url.toString();
}

// ═══════════════════════════════════════════════════════════════════════════
//  SERVER LAYER — runs only inside Route Handlers (`src/app/api/*`)
//  Reads the API key and is the only code that hits the backend (Totalum or the engine).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The backend API key, read from the environment.
 *
 * ⭐ ENGINE MODE (`FORJA_ENGINE_URL` set): `FORJA_ENGINE_KEY`, else the shared key file
 * (see `getEngineApiKey`). The Totalum variables are then ignored.
 *
 * TOTALUM MODE (the rest of this comment):
 * This is the only credential the app requires (see README). The documented
 * name is `TOTALUM_VCAAS_API_KEY`; the legacy `VCAAS_API_KEY` is still accepted
 * as a fallback so older setups keep working. Returns an empty string when
 * unset so callers still get a structured `{ errors }` response from VCaaS (an
 * auth error) rather than a thrown exception.
 *
 * Server-only in practice: on the client `process.env.TOTALUM_VCAAS_API_KEY` is
 * `undefined` (non-public env var), so this returns `""` there — but the client
 * layer never calls it.
 */
export function getVcaasApiKey(): string {
  if (getBackendKind() === "engine") return getEngineApiKey();
  return process.env.TOTALUM_VCAAS_API_KEY || process.env.VCAAS_API_KEY || "";
}

/**
 * ═══ THE ENGINE KEY: ENV FIRST, THEN THE SHARED FILE ═════════════════════════
 *
 * `FORJA_ENGINE_KEY` wins. Otherwise the file at `FORJA_ENGINE_KEY_FILE` (default
 * `/data/engine/engine.key`, written by the compose `init` service and mounted read-only
 * into `web`, see 05 §2.1). The file is read once and remembered; a MISSING file is not
 * remembered, so a web container that starts before `init` has written it picks the key
 * up on the next request instead of running keyless until restarted.
 */
const DEFAULT_ENGINE_KEY_FILE = "/data/engine/engine.key";
let engineKeyFromFile: string | null = null;

function getEngineApiKey(): string {
  const fromEnv = (process.env.FORJA_ENGINE_KEY || "").trim();
  if (fromEnv) return fromEnv;
  if (engineKeyFromFile) return engineKeyFromFile;
  const file = (process.env.FORJA_ENGINE_KEY_FILE || "").trim() || DEFAULT_ENGINE_KEY_FILE;
  try {
    // A runtime path outside the app: keep the build tracer from pulling the whole repo in.
    const value = readFileSync(/*turbopackIgnore: true*/ file, "utf8").trim();
    if (value) engineKeyFromFile = value;
  } catch {
    // Not there (yet). Never log the path's contents; the path itself is not secret.
  }
  return engineKeyFromFile ?? "";
}

/**
 * ═══ WHAT THE BROWSER NEEDS TO KNOW ABOUT THE BACKEND (never the key) ═════════
 *
 * Publish URLs are `${publishScheme}://<host>`; hosts default to `<id>.${publishDomain}`.
 * With the engine these come from `GET /v1/system/public-config` (cached 60 s); with
 * Totalum they are its documented convention.
 */
export interface BackendPublicConfig {
  publishScheme: "http" | "https";
  publishDomain: string;
  previewDomain: string | null;
}

const TOTALUM_PUBLIC_CONFIG: BackendPublicConfig = {
  publishScheme: "https",
  publishDomain: "totalum-project.com",
  previewDomain: null,
};

/** Used when the engine does not answer: the local-install defaults (04 §4). */
const ENGINE_FALLBACK_PUBLIC_CONFIG: BackendPublicConfig = {
  publishScheme: "http",
  publishDomain: "apps.forja.localhost",
  previewDomain: "forja.localhost",
};

const PUBLIC_CONFIG_TTL_MS = 60_000;
let publicConfigCache: { value: BackendPublicConfig; at: number; engine: string } | null = null;

function isHostLike(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 253 && /^[a-z0-9.:-]+$/i.test(value);
}

export async function getBackendPublicConfig(): Promise<BackendPublicConfig> {
  const engine = getEngineUrl();
  if (!engine) return TOTALUM_PUBLIC_CONFIG;

  const hit = publicConfigCache;
  if (hit && hit.engine === engine && Date.now() - hit.at < PUBLIC_CONFIG_TTL_MS) return hit.value;

  let value = ENGINE_FALLBACK_PUBLIC_CONFIG;
  try {
    const res = await fetch(resolveEngineUrl("/v1", "/system/public-config"), {
      headers: { "api-key": getEngineApiKey() },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(2_000),
    });
    const json = (await res.json().catch(() => null)) as
      | { data?: Partial<BackendPublicConfig> } & Partial<BackendPublicConfig>
      | null;
    // Accept both the v1 envelope `{errors, data}` and a plain object.
    const raw = (json && (json.data ?? json)) as Partial<BackendPublicConfig> | null;
    if (res.ok && raw) {
      value = {
        publishScheme: raw.publishScheme === "https" ? "https" : raw.publishScheme === "http" ? "http" : ENGINE_FALLBACK_PUBLIC_CONFIG.publishScheme,
        publishDomain: isHostLike(raw.publishDomain) ? raw.publishDomain : ENGINE_FALLBACK_PUBLIC_CONFIG.publishDomain,
        previewDomain: isHostLike(raw.previewDomain) ? raw.previewDomain : ENGINE_FALLBACK_PUBLIC_CONFIG.previewDomain,
      };
      // Only a real answer is cached; a failure is re-asked on the next request.
      publicConfigCache = { value, at: Date.now(), engine };
    }
  } catch {
    // Engine unreachable: fall back without caching.
  }
  return value;
}

/**
 * ═══ OWN `/api/files/<token>` URLS (engine only) ═════════════════════════════
 *
 * The engine issues upload URLs as `${APP_URL}/api/files/<token>` (05 §2.3). When the
 * server itself needs those bytes (visual-edit assets, the source archive), it must not
 * fetch its own public URL — inside a container that host may not even resolve — and it
 * must not open the SSRF guard for it. It recognises exactly that shape and asks the
 * engine for `/v1/public/<token>` instead.
 *
 * Returns the token, or `null` for every other URL (which then goes through the normal,
 * guarded path). `requestOrigin` is this request's own origin; `NEXT_PUBLIC_APP_URL` is
 * accepted too because behind a reverse proxy the two can differ.
 */
const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_\-.]{1,4096}$/;

export function isValidPublicToken(token: string): boolean {
  return PUBLIC_TOKEN_RE.test(token) && token !== "." && token !== "..";
}

export function ownFilesToken(rawUrl: string, requestOrigin: string | null): string | null {
  if (getBackendKind() !== "engine") return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const origins = new Set<string>();
  if (requestOrigin) origins.add(requestOrigin);
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || "").trim();
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin);
    } catch {
      /* ignore a malformed NEXT_PUBLIC_APP_URL */
    }
  }
  if (!origins.has(url.origin)) return null;
  // Exactly `/api/files/<token>`: one segment, no query games.
  const match = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
  if (!match) return null;
  let token: string;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  return isValidPublicToken(token) ? token : null;
}

/**
 * GET a signed public resource from the engine. **No `api-key`**: the token is the
 * authorisation, and the key must never travel on a path whose bytes go to a browser.
 */
export async function fetchEnginePublic(
  token: string,
  init: { signal?: AbortSignal; headers?: HeadersInit } = {}
): Promise<Response> {
  if (!isValidPublicToken(token)) throw new VcaasPathError(token);
  return fetch(resolveEngineUrl("/v1/public", `/${encodeURIComponent(token)}`), {
    method: "GET",
    headers: init.headers,
    redirect: "error",
    cache: "no-store",
    signal: init.signal ?? AbortSignal.timeout(60_000),
  });
}

/**
 * A key-bearing request to an engine surface outside `/v1` (budget, preview). The
 * caller names the surface prefix; `resolveEngineUrl` keeps the request inside it.
 */
export async function engineRequest(prefix: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("api-key", getEngineApiKey());
  return fetch(resolveEngineUrl(prefix, path), { ...init, headers });
}

/**
 * Make a JSON request to a VCaaS endpoint and return the raw `Response`.
 *
 * `Content-Type: application/json` is set automatically whenever a body is
 * present; do NOT use this for multipart uploads (use `vcaasUploadRequest`),
 * because a hardcoded JSON content-type would corrupt the multipart boundary.
 *
 * @param path    Endpoint path after `/api/v1/vcaas`, e.g. `/projects/${id}`.
 * @param options Standard fetch options (method, body, ...). The `api-key`
 *                header is injected here and should not be passed in.
 */
export async function vcaasRequest(
  path: string,
  options: RequestInit = {},
  /**
   * ⚠️ ACCEPTED AND IGNORED, ON PURPOSE. totalum-platform's signature takes a per-user
   * context here because each of its users has their own hidden VCaaS key; this app has
   * exactly one key in its environment. Keeping the parameter means a route copied from
   * the platform compiles and behaves correctly without an edit — see `api/vcaas/_shared`.
   */
  _ctx?: { accountUserId?: string }
): Promise<Response> {
  const headers: Record<string, string> = {
    "api-key": getVcaasApiKey(),
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  return fetch(resolveVcaasUrl(path), {
    ...options,
    headers,
  });
}

/**
 * Make a multipart/form-data request to a VCaaS endpoint (e.g. file uploads).
 *
 * Only the `api-key` header is set — the `Content-Type` (with its multipart
 * boundary) is left for `fetch` to derive from the `FormData` body, which is
 * why uploads can't reuse `vcaasRequest`.
 *
 * @param path     Endpoint path after `/api/v1/vcaas`,
 *                 e.g. `/projects/${id}/files/upload`.
 * @param formData The multipart payload to forward.
 */
export async function vcaasUploadRequest(
  path: string,
  formData: FormData
): Promise<Response> {
  return fetch(resolveVcaasUrl(path), {
    method: "POST",
    headers: { "api-key": getVcaasApiKey() },
    body: formData,
  });
}
