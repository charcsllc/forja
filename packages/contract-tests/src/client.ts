/**
 * Minimal client for the v1 wire format: `{ errors, data }` with an `api-key` header.
 *
 * What this file protects: the simulators see the backend exactly as the UI's server
 * proxy does (apps/web `app/api/vcaas/[...path]/route.ts`): JSON bodies, the upstream
 * envelope untouched, and HTTP status kept alongside so contract checks can assert it.
 * A non-JSON body is reported as `errors.errorCode = "NON_JSON_BODY"` (the UI turns it
 * into a 500 UNKNOWN), never thrown.
 *
 * TODO(phase-0): switch the envelope types to @forja/contracts (v1/envelope).
 */

export interface UpstreamError {
  errorCode: string;
  errorMessage: string;
  errorDetails?: unknown;
}

export interface ApiResult<T = unknown> {
  status: number;
  errors: UpstreamError | null;
  data: T | null;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface ClientOptions {
  /** Origin of the backend, e.g. http://localhost:4000. Default: `FORJA_ENGINE_URL`. */
  baseUrl?: string;
  /** Sent as `api-key`. Default: `FORJA_ENGINE_KEY`. */
  apiKey?: string;
  /** Path prefix of the v1 surface. Default: `FORJA_ENGINE_V1_PREFIX` or `/v1`. */
  prefix?: string;
  /** Per-request timeout. Default 30 s. */
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}

export interface V1Client {
  readonly baseUrl: string;
  get<T = unknown>(path: string, query?: Query): Promise<ApiResult<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  put<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
  delete<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>>;
}

export function createClient(opts: ClientOptions = {}): V1Client {
  const env = opts.env ?? process.env;
  const baseUrl = (opts.baseUrl ?? env.FORJA_ENGINE_URL ?? "").replace(/\/+$/, "");
  if (!baseUrl) throw new Error("FORJA_ENGINE_URL is not set (or pass baseUrl)");
  const apiKey = opts.apiKey ?? env.FORJA_ENGINE_KEY ?? "";
  const prefix = `/${(opts.prefix ?? env.FORJA_ENGINE_V1_PREFIX ?? "/v1").replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const doFetch = opts.fetch ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<ApiResult<T>> {
    const url = new URL(`${baseUrl}${prefix}/${path.replace(/^\/+/, "")}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    if (apiKey) headers["api-key"] = apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await doFetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { status: res.status, errors: { errorCode: "NON_JSON_BODY", errorMessage: text.slice(0, 200) }, data: null };
    }
    if (json === null || typeof json !== "object" || !("errors" in json) || !("data" in json)) {
      return { status: res.status, errors: { errorCode: "NOT_AN_ENVELOPE", errorMessage: "response is JSON but not { errors, data }" }, data: null };
    }
    const env = json as { errors: UpstreamError | null; data: T | null };
    return { status: res.status, errors: env.errors ?? null, data: env.data ?? null };
  }

  return {
    baseUrl,
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body) => request("POST", path, body ?? {}),
    put: (path, body) => request("PUT", path, body ?? {}),
    patch: (path, body) => request("PATCH", path, body ?? {}),
    delete: (path, body) => request("DELETE", path, body),
  };
}
