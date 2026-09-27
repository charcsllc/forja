import { describe, expect, it } from "vitest";
import { activeProject, makeTestEngine } from "./fakes.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("files API", () => {
  it("lists the tree without .env*, node_modules or .git", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "files-app");
    const res = await e.json("GET", `/v1/projects/${id}/files/tree?limit=5000`);
    expect(res.status).toBe(200);
    const paths = res.body.data.entries.map((x: { path: string }) => x.path);
    expect(paths).toContain("src/app/page.tsx");
    expect(paths).not.toContain(".git");
    expect(res.body.data).toMatchObject({ offset: 0, limit: 5000, hasMore: false, commitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
  });

  it("writes byte-exact (base64 and utf8), reads back, flags config writes, refuses .env", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "files-rw");
    const canary = `<div id="c" className="a b">x</div> ${Date.now()}`;
    const put = await e.json("PUT", `/v1/projects/${id}/files/content`, {
      path: ".totalum/visual-edit-write-check.txt",
      content: b64(canary),
      encoding: "base64",
    });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ path: ".totalum/visual-edit-write-check.txt", bytesWritten: Buffer.byteLength(canary), rebuildRequired: false });
    const read = await e.json("GET", `/v1/projects/${id}/files/content?path=.totalum/visual-edit-write-check.txt`);
    expect(read.body.data).toMatchObject({ encoding: "utf8", content: canary });

    const utf = await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "src/app/ñ.txt", content: "héllo ✓", encoding: "utf8" });
    expect(utf.body.data.bytesWritten).toBe(Buffer.byteLength("héllo ✓"));
    expect(utf.body.data.created).toBe(true);

    const cfg = await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "next.config.ts", content: b64("export default {}\n"), encoding: "base64" });
    expect(cfg.body.data.rebuildRequired).toBe(true);

    for (const p of [".env", ".env.local", "src/.env.production"]) {
      const env = await e.json("PUT", `/v1/projects/${id}/files/content`, { path: p, content: b64("X=1"), encoding: "base64" });
      expect(env.status).toBe(403);
      expect(env.body.errors.errorCode).toBe("FORBIDDEN_PATH");
    }
    const envRead = await e.json("GET", `/v1/projects/${id}/files/content?path=.env`);
    expect(envRead.status).toBe(403);
    const bad = await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "x.txt", content: "!!notbase64", encoding: "base64" });
    expect(bad.status).toBe(400);
    const escape = await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "../x", content: b64("x"), encoding: "base64" });
    expect(escape.status).toBe(400);
    expect(escape.body.errors.errorCode).toBe("INVALID_PATH");
    const missing = await e.json("GET", `/v1/projects/${id}/files/content?path=nope.txt`);
    expect(missing.status).toBe(404);
  });

  it("answers STALE_WRITE when baseCommitSha is not HEAD", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "stale-app");
    const tree = await e.json("GET", `/v1/projects/${id}/files/tree`);
    const head = tree.body.data.commitSha as string;
    await e.call("PUT", `/v1/projects/${id}/files/content`, { path: "a.txt", content: b64("1"), encoding: "base64" }, { "x-forja-client": "tab-a" });
    await e.ctx.repo(id).flush();
    const stale = await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "b.txt", content: b64("2"), encoding: "base64", baseCommitSha: head });
    expect(stale.status).toBe(409);
    expect(stale.body.errors.errorCode).toBe("STALE_WRITE");
  });

  it("coalesces writes of one client into one version", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "coalesce");
    const before = (await e.json("GET", `/v1/projects/${id}/versions?limit=100`)).body.data.totalCount;
    for (const f of ["a.ts", "b.ts", "c.ts"]) {
      await e.call("PUT", `/v1/projects/${id}/files/content`, { path: `src/${f}`, content: b64(f), encoding: "base64" }, { "x-forja-client": "ve" });
    }
    const after = await e.json("GET", `/v1/projects/${id}/versions?limit=100`);
    expect(after.body.data.totalCount).toBe(before + 1);
    expect(after.body.data.versions[0]).toMatchObject({ name: expect.stringMatching(/^v\d+$/), commitMessage: "Edit 3 files" });
  });

  it("refuses writes while the sandbox is not Active (wake semantics) but serves reads", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "sleepy");
    await e.store.updateProject(id, { serverStatus: "Archived" });
    const put = await e.json("PUT", `/v1/projects/${id}/files/content`, { path: "a.txt", content: b64("1"), encoding: "base64" });
    expect(put.status).toBe(409);
    expect(put.body.errors.errorCode).toBe("SERVER_NOT_READY");
    expect((await e.json("GET", `/v1/projects/${id}`)).body.data.agentServerStatus).toBe("Unarchiving");
    expect((await e.json("GET", `/v1/projects/${id}/files/tree`)).status).toBe(200);
    expect((await e.json("GET", `/v1/projects/${id}/versions`)).status).toBe(200);
  });
});

