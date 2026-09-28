/**
 * Tools. Protects: scope leases, exact edits, bounded outputs, the bash allowlist, the
 * redactor, plan validation inside submit_plan, and image_find through the port.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bashTool } from "../src/tools/exec.js";
import { editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool } from "../src/tools/files.js";
import { imageFindTool } from "../src/tools/image.js";
import { LocalWorkspace } from "../src/tools/local-workspace.js";
import { createRedactor } from "../src/tools/redact.js";
import { submitPlanTool, submitReportTool } from "../src/tools/submit.js";
import { FIXER_BASH_ALLOWLIST } from "../src/roles/index.js";
import { FakeExec, fakeImages, makeContext, tempWorkspace } from "./helpers.js";

const run = <T>(tool: { execute: (a: T, c: ReturnType<typeof makeContext>) => Promise<{ ok: boolean; content: string }> }, args: T, ctx: ReturnType<typeof makeContext>) =>
  tool.execute(args, ctx);

describe("files", () => {
  it("writes inside the scope and refuses outside it with a scope.violation", async () => {
    const ctx = makeContext();
    expect((await run(writeFileTool, { path: "src/app/about/page.tsx", content: "x" }, ctx)).ok).toBe(true);
    const refused = await run(writeFileTool, { path: "src/db/schema/x.ts", content: "x" }, ctx);
    expect(refused.ok).toBe(false);
    expect(refused.content).toContain("SCOPE_VIOLATION");
    expect(refused.content).toContain("src/app/**");
    expect(ctx.events).toContainEqual({ type: "scope.violation", path: "src/db/schema/x.ts" });
    expect(ctx.events).toContainEqual({ type: "file.written", path: "src/app/about/page.tsx", bytes: 1, created: true });
  });

  it("honours ! exclusions and refuses .env files, .git and escapes", async () => {
    const ctx = makeContext({ scopeWrite: ["src/app/**", "!src/app/api/**", "**"] });
    expect((await run(writeFileTool, { path: "src/app/api/x/route.ts", content: "x" }, ctx)).content).toContain("SCOPE_VIOLATION");
    expect((await run(writeFileTool, { path: ".env.local", content: "A=1" }, ctx)).content).toContain("FORBIDDEN_PATH");
    expect((await run(writeFileTool, { path: ".git/config", content: "" }, ctx)).content).toContain("FORBIDDEN_PATH");
    expect((await run(writeFileTool, { path: "../x", content: "" }, ctx)).content).toContain("INVALID_PATH");
  });

  it("reads with line numbers and pages long files", async () => {
    const ctx = makeContext();
    const body = Array.from({ length: 450 }, (_, i) => `line ${i + 1}`).join("\n");
    await ctx.workspace.writeFile("src/app/long.ts", new TextEncoder().encode(body));
    const first = await run(readFileTool, { path: "src/app/long.ts" }, ctx);
    expect(first.content).toMatch(/^\s*1\tline 1/);
    expect(first.content).toContain("call read_file with offset=401");
    const second = await run(readFileTool, { path: "src/app/long.ts", offset: 401 }, ctx);
    expect(second.content).toContain("450\tline 450");
    expect((await run(readFileTool, { path: "nope.ts" }, ctx)).content).toContain("NOT_FOUND");
  });

  it("edit_file needs an exact, unique match", async () => {
    const ctx = makeContext();
    await ctx.workspace.writeFile("src/app/a.tsx", new TextEncoder().encode("const a = 1;\nconst b = 1;\n"));
    const none = await run(editFileTool, { path: "src/app/a.tsx", old_string: "const c = 1;", new_string: "x" }, ctx);
    expect(none.content).toContain("NO_MATCH");
    const many = await run(editFileTool, { path: "src/app/a.tsx", old_string: "= 1;", new_string: "= 2;" }, ctx);
    expect(many.content).toContain("MULTIPLE_MATCHES");
    expect(many.content).toContain("lines 1, 2");
    expect((await run(editFileTool, { path: "src/app/a.tsx", old_string: "= 1;", new_string: "= 2;", replace_all: true }, ctx)).ok).toBe(true);
    expect(new TextDecoder().decode(await ctx.workspace.readFile("src/app/a.tsx"))).toBe("const a = 2;\nconst b = 2;\n");
    const once = await run(editFileTool, { path: "src/app/a.tsx", old_string: "const a = 2;", new_string: "const a = $&;" }, ctx);
    expect(once.ok).toBe(true);
    expect(new TextDecoder().decode(await ctx.workspace.readFile("src/app/a.tsx"))).toContain("const a = $&;");
  });

  it("glob, grep and list_dir skip node_modules and cap output", async () => {
    const ctx = makeContext();
    const enc = new TextEncoder();
    await ctx.workspace.writeFile("src/app/page.tsx", enc.encode("export default function Page() {}\n"));
    await ctx.workspace.writeFile("src/app/about/page.tsx", enc.encode("// About\nexport default function About() {}\n"));
    await ctx.workspace.writeFile("node_modules/x/page.tsx", enc.encode("export default function Page() {}\n"));
    const g = await run(globTool, { pattern: "src/**/page.tsx" }, ctx);
    expect(g.content.split("\n").sort()).toEqual(["src/app/about/page.tsx", "src/app/page.tsx"]);
    const gr = await run(grepTool, { pattern: "export default function (\\w+)", glob: "src/**" }, ctx);
    expect(gr.content).toContain("src/app/about/page.tsx:2:");
    expect(gr.content).not.toContain("node_modules");
    expect((await run(grepTool, { pattern: "(" }, ctx)).content).toContain("INVALID_REGEX");
    const ls = await run(listDirTool, { path: "." }, ctx);
    expect(ls.content).toContain("src/app/");
    expect(ls.content).not.toContain("node_modules");
  });

  it("LocalWorkspace refuses symlinks that escape the root and hides .env", async () => {
    const { root, ws } = tempWorkspace();
    const outside = tempWorkspace().root;
    mkdirSync(path.join(root, "src"));
    symlinkSync(outside, path.join(root, "src", "evil"));
    await expect(ws.writeFile("src/evil/x.ts", new Uint8Array([1]))).rejects.toThrow(/outside the project/);
    writeFileSync(path.join(root, ".env"), "SECRET=1");
    writeFileSync(path.join(root, ".env.example"), "SECRET=");
    const names = (await ws.list("")).map((e) => e.path);
    expect(names).toContain(".env.example");
    expect(names).not.toContain(".env");
    await expect(ws.readFile(".env")).rejects.toThrow(/FORBIDDEN|secrets/);
    expect(new TextDecoder().decode(await new LocalWorkspace(root).readFile(".env.example"))).toBe("SECRET=");
  });
});

