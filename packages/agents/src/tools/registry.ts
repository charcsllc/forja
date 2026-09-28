/**
 * The canonical tool registry (docs/architecture/11-tool-registry.md, source of truth).
 *
 * What this protects: tool names are unique `snake_case` (`^[a-z][a-z0-9_]{0,63}$`), and a
 * role only ever receives the tools its definition lists (`roles/*.ts`). Phase 2 ships the
 * file, search, execution, database, git, image and orchestration tools; browser, media
 * generation, merge and review tools arrive with the phase-3 roles.
 */
import { bashTool } from "./exec.js";
import { dbIntrospectTool, dbQueryTool } from "./db.js";
import { editFileTool, globTool, grepTool, listDirTool, readFileTool, writeFileTool } from "./files.js";
import { gitDiffTool, gitLogTool } from "./git.js";
import { imageFindTool } from "./image.js";
import {
  submitDecisionTool,
  submitIntentTool,
  submitMessageTool,
  submitPlanTool,
  submitReportTool,
  submitSummaryTool,
} from "./submit.js";
import type { AnyTool } from "./types.js";

export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

const ALL: readonly AnyTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  globTool,
  grepTool,
  listDirTool,
  bashTool,
  dbQueryTool,
  dbIntrospectTool,
  gitLogTool,
  gitDiffTool,
  imageFindTool,
  submitIntentTool,
  submitPlanTool,
  submitDecisionTool,
  submitMessageTool,
  submitReportTool,
  submitSummaryTool,
] as readonly AnyTool[];

export const TOOL_REGISTRY: ReadonlyMap<string, AnyTool> = new Map(ALL.map((t) => [t.name, t]));

export type ToolName = (typeof ALL)[number]["name"];

/** The tools named, in order. Throws on an unknown name (a programming error, caught by tests). */
export function toolsByName(names: readonly string[]): AnyTool[] {
  return names.map((n) => {
    const tool = TOOL_REGISTRY.get(n);
    if (!tool) throw new Error(`unknown tool "${n}"`);
    return tool;
  });
}