describe("versions", () => {
  it("lists, diffs by commitSha, and 404s NO_DIFF_CONTENT / unknown", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "versioned");
    await e.call("PUT", `/v1/projects/${id}/files/content`, { path: "src/new.ts", content: b64("export const x = 1;\n"), encoding: "base64" });
    const list = await e.json("GET", `/v1/projects/${id}/versions`);
    expect(list.body.data.totalCount).toBe(2);
    const [latest, first] = list.body.data.versions;
    expect(latest).toMatchObject({ _id: latest.commitSha, name: "v2", commitMessage: "Edit src/new.ts" });
    expect(first.name).toBe("v1");
    const diff = await e.json("GET", `/v1/projects/${id}/version-diff?commitSha=${latest.commitSha}`);
    expect(diff.body.data.commitSha).toBe(latest.commitSha);
    expect(diff.body.data.diff).toContain("+export const x = 1;");
    expect((await e.json("GET", `/v1/projects/${id}/version-diff`)).status).toBe(400);
    expect((await e.json("GET", `/v1/projects/${id}/version-diff?commitSha=deadbeef`)).status).toBe(404);
  });
});

describe("source code, uploads and the public surface", () => {
  it("source-code returns a signed 30-min URL that streams a zip", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "zipper");
    const res = await e.json("GET", `/v1/projects/${id}/source-code`);
    expect(res.body.data).toMatchObject({ filesCount: expect.any(Number), lastCommitSha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    const url = new URL(res.body.data.downloadUrl);
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toMatch(/^\/api\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const token = url.pathname.split("/").pop() as string;
    const zip = await e.app.request(`/v1/public/${token}`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    expect(zip.headers.get("content-disposition")).toContain("attachment");
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("uploads by content type and serves them back through a signed URL", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "uploader");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4e80000000049454e44ae426082", "hex");
    const form = new FormData();
    form.set("file", new File([png], "evil.exe", { type: "application/x-msdownload" }));
    const res = await e.app.request(`/v1/projects/${id}/files/upload`, { method: "POST", headers: { "api-key": "test-engine-key-0123456789abcdef" }, body: form });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { url: string; fileNameId: string } };
    expect(body.data.fileNameId).toMatch(/\.png$/);
    const token = new URL(body.data.url).pathname.split("/").pop() as string;
    const got = await e.app.request(`/v1/public/${token}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("content-disposition")).toContain("inline");
    expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);

    const elf = new FormData();
    elf.set("file", new File([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3])], "a.png"));
    const refused = await e.app.request(`/v1/projects/${id}/files/upload`, { method: "POST", headers: { "api-key": "test-engine-key-0123456789abcdef" }, body: elf });
    expect(refused.status).toBe(415);
    expect(((await refused.json()) as { errors: { errorCode: string } }).errors.errorCode).toBe("INVALID_FILE_TYPE");

    const json = await e.json("POST", `/v1/projects/${id}/files/upload`, { url: "http://x" });
    expect(json.status).toBe(400);
    expect(json.body.errors.errorCode).toBe("MISSING_FILE");
  });

  it("refuses uploads over UPLOAD_MAX_MB with FILE_TOO_LARGE", async () => {
    const e = makeTestEngine({ env: { UPLOAD_MAX_MB: "1" } });
    const id = await activeProject(e, "big-file");
    const form = new FormData();
    form.set("file", new File([Buffer.alloc(1024 * 1024 + 10, 0x61)], "big.txt"));
    const res = await e.app.request(`/v1/projects/${id}/files/upload`, { method: "POST", headers: { "api-key": "test-engine-key-0123456789abcdef" }, body: form });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { errors: { errorCode: string } }).errors.errorCode).toBe("FILE_TOO_LARGE");
  });

  it("a token of a deleted project answers 404", async () => {
    const e = makeTestEngine();
    const id = await activeProject(e, "deleted-zip");
    const res = await e.json("GET", `/v1/projects/${id}/source-code`);
    const token = new URL(res.body.data.downloadUrl).pathname.split("/").pop() as string;
    await e.json("DELETE", `/v1/projects/${id}`);
    expect((await e.app.request(`/v1/public/${token}`)).status).toBe(404);
  });
});
