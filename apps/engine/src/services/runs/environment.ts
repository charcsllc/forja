/**
 * Per-run infrastructure (04 §1, §9): the `run/<runId>` branch checked out at `run/`, the
 * `forja-verify-<id>` container that runs on it, and the `verify_<runId>` database. The
 * orchestrator sees it only through `RunEnvironment`, so its tests use a fake.
 *
 * What this protects:
 * - Agents and gates never touch `work/` (what the user sees) or the `app` database until
 *   the run merges: every write lands on `run/`, every query on `verify_<runId>`.
 * - The verify container is created at the start of the run and awaited lazily
 *   (`ready()`), so `npm ci` in the fresh checkout overlaps with the director's planning.
 *   A command never runs before it is ready.
 * - Database tools are read-only (`cms_ro` + READ ONLY transaction + statement timeout).
 * - After a merge the dev app is brought in line: migrations on `app`, and a rebuild when
 *   configuration files changed (04 §5, §9).
 * - `close` always removes the verify container and the checkout; the branch is kept when
 *   the run did not merge (stop, failure) so partial work stays inspectable (03 §8).
 */
import { LocalWorkspace, type DbPort, type DbQueryResult, type ExecPort, type ExecResult, type GitPort, type WorkspacePort } from "@forja/agents";
import { isRebuildRequiredPath } from "@forja/git";
import { DB_SUPERUSER, createRunDatabaseSql, dropRunDatabaseSql, names } from "@forja/sandbox";
import type { ProjectRow, RunRow } from "../../store/types.js";
import type { EngineContext } from "../context.js";
import { dbPasswords, migrate, renderAppEnv, startRebuild } from "../lifecycle.js";

export interface MergeOutcome {
  commitSha: string;
  tag: string | null;
  merged: boolean;
  parentSha: string;
}

export interface RunEnvironment {
  /** `main` HEAD the run branched from. */
  readonly baseSha: string;
  readonly workspace: WorkspacePort;
  readonly exec: ExecPort;
  readonly db: DbPort;
  readonly git: GitPort;
  /** Resolves when the verify container answers HTTP (dependencies installed, dev server up). */
  ready(): Promise<void>;
  /** Recreates `verify_<runId>` empty (gate 3 migrates a fresh database). */
  resetDatabase(): Promise<void>;
  /** Commits everything on the run branch; null when clean. */
  commit(message: string): Promise<string | null>;
  /** Files the run branch changed against `baseSha` (committed work). */
  changedFiles(): Promise<string[]>;
  merge(message: string): Promise<MergeOutcome>;
  /** After a merge: migrate the dev database; rebuild when configuration changed. */
  applyToApp(changedFiles: string[]): Promise<void>;
  close(opts: { keepBranch: boolean }): Promise<void>;
}

export interface RunEnvironmentFactory {
  open(project: ProjectRow, run: RunRow): Promise<RunEnvironment>;
}

const EXEC_MAX_OUTPUT = 1024 * 1024;
const MIN_VERIFY_READY_SEC = 600;

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const INTROSPECT_SQL = `
SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, COALESCE(c.column_default, '')
FROM information_schema.columns c
WHERE c.table_schema = 'public'
ORDER BY c.table_name, c.ordinal_position;
SELECT tc.table_name, tc.constraint_type, kcu.column_name, COALESCE(ccu.table_name, ''), COALESCE(ccu.column_name, '')
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
LEFT JOIN information_schema.constraint_column_usage ccu ON tc.constraint_type = 'FOREIGN KEY' AND ccu.constraint_name = tc.constraint_name
WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
ORDER BY tc.table_name, tc.constraint_type;
SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname;
`;

