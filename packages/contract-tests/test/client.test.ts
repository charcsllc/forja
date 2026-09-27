/** Client tests: envelope handling, api-key header, prefix and env defaults. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "../src/client.js";

let url = "";
const seen: { method?: string; path?: string; key?: string | string[]; body?: string }[] = [];
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    seen.push({ method: req.method, path: req.url, key: req.headers["api-key"], body });
    if (req.url?.startsWith("/v1/html")) {
      res.writeHead(502, { "content-type": "text/html" });
      return res.end("<html>bad gateway</html>");
    }
    if (req.url?.startsWith("/v1/bare")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"ok":true}');
    }
    if (req.url?.startsWith("/v1/fail")) {
      res.writeHead(409, { "content-type": "application/json" });
      return res.end(JSON.stringify({ errors: { errorCode: "SERVER_NOT_READY", errorMessage: "waking" }, data: null }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ errors: null, data: { echo: req.url } }));
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("createClient", () => {
  it("reads FORJA_ENGINE_URL / FORJA_ENGINE_KEY and sends api-key under /v1", async () => {
    const c = createClient({ env: { FORJA_ENGINE_URL: `${url}/`, FORJA_ENGINE_KEY: "k1" } });
    const r = await c.get("/projects/demo", { verify: true, skip: undefined });
    expect(r).toEqual({ status: 200, errors: null, data: { echo: "/v1/projects/demo?verify=true" } });
    expect(seen.at(-1)?.key).toBe("k1");
  });

  it("sends JSON bodies and keeps the HTTP status on errors", async () => {
    const c = createClient({ baseUrl: url, apiKey: "k", env: {} });
    const r = await c.post("fail", { a: 1 });
    expect(r.status).toBe(409);
    expect(r.errors?.errorCode).toBe("SERVER_NOT_READY");
    expect(seen.at(-1)?.body).toBe('{"a":1}');
  });

  it("reports non-JSON and non-envelope bodies instead of throwing", async () => {
    const c = createClient({ baseUrl: url, env: {} });
    expect((await c.get("html")).errors?.errorCode).toBe("NON_JSON_BODY");
    expect((await c.get("bare")).errors?.errorCode).toBe("NOT_AN_ENVELOPE");
  });

  it("supports another prefix (e.g. the Totalum shape)", async () => {
    const c = createClient({ baseUrl: url, prefix: "/api/v1/vcaas", env: {} });
    const r = await c.delete("projects/x");
    expect(r.data).toEqual({ echo: "/api/v1/vcaas/projects/x" });
  });

  it("refuses to run without a base URL", () => {
    expect(() => createClient({ env: {} })).toThrow(/FORJA_ENGINE_URL/);
  });
});
