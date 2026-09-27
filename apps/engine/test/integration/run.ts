/**
 * Phase 1 end-to-end check against a REAL engine (Docker sandboxes, Traefik, Postgres).
 *
 *   FORJA_ENGINE_URL=http://127.0.0.1:4000 FORJA_ENGINE_KEY=$(cat …/engine/engine.key) \
 *   TRAEFIK_URL=http://127.0.0.1:80 WEB_URL=http://127.0.0.1:3000 \
 *     npm run test:integration -w @forja/engine -- --yes [--keep]
 *
 * Creates a disposable project, walks every phase-1 surface (preview through Traefik and
 * through the engine proxy, files + HMR, versions/diff/restore, uploads + signed URLs,
 * database, source zip, rebuild, restart, archive → wake), runs the UI-polling simulators
 * of packages/contract-tests that apply in phase 1, optionally checks the same through the
 * web UI server, then deletes the project (unless --keep). Prints a transcript and a table.
 *
 * ⚠️ Mutating: refuses to run without --yes, and refuses Totalum hosts.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  createClient,
  formatResultsTable,
  simulateLaunch,
  simulateRebuild,
  simulateRestart,
  simulateRestore,
  simulateWake,
  type SimulationResult,
} from "@forja/contract-tests";

const ENGINE = (process.env.FORJA_ENGINE_URL ?? "").replace(/\/+$/, "");
const KEY = process.env.FORJA_ENGINE_KEY ?? "";
const TRAEFIK = (process.env.TRAEFIK_URL ?? "http://127.0.0.1:80").replace(/\/+$/, "");
const WEB = (process.env.WEB_URL ?? "").replace(/\/+$/, "");
const PREVIEW_DOMAIN = process.env.PREVIEW_DOMAIN ?? "forja.localhost";
const keep = process.argv.includes("--keep");
/** `--project <id>`: reuse an existing Active project instead of creating one (saves ~1 GB of disk). */
const reuse = (() => {
  const i = process.argv.indexOf("--project");
  return i === -1 ? undefined : process.argv[i + 1];
})();

const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
function check(cond: unknown, what: string): void {
  if (cond) log(`  ✓ ${what}`);
  else {
    log(`  ✗ ${what}`);
    failures.push(what);
  }
}