/** The engine's implementation over Docker (`ctx.sandbox`) and git (`ctx.repo`). */
export function dockerRunEnvironments(ctx: EngineContext): RunEnvironmentFactory {
  return {
    async open(project, run) {
      const projectId = project.id;
      const repo = ctx.repo(projectId);
      const checkout = await repo.ensureRunCheckout(run.id);
      const baseSha = checkout.headSha;
      const verifyContainer = names.verifyContainer(projectId);
      const database = names.verifyDatabase(run.id);
      const workspace = new LocalWorkspace(checkout.path);

      const readiness = (async () => {
        const passwords = await dbPasswords(ctx, projectId);
        const env = await renderAppEnv(ctx, projectId);
        await ctx.sandbox.createVerify(projectId, run.id, { appRwPassword: passwords.app_rw, env });
        const timeout = Math.max(ctx.config.SANDBOX_START_TIMEOUT_SEC, MIN_VERIFY_READY_SEC);
        const r = await ctx.sandbox.waitHttpReady(verifyContainer, "/", timeout, { probe: ctx.probe, intervalMs: ctx.readyIntervalMs ?? 2000, isReady: (s) => s > 0 });
        if (!r.ready) {
          const logs = await ctx.sandbox.logs(verifyContainer, { tail: 30 }).catch(() => "");
          throw new Error(`The verification server did not start within ${timeout}s.${logs ? `\n${logs.trim()}` : ""}`);
        }
        // `verify_<runId>` starts empty: bring it to the schema of `main` (and its sample data)
        // so agents and pages see what the user's app has. A failure here is the agents' job
        // to see (and gate 3's to report), not a reason to stop the run.
        const seeded = await ctx.sandbox.exec(verifyContainer, ["bash", "-lc", "npm run --silent db:migrate && npm run --silent db:seed"], { timeoutSec: 300, maxOutputBytes: 64 * 1024, cwd: "/workspace" });
        if (seeded.exitCode !== 0) ctx.logger.warn({ projectId, runId: run.id, exitCode: seeded.exitCode, output: `${seeded.stdout}\n${seeded.stderr}`.trim().slice(-2000) }, "verification database: migrate/seed failed");
      })();
      readiness.catch(() => undefined); // observed through ready()

      const psql = async (script: string, opts: { user: string; database: string; csv?: boolean; timeoutSec: number }): Promise<ExecResult> =>
        ctx.sandbox.docker.exec(
          names.dbContainer(projectId),
          ["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", ...(opts.csv ? ["--csv"] : []), "-U", opts.user, "-d", opts.database, "-f", "-"],
          { user: "postgres", stdin: script, timeoutSec: opts.timeoutSec, maxOutputBytes: 2 * 1024 * 1024 },
        );

      const exec: ExecPort = {
        async run(command, { timeoutSec, abortSignal }) {
          try {
            await readiness;
          } catch (err) {
            return { exitCode: null, stdout: "", stderr: `The verification container is not available: ${err instanceof Error ? err.message : String(err)}`, truncated: false, timedOut: false, durationMs: 0 };
          }
          const execution = ctx.sandbox.exec(verifyContainer, ["bash", "-lc", command], { timeoutSec, maxOutputBytes: EXEC_MAX_OUTPUT, cwd: "/workspace" });
          if (!abortSignal) return execution;
          // A stop must not wait for a 15-minute build: answer now; the command dies with the
          // verify container, which `close()` removes.
          return Promise.race([
            execution,
            new Promise<ExecResult>((resolve) => {
              const onAbort = () => resolve({ exitCode: null, stdout: "", stderr: "aborted: the run was stopped", truncated: false, timedOut: false, durationMs: 0 });
              if (abortSignal.aborted) onAbort();
              else abortSignal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
        },
      };

      const db: DbPort = {
        async query(sql, { maxRows, timeoutSec }): Promise<DbQueryResult> {
          const script = `SET statement_timeout = '${Math.max(1, Math.floor(timeoutSec))}s';\nBEGIN TRANSACTION READ ONLY;\n${sql.trim().replace(/;+\s*$/, "")};\nROLLBACK;\n`;
          const r = await psql(script, { user: "cms_ro", database, csv: true, timeoutSec: timeoutSec + 5 });
          if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 2000) || `psql exited with ${r.exitCode}`);
          const rows = csvRows(r.stdout.trim());
          const [header, ...body] = rows;
          if (!header) return { columns: [], rows: [], truncated: false };
          return { columns: header, rows: body.slice(0, maxRows), truncated: body.length > maxRows };
        },
        async introspect() {
          const r = await psql(INTROSPECT_SQL, { user: "cms_ro", database, csv: true, timeoutSec: 20 });
          if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 2000));
          return r.stdout.trim();
        },
      };

      const git: GitPort = {
        log: ({ limit, path }) => repo.logText({ limit, ...(path ? { path } : {}) }),
        diff: ({ from, to, path }) => repo.runDiff({ from: from ?? baseSha, ...(to ? { to } : {}), ...(path ? { path } : {}) }),
      };

      return {
        baseSha,
        workspace,
        exec,
        db,
        git,
        ready: () => readiness,
        async resetDatabase() {
          const drop = await psql(dropRunDatabaseSql(database), { user: DB_SUPERUSER, database: "postgres", timeoutSec: 60 });
          if (drop.exitCode !== 0) throw new Error(`could not drop ${database}: ${drop.stderr.trim()}`);
          const create = await psql(createRunDatabaseSql(database), { user: DB_SUPERUSER, database: "postgres", timeoutSec: 60 });
          if (create.exitCode !== 0) throw new Error(`could not create ${database}: ${create.stderr.trim()}`);
        },
        commit: (message) => repo.commitRun(message),
        changedFiles: () => repo.changedFiles(baseSha, `run/${run.id}`),
        async merge(message) {
          const m = await repo.mergeRun(run.id, { message });
          return { commitSha: m.commitSha, tag: m.tag, merged: m.merged, parentSha: baseSha };
        },
        async applyToApp(changed) {
          const fresh = await ctx.store.getProject(projectId);
          if (!fresh || fresh.serverStatus !== "Active") return;
          if (changed.some((f) => isRebuildRequiredPath(f))) {
            await startRebuild(ctx, fresh);
            return;
          }
          if (changed.some((f) => f.startsWith("drizzle/") || f.startsWith("src/db/"))) await migrate(ctx, projectId);
        },
        async close({ keepBranch }) {
          await readiness.catch(() => undefined);
          await ctx.sandbox.destroyVerify(projectId, run.id).catch((err: unknown) => ctx.logger.warn({ err, projectId, runId: run.id }, "could not remove the verification container"));
          await repo.removeRunCheckout(run.id, { deleteBranch: !keepBranch }).catch((err: unknown) => ctx.logger.warn({ err, projectId, runId: run.id }, "could not remove the run checkout"));
        },
      };
    },
  };
}
