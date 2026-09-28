/**
 * Read-only git tools (11-tool-registry.md "Git"). Destructive git operations do not
 * exist for agents (_base-engineer.md "Tools and scope").
 */
import { z } from "zod";
import { defineTool, fail, ok } from "./types.js";
import { truncateBytes } from "./text.js";

export const GIT_DIFF_MAX_BYTES = 20 * 1024;

export const gitLogTool = defineTool({
  name: "git_log",
  kind: "git",
  description: "Recent versions of the project (newest first): sha, date, message. Optional path limits the history to one file or folder.",
  input: z.object({
    limit: z.number().int().min(1).max(50).optional(),
    path: z.string().optional(),
  }),
  summarize: (a) => `${a.limit ?? 10}${a.path ? ` ${a.path}` : ""}`,
  async execute(args, ctx) {
    if (!ctx.git) return fail("UNAVAILABLE: git history is not available in this task.");
    try {
      return ok((await ctx.git.log({ limit: args.limit ?? 10, path: args.path })) || "(no history)");
    } catch (err) {
      return fail(`GIT_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});

export const gitDiffTool = defineTool({
  name: "git_diff",
  kind: "git",
  description: `Unified diff. Default: the changes of this run so far against the version it started from. from/to accept a version sha or tag (v3); path limits the diff. Truncated to ${GIT_DIFF_MAX_BYTES / 1024} KB.`,
  input: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    path: z.string().optional(),
  }),
  summarize: (a) => `${a.from ?? "base"}..${a.to ?? "work"}${a.path ? ` ${a.path}` : ""}`,
  async execute(args, ctx) {
    if (!ctx.git) return fail("UNAVAILABLE: git history is not available in this task.");
    try {
      const diff = await ctx.git.diff(args);
      return ok(truncateBytes(diff || "(no differences)", GIT_DIFF_MAX_BYTES, "pass path to see one file").text);
    } catch (err) {
      return fail(`GIT_FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
