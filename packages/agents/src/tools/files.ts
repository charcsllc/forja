/**
 * File and search tools over the task's checkout (11-tool-registry.md "Ficheros y búsqueda").
 *
 * What this protects:
 * - Writes go through `scopeCoversPath(scopeWrite, path)`: a write outside the task's
 *   lease is refused, reported to the model with its scope, and emitted as
 *   `scope.violation` (03 §1).
 * - `edit_file` is an exact, unique match (0 or >1 matches → an error with context, never a
 *   guess), so a model cannot silently edit the wrong place.
 * - Every output is bounded: read_file 400 lines, glob 500 paths, grep 200 lines,
 *   list_dir 500 entries, each with an explicit "there is more" marker.
 */
import { globToRegExp, scopeCoversPath } from "@forja/contracts";
import { z } from "zod";
import { WorkspaceError, defineTool, fail, ok, type ToolContext, type ToolResult } from "./types.js";
import { looksBinary, numbered } from "./text.js";
import { normalizeWorkspacePath } from "./local-workspace.js";

export const READ_MAX_LINES = 400;
export const GLOB_MAX = 500;
export const GREP_MAX_LINES = 200;
export const LIST_MAX = 500;
const GREP_MAX_FILE_BYTES = 1024 * 1024;

const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

function workspaceFailure(err: unknown): ToolResult {
  if (err instanceof WorkspaceError) return fail(`${err.code}: ${err.message}`);
  throw err;
}

async function readText(ctx: ToolContext, path: string): Promise<string> {
  const bytes = await ctx.workspace.readFile(path);
  if (looksBinary(bytes)) throw new WorkspaceError("NOT_A_FILE", `${path} is a binary file (${bytes.byteLength} bytes); it cannot be read as text.`);
  return decoder.decode(bytes);
}

function checkScope(ctx: ToolContext, path: string): ToolResult | null {
  let rel: string;
  try {
    rel = normalizeWorkspacePath(path, { forWrite: true });
  } catch (err) {
    return workspaceFailure(err);
  }
  if (ctx.scopeWrite.length > 0 && scopeCoversPath(ctx.scopeWrite, rel)) return null;
  ctx.emit({ type: "scope.violation", path: rel });
  const scope = ctx.scopeWrite.length > 0 ? ctx.scopeWrite.join(", ") : "(none: this task is read-only)";
  return fail(`SCOPE_VIOLATION: ${rel} is outside this task's write scope. You may write only: ${scope}. If the change is needed, mention it in your report's concerns instead.`);
}

// ── read_file ────────────────────────────────────────────────────────────────

export const readFileTool = defineTool({
  name: "read_file",
  kind: "read",
  description: `Read a text file of the project with line numbers. Paths are relative to the project root. At most ${READ_MAX_LINES} lines per call: use offset (1-based first line) and limit to page through long files.`,
  input: z.object({
    path: z.string().min(1).describe("Project-relative path, e.g. src/app/page.tsx"),
    offset: z.number().int().min(1).optional().describe("First line to read (1-based). Default 1."),
    limit: z.number().int().min(1).max(READ_MAX_LINES).optional().describe(`Number of lines. Default and maximum ${READ_MAX_LINES}.`),
  }),
  summarize: (a) => `${a.path}${a.offset ? `:${a.offset}` : ""}`,
  async execute(args, ctx) {
    try {
      const text = await readText(ctx, args.path);
      const lines = text.split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const start = Math.min(args.offset ?? 1, Math.max(lines.length, 1));
      const count = args.limit ?? READ_MAX_LINES;
      const slice = lines.slice(start - 1, start - 1 + count);
      const end = start - 1 + slice.length;
      const more = end < lines.length ? `\n[lines ${start}–${end} of ${lines.length}; call read_file with offset=${end + 1} for more]` : "";
      if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return ok(`(${args.path} is empty)`, `${args.path}: empty`);
      return ok(numbered(slice, start) + more, `${args.path}: lines ${start}–${end} of ${lines.length}`);
    } catch (err) {
      return workspaceFailure(err);
    }
  },
});

// ── write_file ───────────────────────────────────────────────────────────────

