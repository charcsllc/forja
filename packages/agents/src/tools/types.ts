/**
 * Tool contracts of the agent runtime: the spec every tool implements, the context it runs
 * in, and the PORTS through which it reaches the outside world.
 *
 * What this protects: `@forja/agents` never imports Docker, git or a database driver.
 * The engine implements the ports (`WorkspacePort` over the `run/` checkout, `ExecPort`
 * in `forja-verify-<id>`, `DbPort` on `verify_<runId>`, `GitPort` over the project repo,
 * `ImageSourcingPort` from `packages/media`), so every tool is unit-testable with fakes.
 * A tool NEVER throws for a problem the model can fix: it returns `{ ok: false }` with a
 * message the model reads (docs/architecture/02 §4 invariant 2, 11-tool-registry.md).
 */
import type { AgentRole } from "@forja/contracts";
import type { ImageSourcingPort } from "@forja/contracts/media";
import type { z } from "zod";

// ── Ports ────────────────────────────────────────────────────────────────────

export interface WorkspaceEntry {
  /** Root-relative POSIX path. */
  path: string;
  type: "file" | "dir";
  size: number;
}

/** Thrown by a workspace for a refused or missing path. `code` is shown to the model. */
export class WorkspaceError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_PATH" | "FORBIDDEN_PATH" | "TOO_LARGE" | "NOT_A_FILE" | "IO",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceError";
  }
}

/** The files of the task's checkout (the engine: `/data/projects/<id>/run`). */
export interface WorkspacePort {
  readFile(path: string): Promise<Uint8Array>;
  /** Creates parent folders. Returns whether the file was new. */
  writeFile(path: string, data: Uint8Array): Promise<{ created: boolean }>;
  stat(path: string): Promise<{ type: "file" | "dir"; size: number } | null>;
  /**
   * Entries under `path` (root = ""), depth-first, folders before files, skipping
   * `node_modules`, `.next`, `.git`, `dist`, `.forja`, `.totalum` and `.env*` (except
   * `*.example`). `limit` caps the walk.
   */
  list(path: string, opts?: { depth?: number; limit?: number }): Promise<WorkspaceEntry[]>;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Shell commands in the verification container (cwd `/workspace`, uid 1000). */
export interface ExecPort {
  run(command: string, opts: { timeoutSec: number; abortSignal?: AbortSignal }): Promise<ExecResult>;
}

export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

/** Read-only access to the run's verification database. */
export interface DbPort {
  query(sql: string, opts: { maxRows: number; timeoutSec: number }): Promise<DbQueryResult>;
  /** Tables, columns, foreign keys and indexes as readable text. */
  introspect(): Promise<string>;
}

export interface GitPort {
  log(opts: { limit: number; path?: string }): Promise<string>;
  /** Unified diff; `from` defaults to the previous version, `to` to the working tree. */
  diff(opts: { from?: string; to?: string; path?: string }): Promise<string>;
}

// ── Tool context and results ─────────────────────────────────────────────────

export type ToolEvent =
  | { type: "scope.violation"; path: string }
  | { type: "command.output"; cmd: string; exitCode: number | null; tail: string }
  | { type: "file.written"; path: string; bytes: number; created: boolean };

export interface ToolContext {
  projectId: string;
  runId: string;
  taskId: string;
  role: AgentRole;
  /** Globs this task may write (`!` excludes). Empty = read-only task. */
  scopeWrite: readonly string[];
  workspace: WorkspacePort;
  exec?: ExecPort;
  db?: DbPort;
  git?: GitPort;
  imageSourcing?: ImageSourcingPort;
  /** Command prefixes this role may run with `bash` (absent = any; the container is the boundary). */
  bashAllowlist?: readonly string[];
  /** Extra checks for a `submit_*` payload (e.g. plan rules); returned strings go back to the model. */
  submitValidators?: Partial<Record<string, (payload: unknown) => string[] | Promise<string[]>>>;
  /** Replaces secret values and key-shaped strings with `[redacted]`. */
  redact(text: string): string;
  emit(event: ToolEvent): void;
  abortSignal: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** What the model reads (already truncated by the tool; redacted by the loop). */
  content: string;
  /** One line for `tool.result.summary`. */
  summary?: string;
}

export type ToolKind = "read" | "write" | "exec" | "db" | "git" | "media" | "submit";

export interface ToolSpec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  /** `^[a-z][a-z0-9_]{0,63}$` (11-tool-registry.md). */
  name: string;
  description: string;
  input: S;
  kind: ToolKind;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
  /** One-line argument summary for `tool.call.argsSummary` (never the full content). */
  summarize?(args: z.infer<S>): string;
}

export const ok = (content: string, summary?: string): ToolResult => ({ ok: true, content, summary });
export const fail = (content: string, summary?: string): ToolResult => ({ ok: false, content, summary: summary ?? content.split("\n")[0] });

/** Identity helper that infers the input schema type from `input`. */
export function defineTool<S extends z.ZodTypeAny>(spec: ToolSpec<S>): ToolSpec<S> {
  return spec;
}

/** A tool with its schema erased, as stored in the registry. */
export type AnyTool = ToolSpec<z.ZodTypeAny>;
