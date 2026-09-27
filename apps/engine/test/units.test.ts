import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SecretBox, envHash } from "../src/services/secrets.js";
import { sniffMime } from "../src/services/uploads.js";
import { MemoryStore } from "../src/store/memory.js";
import { acquire, tryAcquire } from "../src/services/operations.js";
import { activeProject, makeTestEngine } from "./fakes.js";

describe("SecretBox (AES-256-GCM)", () => {
  const box = new SecretBox(randomBytes(32).toString("base64"));
  it("round-trips and binds the ciphertext to project/name/environment", () => {
    const sealed = box.seal("p1", "API_KEY", "both", "s3cr3t ✓");
    const row = { projectId: "p1", name: "API_KEY", environment: "both", ...sealed };
    expect(box.open(row)).toBe("s3cr3t ✓");
    expect(sealed.ciphertext).not.toContain("s3cr3t");
    expect(() => box.open({ ...row, projectId: "p2" })).toThrow();
    expect(() => box.open({ ...row, name: "OTHER" })).toThrow();
    const tampered = Buffer.from(sealed.ciphertext, "base64");
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => box.open({ ...row, ciphertext: tampered.toString("base64") })).toThrow();
    expect(() => new SecretBox(randomBytes(32).toString("base64")).open(row)).toThrow();
  });
  it("envHash is order independent", () => {
    expect(envHash({ A: "1", B: "2" })).toBe(envHash({ B: "2", A: "1" }));
    expect(envHash({ A: "1" })).not.toBe(envHash({ A: "2" }));
  });
});

describe("sniffMime", () => {
  it.each([
    [Buffer.from("89504e470d0a1a0a00", "hex"), "x.bin", "image/png"],
    [Buffer.from("ffd8ffe000", "hex"), "", "image/jpeg"],
    [Buffer.from("GIF89a...."), "", "image/gif"],
    [Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]), "", "image/webp"],
    [Buffer.from("%PDF-1.7\n"), "", "application/pdf"],
    [Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), "a.svg", "image/svg+xml"],
    [Buffer.from("a,b\n1,2\n"), "data.csv", "text/csv; charset=utf-8"],
    [Buffer.from("hola"), "notes", "text/plain; charset=utf-8"],
    [Buffer.from("504b0304", "hex"), "doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ])("%#: %s → %s", (bytes, name, mime) => {
    expect(sniffMime(bytes, name)?.mime).toBe(mime);
  });
  it.each([
    [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), "ELF"],
    [Buffer.from("MZ\x90\x00"), "PE"],
    [Buffer.from("#!/bin/sh\necho hi\n"), "shebang"],
    [Buffer.from([0x00, 0xff, 0x13, 0x37, 0x00]), "unknown binary"],
    [Buffer.alloc(0), "empty"],
  ])("refuses %s", (bytes) => {
    expect(sniffMime(bytes, "x.png")).toBeNull();
  });
});

describe("operation slot", () => {
  it("one heavy operation per project; stale slots are taken over; release needs the token", async () => {
    const store = new MemoryStore();
    const t1 = await acquire(store, "p1", "rebuild");
    await expect(acquire(store, "p1", "restoreVersion")).rejects.toMatchObject({ code: "OPERATION_IN_PROGRESS", status: 409 });
    expect((await tryAcquire(store, "p2", "rebuild")).ok).toBe(true);
    expect(await store.releaseOperation("p1", "wrong")).toBe(false);
    expect(await store.releaseOperation("p1", t1)).toBe(true);
    await store.acquireOperation("p3", "wake", -1000, { token: "old" });
    const r = await tryAcquire(store, "p3", "restartServer");
    expect(r.ok).toBe(true);
    expect(await store.releaseOperation("p3", "old")).toBe(false);
  });
});

describe("v2 preview proxy", () => {
  let server: Server;
  let origin = "";
  const seen: { method?: string; url?: string; headers?: Record<string, unknown>; body?: string }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        if (req.url?.startsWith("/redirect")) {
          res.writeHead(307, { location: "/login", connection: "keep-alive" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html", "set-cookie": ["a=1", "b=2"], "x-app": "yes" });
        res.end(`<html>${req.method} ${req.url} ${body}</html>`);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("forwards path, query (minus target), bodies; passes redirects as-is; never forwards api-key", async () => {
    const e = makeTestEngine({ repo: "fake" });
    const id = await activeProject(e, "proxied");
    e.ctx.previewOrigin = (_id, target) => (target === "app" ? origin : "http://127.0.0.1:1");
    const get = await e.call("GET", `/v2/projects/${id}/preview/products/1?x=1&target=app`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("<html>GET /products/1?x=1 </html>");
    expect(get.headers.get("x-app")).toBe("yes");
    expect(get.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    const last = seen.at(-1);
    expect(last?.headers?.["api-key"]).toBeUndefined();
    expect(last?.headers?.["accept-encoding"]).toBe("identity");

    const root = await e.call("GET", `/v2/projects/${id}/preview`);
    expect(await root.text()).toBe("<html>GET / </html>");

    const post = await e.call("POST", `/v2/projects/${id}/preview/api/form`, { a: 1 });
    expect(await post.text()).toBe('<html>POST /api/form {"a":1}</html>');

    const redirect = await e.call("GET", `/v2/projects/${id}/preview/redirect`);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/login");
    expect(redirect.headers.get("connection")).toBeNull();

    const verify = await e.call("GET", `/v2/projects/${id}/preview/?target=verify`);
    expect(verify.status).toBe(503);
  });

  it("503 while not Active, 404 for unknown projects (v2 shape)", async () => {
    const e = makeTestEngine({ repo: "fake" });
    await e.json("POST", "/v1/projects", { projectId: "not-yet", description: "" });
    const res = await e.call("GET", "/v2/projects/not-yet/preview/");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "SERVER_NOT_READY", message: expect.any(String) } });
    expect((await e.call("GET", "/v2/projects/nope-nope/preview/")).status).toBe(404);
  });
});