describe("bash", () => {
  it("runs through the exec port and reports exit codes", async () => {
    const exec = new FakeExec();
    const ctx = makeContext({ exec });
    const r = await run(bashTool, { command: "npm run typecheck" }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/^exit code 0/);
    exec.next = { exitCode: 2, stderr: "src/a.ts(1,1): error TS2304" };
    const bad = await run(bashTool, { command: "npm run typecheck" }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("TS2304");
    expect(ctx.events.some((e) => e.type === "command.output")).toBe(true);
  });

  it("enforces the fixer allowlist per segment", async () => {
    const exec = new FakeExec();
    const ctx = makeContext({ exec, bashAllowlist: FIXER_BASH_ALLOWLIST });
    expect((await run(bashTool, { command: "npx tsc --noEmit && npm run lint" }, ctx)).ok).toBe(true);
    expect((await run(bashTool, { command: "npx tsc --noEmit && curl http://x" }, ctx)).content).toContain("COMMAND_NOT_ALLOWED");
    expect((await run(bashTool, { command: "npx tsc $(rm -rf /)" }, ctx)).content).toContain("COMMAND_NOT_ALLOWED");
    expect(exec.commands).toEqual(["npx tsc --noEmit && npm run lint"]);
  });

  it("without an exec port answers UNAVAILABLE", async () => {
    expect((await run(bashTool, { command: "ls" }, makeContext())).content).toContain("UNAVAILABLE");
  });
});

describe("redactor", () => {
  it("removes known values and key shapes", () => {
    const r = createRedactor(["hunter2-long-secret", "abc"]);
    expect(r("pw=hunter2-long-secret key=nvapi-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 x=abc")).toBe("pw=[redacted] key=[redacted] x=abc");
    expect(r("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa")).toBe("[redacted]");
  });
});

describe("submit tools", () => {
  const plan = {
    intent: "tweak",
    summary: "Add an about page",
    spec: { goal: "g", users: [], pages: [], features: [], dataModel: [], integrations: [], nonFunctional: { seo: true, auth: "none", i18n: ["en"], a11y: "AA" } },
    decisions: [],
    tasks: [{ id: "fe", role: "frontend", title: "About page", description: "d", dependsOn: [], scope: { write: ["src/app/about/**"] }, acceptance: ["renders"], weight: 1 }],
    budgetWeights: { fe: 1 },
    verification: { pages: ["/about"], flows: [] },
  };

  it("submit_plan applies validatePlan and injected validators", async () => {
    const ctx = makeContext();
    const parsed = submitPlanTool.input.parse(plan);
    expect((await submitPlanTool.execute(parsed, ctx)).ok).toBe(true);
    const bad = submitPlanTool.input.parse({ ...plan, tasks: [{ ...plan.tasks[0], dependsOn: ["ghost"] }] });
    expect((await submitPlanTool.execute(bad, ctx)).content).toContain('unknown task "ghost"');
    const strict = makeContext({ submitValidators: { submit_plan: () => ["role designer is not available"] } });
    const r = await submitPlanTool.execute(parsed, strict);
    expect(r.ok).toBe(false);
    expect(r.content).toContain("role designer is not available");
  });

  it("submit_report accepts a valid report", async () => {
    const report = submitReportTool.input.parse({ status: "done", summary: "s", filesChanged: [], acceptance: [] });
    expect((await submitReportTool.execute(report, makeContext())).ok).toBe(true);
  });
});

describe("image_find", () => {
  it("writes through the workspace and returns the publicUrl and attribution", async () => {
    const images = fakeImages();
    const ctx = makeContext({ imageSourcing: images });
    const args = imageFindTool.input.parse({ slot: "hero", query: "candles on a table", alt: "Velas" });
    const r = await imageFindTool.execute(args, ctx);
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.content).publicUrl).toBe("/images/hero.jpg");
    expect(await ctx.workspace.stat("public/images/hero.jpg")).toEqual({ type: "file", size: 3 });
    expect(images.reads).toEqual([null]);
    expect(imageFindTool.description).toMatch(/ONCE per slot/);
    expect(imageFindTool.description).toMatch(/attributionRequired/);
    expect(imageFindTool.description).toMatch(/credits\.json/);
  });

  it("without a port answers a clear error", async () => {
    const r = await imageFindTool.execute(imageFindTool.input.parse({ slot: "hero", query: "candles", alt: "x" }), makeContext());
    expect(r.ok).toBe(false);
    expect(r.content).toContain("UNAVAILABLE");
  });
});