async function api(method: string, path: string, body?: unknown, prefix = "/v1"): Promise<{ status: number; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(`${ENGINE}${prefix}${path}`, {
    method,
    headers: { "api-key": KEY, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json };
}

/** GET through Traefik with a Host header (fetch cannot set Host). */
function viaTraefik(host: string, path = "/"): Promise<{ status: number; body: string }> {
  const u = new URL(TRAEFIK);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port || 80), path, method: "GET", headers: { host } }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(60_000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

async function waitActive(id: string, timeoutMs = 10 * 60_000): Promise<void> {
  let last = "";
  await waitFor(
    `${id} Active`,
    async () => {
      const p = await api("GET", `/projects/${id}`);
      const s = `${p.json.data?.agentServerStatus}${p.json.data?.serverErrorMessage ? ` (${p.json.data.serverErrorMessage.split("\n")[0]})` : ""}`;
      if (s !== last) log(`  status: ${s}`);
      last = s;
      return p.json.data?.agentServerStatus === "Active";
    },
    timeoutMs,
  );
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

async function main(): Promise<number> {
  if (!ENGINE || !KEY) {
    console.error("FORJA_ENGINE_URL and FORJA_ENGINE_KEY are required");
    return 2;
  }
  if (/(^|\.)totalum\.app$/i.test(new URL(ENGINE).hostname)) {
    console.error("refusing to run against Totalum");
    return 2;
  }
  if (!process.argv.includes("--yes")) {
    console.error("this creates, rebuilds, restores and deletes a project on the target engine; re-run with --yes");
    return 2;
  }

  const client = createClient({ baseUrl: ENGINE, apiKey: KEY });
  const sims: SimulationResult[] = [];
  const created: string[] = [];
  const id = reuse ?? `it-${randomBytes(3).toString("hex")}`;

  try {
    log(`health: ${JSON.stringify((await (await fetch(`${ENGINE}/v2/system/health`)).json()))}`);
    log(`public-config: ${JSON.stringify((await api("GET", "/system/public-config")).json.data)}`);

    // ── Create (or reuse) ──
    if (reuse) {
      log(`reusing project ${id}`);
    } else {
      log(`POST /v1/projects {projectId:${id}}`);
      const create = await api("POST", "/projects", { projectId: id, description: "Phase 1 integration" });
      check(create.status === 200 && create.json.data?.projectId === id, `created ${id} (${create.json.data?.agentServerStatus})`);
      created.push(id);
    }
    await waitActive(id);
    const proj = (await api("GET", `/projects/${id}`)).json.data;
    log(`  project: ${JSON.stringify({ dev: proj.temporalDevelopmentProjectUrl, internal: proj.internalDevelopmentUrl, field: proj.developmentUrlFieldToUse })}`);

    // ── Preview: Traefik + engine proxy ──
    const host = `${id}.${PREVIEW_DOMAIN}`;
    const tr = await viaTraefik(host, "/");
    check(tr.status === 200 && tr.body.includes("<html"), `Traefik Host(${host}) → ${tr.status}, ${tr.body.length} bytes`);
    const pv = await fetch(`${ENGINE}/v2/projects/${id}/preview/`, { headers: { "api-key": KEY } });
    const pvBody = await pv.text();
    check(pv.status === 200 && pvBody.includes("<html"), `engine /v2/projects/${id}/preview/ → ${pv.status}, ${pvBody.length} bytes`);
    const health = await fetch(`${ENGINE}/v2/projects/${id}/preview/api/health`, { headers: { "api-key": KEY } });
    log(`  /api/health through the proxy → ${health.status} ${(await health.text()).slice(0, 120)}`);

    // ── Files + HMR ──
    const tree = await api("GET", `/projects/${id}/files/tree?limit=5000`);
    const paths: string[] = tree.json.data.entries.map((e: { path: string }) => e.path);
    check(paths.includes("src/app/page.tsx") && !paths.some((p) => p.includes("node_modules") || p.startsWith(".env")), `files/tree: ${tree.json.data.totalEntries} entries, ${tree.json.data.filesCount} files, no node_modules/.env`);
    const page = await api("GET", `/projects/${id}/files/content?path=src/app/page.tsx`);
    const original: string = page.json.data.content;
    const marker = `FORJA-HMR-${randomBytes(4).toString("hex")}`;
    // Put the marker somewhere that RENDERS (a JS comment would never reach the HTML).
    const anchor = ["</h1>", "</section>", "</main>", "</div>"].find((a) => original.includes(a));
    if (!anchor) throw new Error("src/app/page.tsx has no JSX anchor to edit");
    const edited = original.replace(anchor, `<span id="forja-hmr">${marker}</span>${anchor}`);
    const put = await api("PUT", `/projects/${id}/files/content`, { path: "src/app/page.tsx", content: b64(edited), encoding: "base64" });
    check(put.status === 200 && put.json.data.bytesWritten === Buffer.byteLength(edited) && put.json.data.rebuildRequired === false, `PUT files/content bytesWritten=${put.json.data?.bytesWritten} rebuildRequired=${put.json.data?.rebuildRequired}`);
    await waitFor("HMR marker", async () => (await viaTraefik(host, "/")).body.includes(marker), 90_000, 2000);
    check(true, `edit served by the dev server (marker ${marker} visible through Traefik)`);
    const envPut = await api("PUT", `/projects/${id}/files/content`, { path: ".env", content: b64("X=1"), encoding: "base64" });
    check(envPut.status === 403 && envPut.json.errors?.errorCode === "FORBIDDEN_PATH", `.env write → ${envPut.status} ${envPut.json.errors?.errorCode}`);
    const canary = `<div id="c" className="a b">x</div> ${Date.now()}`;
    await api("PUT", `/projects/${id}/files/content`, { path: ".totalum/visual-edit-write-check.txt", content: b64(canary), encoding: "base64" });
    const canaryBack = await api("GET", `/projects/${id}/files/content?path=.totalum/visual-edit-write-check.txt`);
    check(canaryBack.json.data?.content === canary, "visual-edit canary reads back byte-identical");

    // ── Versions, diff, restore ──
    await sleep(3500); // let the coalesced commit land
    const versions = await api("GET", `/projects/${id}/versions?limit=10`);
    const vs = versions.json.data.versions as { _id: string; name: string; commitSha: string; commitMessage: string }[];
    log(`  versions: ${vs.map((v) => `${v.name} "${v.commitMessage}"`).join(" | ")}`);
    check(vs.length >= 2, `versions: ${versions.json.data.totalCount}`);
    const diff = await api("GET", `/projects/${id}/version-diff?commitSha=${vs[0]?.commitSha}`);
    check(typeof diff.json.data?.diff === "string" && diff.json.data.diff.includes(marker), `version-diff of ${vs[0]?.name} contains the edit (${diff.json.data?.diff?.length} chars)`);
    const v1 = vs.at(-1) as { _id: string; name: string };
    const restore = await simulateRestore(client, id, v1._id, { intervalMs: 3000, maxAttempts: 100 });
    sims.push(restore);
    await waitFor("restored page", async () => !(await viaTraefik(host, "/")).body.includes(marker), 90_000, 2000);
    check(true, `after restore to ${v1.name} the marker is gone from the served page`);

    // ── Uploads + public signed URL ──
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4e80000000049454e44ae426082", "hex");
    const form = new FormData();
    form.set("file", new File([png], "pixel.png", { type: "image/png" }));
    const up = await fetch(`${ENGINE}/v1/projects/${id}/files/upload`, { method: "POST", headers: { "api-key": KEY }, body: form });
    const upJson = (await up.json()) as { data: { url: string; fileNameId: string } };
    check(up.status === 200 && upJson.data.url.includes("/api/files/"), `upload → ${upJson.data.fileNameId} ${upJson.data.url.slice(0, 60)}…`);
    const token = new URL(upJson.data.url).pathname.split("/").pop() as string;
    const pub = await fetch(`${ENGINE}/v1/public/${token}`);
    const pubBytes = Buffer.from(await pub.arrayBuffer());
    check(pub.status === 200 && pub.headers.get("content-type") === "image/png" && pubBytes.equals(png), `GET /v1/public/<token> (no api-key) → ${pub.status} ${pub.headers.get("content-type")} ${pubBytes.length} bytes`);

    // ── Database ──
    const ts = await api("GET", `/projects/${id}/database/tables-structure`);
    const tables = (ts.json.data?.tables ?? []) as { type: string; properties: Record<string, unknown> }[];
    check(ts.status === 200 && tables.length > 0, `tables-structure → ${ts.status}: ${tables.map((t) => t.type).join(", ") || JSON.stringify(ts.json.errors)}`);
    if (tables[0]) {
      const q = await api("POST", `/projects/${id}/database/query`, { tableName: tables[0].type, queryOptions: { _limit: 25, _count: true } });
      check(q.status === 200 && Array.isArray(q.json.data?.results), `query ${tables[0].type} → ${q.status}, ${q.json.data?.results?.length} rows ${q.json.errors ? JSON.stringify(q.json.errors) : ""}`);
    }

    // ── Source zip ──
    const src = await api("GET", `/projects/${id}/source-code`);
    const zipToken = new URL(src.json.data.downloadUrl).pathname.split("/").pop() as string;
    const zip = await fetch(`${ENGINE}/v1/public/${zipToken}`);
    const zipBytes = Buffer.from(await zip.arrayBuffer());
    check(zip.status === 200 && zipBytes.subarray(0, 2).toString("latin1") === "PK", `source-code: ${src.json.data.filesCount} files @${String(src.json.data.lastCommitSha).slice(0, 7)} → zip ${zipBytes.length} bytes`);

    // ── Logs ──
    const logs = await api("GET", `/projects/${id}/backend/dev/logs?tail=5`);
    check(logs.status === 200 && typeof logs.json.data?.logs === "string", `backend/dev/logs → ${JSON.stringify(logs.json.data?.logs ?? "").slice(0, 100)}`);

    // ── Rebuild (no-op, then a real one) ──
    sims.push(await simulateRebuild(client, id, { intervalMs: 3000, maxAttempts: 200 }));
    const cfg = await api("GET", `/projects/${id}/files/content?path=next.config.ts`);
    await api("PUT", `/projects/${id}/files/content`, { path: "next.config.ts", content: b64(`${cfg.json.data.content}\n// forja integration ${Date.now()}\n`), encoding: "base64" });
    const real = await simulateRebuild(client, id, { intervalMs: 3000, maxAttempts: 200 });
    real.simulator = "rebuild (config change)";
    sims.push(real);

    // ── Restart ──
    sims.push(await simulateRestart(client, id, { intervalMs: 3000, maxAttempts: 200 }));

    // ── Archive → wake ──
    const arch = await api("POST", `/projects/${id}/archive`, undefined, "/v2");
    log(`POST /v2/projects/${id}/archive → ${arch.status} ${JSON.stringify(arch.json)}`);
    await waitFor("Archived", async () => (await api("GET", `/projects/${id}`)).json.data?.agentServerStatus === "Archived", 120_000, 2000);
    const tr2 = await viaTraefik(host, "/");
    log(`  while archived, Traefik answers ${tr2.status}; files/tree → ${(await api("GET", `/projects/${id}/files/tree`)).status}`);
    sims.push(await simulateWake(client, id, { intervalMs: 3000 }));
    const tr3 = await viaTraefik(host, "/");
    check(tr3.status === 200, `after wake Traefik → ${tr3.status}`);

    // ── Launch (phase 1 semantics) ──
    const launch = await simulateLaunch(client, { projectId: `${id}-l`, prompt: "A one-page site for a bakery." }, { waitForRun: false });
    sims.push(launch);
    // Delete it right away: its provisioning would install a second node_modules (~1 GB).
    const delLaunch = await api("DELETE", `/projects/${launch.projectId}`);
    log(`DELETE /v1/projects/${launch.projectId} → ${delLaunch.status} (launch project removed before npm ci)`);

    // ── Through the web UI server ──
    if (WEB) {
      const list = await fetch(`${WEB}/api/vcaas/projects`);
      const listJson = (await list.json()) as { ok: boolean; data: { projectId: string }[] };
      check(list.status === 200 && listJson.ok && listJson.data.some((p) => p.projectId === id), `web /api/vcaas/projects → ${list.status}, ${listJson.data?.length} projects`);
      const webPrev = await fetch(`${WEB}/api/preview/${id}/`);
      const webPrevBody = await webPrev.text();
      check(webPrev.status === 200 && webPrevBody.includes("__totalum-visual-editor"), `web /api/preview/${id}/ → ${webPrev.status}, ${webPrevBody.length} bytes, agent injected`);
      const webFile = await fetch(`${WEB}/api/files/${token}`);
      check(webFile.status === 200 && Buffer.from(await webFile.arrayBuffer()).equals(png), `web /api/files/<token> → ${webFile.status} ${webFile.headers.get("content-type")}`);
      const cfgWeb = (await (await fetch(`${WEB}/api/config`)).json()) as unknown;
      log(`  web /api/config → ${JSON.stringify(cfgWeb)}`);
    }
  } catch (err) {
    failures.push(`aborted: ${err instanceof Error ? err.message : String(err)}`);
    log(`ABORTED: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    if (!keep) {
      for (const pid of created) {
        const del = await api("DELETE", `/projects/${pid}`).catch(() => ({ status: 0, json: null }));
        log(`DELETE /v1/projects/${pid} → ${del.status}`);
      }
    }
  }

  console.log("\nContract simulators (packages/contract-tests):");
  console.log(formatResultsTable(sims));
  for (const r of sims) for (const v of r.violations) console.log(`  ${r.simulator}: ${v.code} — ${v.message}`);
  const expected = (r: SimulationResult) =>
    r.ok || (r.simulator === "launch" && r.violations.every((v) => v.code === "REQUEST_FAILED" && v.message.includes("NOT_IMPLEMENTED")));
  const simFailures = sims.filter((r) => !expected(r));
  console.log(`\n${failures.length} check failure(s), ${simFailures.length} unexpected simulator failure(s)`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  return failures.length === 0 && simFailures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(2);
  },
);