export const writeFileTool = defineTool({
  name: "write_file",
  kind: "write",
  description:
    "Create or overwrite a file with the complete content. Parent folders are created. Only paths inside your task's write scope are allowed; .env files are never allowed. For a small change to an existing file prefer edit_file.",
  input: z.object({
    path: z.string().min(1).describe("Project-relative path"),
    content: z.string().describe("The complete file content"),
  }),
  summarize: (a) => `${a.path} (${Buffer.byteLength(a.content, "utf8")} bytes)`,
  async execute(args, ctx) {
    const refused = checkScope(ctx, args.path);
    if (refused) return refused;
    try {
      const data = encoder.encode(args.content);
      const { created } = await ctx.workspace.writeFile(args.path, data);
      const rel = normalizeWorkspacePath(args.path, { forWrite: true });
      ctx.emit({ type: "file.written", path: rel, bytes: data.byteLength, created });
      return ok(`${created ? "Created" : "Overwrote"} ${rel} (${data.byteLength} bytes).`);
    } catch (err) {
      return workspaceFailure(err);
    }
  },
});

// ── edit_file ────────────────────────────────────────────────────────────────

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export const editFileTool = defineTool({
  name: "edit_file",
  kind: "write",
  description:
    "Replace an exact string in a file. old_string must match the file byte for byte (copy it from read_file output without the line-number prefix) and must be unique unless replace_all is true. Always read_file first.",
  input: z.object({
    path: z.string().min(1),
    old_string: z.string().min(1).describe("Exact text to replace, including indentation"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence. Default false."),
  }),
  summarize: (a) => `${a.path} (-${a.old_string.length}/+${a.new_string.length} chars${a.replace_all ? ", all" : ""})`,
  async execute(args, ctx) {
    const refused = checkScope(ctx, args.path);
    if (refused) return refused;
    if (args.old_string === args.new_string) return fail("old_string and new_string are identical; nothing to change.");
    try {
      const text = await readText(ctx, args.path);
      const positions: number[] = [];
      for (let i = text.indexOf(args.old_string); i !== -1; i = text.indexOf(args.old_string, i + args.old_string.length)) positions.push(i);
      if (positions.length === 0) {
        const firstLine = args.old_string.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
        const hint = firstLine && text.includes(firstLine) ? ` The line "${firstLine.slice(0, 80)}" exists near line ${lineOf(text, text.indexOf(firstLine))}; check whitespace and the surrounding lines.` : "";
        return fail(`NO_MATCH: old_string was not found in ${args.path}.${hint} Re-read the file with read_file and copy the text exactly.`);
      }
      if (positions.length > 1 && !args.replace_all) {
        const lines = positions.slice(0, 10).map((p) => lineOf(text, p));
        return fail(`MULTIPLE_MATCHES: old_string occurs ${positions.length} times in ${args.path} (lines ${lines.join(", ")}). Include more surrounding context to make it unique, or set replace_all: true.`);
      }
      const next = args.replace_all ? text.split(args.old_string).join(args.new_string) : text.replace(args.old_string, () => args.new_string);
      const data = encoder.encode(next);
      await ctx.workspace.writeFile(args.path, data);
      const rel = normalizeWorkspacePath(args.path, { forWrite: true });
      ctx.emit({ type: "file.written", path: rel, bytes: data.byteLength, created: false });
      return ok(`Edited ${rel}: ${positions.length} replacement${positions.length === 1 ? "" : "s"} (at line ${positions.map((p) => lineOf(text, p)).slice(0, 5).join(", ")}).`);
    } catch (err) {
      return workspaceFailure(err);
    }
  },
});

// ── glob ─────────────────────────────────────────────────────────────────────

export const globTool = defineTool({
  name: "glob",
  kind: "read",
  description: `List project files matching a glob (\`**\`, \`*\`, \`?\`, \`{a,b}\`), e.g. "src/app/**/page.tsx". node_modules, .next and .git are never listed. At most ${GLOB_MAX} paths.`,
  input: z.object({ pattern: z.string().min(1) }),
  summarize: (a) => a.pattern,
  async execute(args, ctx) {
    try {
      const re = globToRegExp(args.pattern.replace(/^\.\//, ""));
      const files = (await ctx.workspace.list("", { limit: 50_000 })).filter((e) => e.type === "file" && re.test(e.path));
      if (files.length === 0) return ok(`No files match ${args.pattern}.`, "0 matches");
      const shown = files.slice(0, GLOB_MAX).map((f) => f.path);
      const more = files.length > GLOB_MAX ? `\n[${files.length - GLOB_MAX} more; narrow the pattern]` : "";
      return ok(shown.join("\n") + more, `${files.length} matches`);
    } catch (err) {
      return workspaceFailure(err);
    }
  },
});

// ── grep ─────────────────────────────────────────────────────────────────────

export const grepTool = defineTool({
  name: "grep",
  kind: "read",
  description: `Search file contents with a JavaScript regular expression. Output lines are "path:line: text". Optional glob limits the files; context adds lines around each match. At most ${GREP_MAX_LINES} output lines.`,
  input: z.object({
    pattern: z.string().min(1).describe("JavaScript regular expression"),
    glob: z.string().optional().describe('Only files matching this glob, e.g. "src/**/*.ts"'),
    context: z.number().int().min(0).max(5).optional().describe("Lines of context before and after each match (0–5)"),
    case_insensitive: z.boolean().optional(),
  }),
  summarize: (a) => `/${a.pattern}/${a.glob ? ` in ${a.glob}` : ""}`,
  async execute(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.case_insensitive ? "i" : "");
    } catch (err) {
      return fail(`INVALID_REGEX: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const filter = args.glob ? globToRegExp(args.glob.replace(/^\.\//, "")) : null;
      const files = (await ctx.workspace.list("", { limit: 50_000 })).filter(
        (e) => e.type === "file" && e.size <= GREP_MAX_FILE_BYTES && (!filter || filter.test(e.path)),
      );
      const out: string[] = [];
      let matches = 0;
      let overflow = false;
      const context = args.context ?? 0;
      for (const file of files) {
        if (ctx.abortSignal.aborted) break;
        const bytes = await ctx.workspace.readFile(file.path).catch(() => null);
        if (!bytes || looksBinary(bytes)) continue;
        const lines = decoder.decode(bytes).split("\n");
        let lastPrinted = -1;
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i] ?? "")) continue;
          matches++;
          const from = Math.max(0, i - context, lastPrinted + 1);
          const to = Math.min(lines.length - 1, i + context);
          if (context > 0 && out.length > 0 && from > lastPrinted + 1) out.push("--");
          for (let j = from; j <= to; j++) {
            if (out.length >= GREP_MAX_LINES) {
              overflow = true;
              break;
            }
            out.push(`${file.path}:${j + 1}${j === i ? ":" : "-"} ${(lines[j] ?? "").slice(0, 300)}`);
            lastPrinted = j;
          }
          if (overflow) break;
        }
        if (overflow) break;
      }
      if (matches === 0) return ok(`No matches for /${args.pattern}/.`, "0 matches");
      return ok(out.join("\n") + (overflow ? `\n[output capped at ${GREP_MAX_LINES} lines; narrow the pattern or the glob]` : ""), `${matches}${overflow ? "+" : ""} matches`);
    } catch (err) {
      return workspaceFailure(err);
    }
  },
});

// ── list_dir ─────────────────────────────────────────────────────────────────

export const listDirTool = defineTool({
  name: "list_dir",
  kind: "read",
  description: `List a folder of the project (use "." for the root). depth 1 lists direct children; default 2. Folders end with "/". At most ${LIST_MAX} entries.`,
  input: z.object({
    path: z.string().describe('Project-relative folder, "." for the root'),
    depth: z.number().int().min(1).max(8).optional(),
  }),
  summarize: (a) => `${a.path} (depth ${a.depth ?? 2})`,
  async execute(args, ctx) {
    try {
      const entries = await ctx.workspace.list(args.path, { depth: args.depth ?? 2, limit: LIST_MAX + 1 });
      if (entries.length === 0) return ok(`(${args.path} is empty)`);
      const shown = entries.slice(0, LIST_MAX).map((e) => (e.type === "dir" ? `${e.path}/` : `${e.path} (${e.size} B)`));
      return ok(shown.join("\n") + (entries.length > LIST_MAX ? `\n[more than ${LIST_MAX} entries; list a subfolder]` : ""), `${Math.min(entries.length, LIST_MAX)} entries`);
    } catch (err) {
      return workspaceFailure(err);
    }
  },
});
