/**
 * Forja Engine entry point.
 *
 * Boot: config → logger → keys → DATA_DIR check → host-path check (04 §1) → `forja-apps`
 * → migrations → queue → jobs → resume interrupted operations → re-attach to project
 * networks → recover agent runs → HTTP. The LLM gateway is created after the keys; a bad
 * LLM configuration is logged and disables agent runs only (services/llm.ts).
 * SIGTERM/SIGINT: stop accepting requests, drain the queue, close pools, exit.
 */
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { serve } from "@hono/node-server";
import { SandboxManager, databaseUrl, networkProbe } from "@forja/sandbox";
import { checkHostPath, ensureAppsNetwork, reattachActive, resumeOperations } from "./boot.js";
import { loadConfig } from "./config.js";
import { checkDataDir } from "./data-dir.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import { pgBossQueue, registerJobs } from "./jobs.js";
import { resolveKeys } from "./keys.js";
import { createLogger } from "./logger.js";
import { diskFreeGb, probeDocker } from "./probes.js";
import { pingQueue, startQueue, stopQueue } from "./queue.js";
import { createDbCmsAdapter } from "./services/cms-dbcms.js";
import type { EngineContext } from "./services/context.js";
import { dbPasswords } from "./services/lifecycle.js";
import { GitProjectRepo } from "./services/repo.js";
import { SecretBox, SecretsService } from "./services/secrets.js";
import { SettingsService } from "./services/settings.js";
import { createLlmService } from "./services/llm.js";
import { recoverRuns } from "./services/runs/service.js";
import { createImageSourcing } from "@forja/media";
import { publicFileUrl, UPLOAD_URL_TTL_SECONDS } from "./services/uploads.js";
import { PgStore } from "./store/pg.js";
import { ENGINE_VERSION } from "./version.js";

const SHUTDOWN_GRACE_MS = 25_000;

/** The engine's own container, when it runs in one (Docker sets the hostname to the short id). */
function selfContainer(configured: string | undefined): string | null {
  if (configured) return configured;
  return existsSync("/.dockerenv") ? hostname() : null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL });
  logger.info(
    {
      version: ENGINE_VERSION,
      preview: `${config.PREVIEW_TLS ? "https" : "http"}://<id>.${config.PREVIEW_DOMAIN}`,
      publish: `${config.PUBLISH_TLS ? "https" : "http"}://<id>.${config.PUBLISH_DOMAIN}`,
      previewPublic: config.PREVIEW_PUBLIC,
      sandbox: { driver: config.SANDBOX_DRIVER, maxActive: config.SANDBOX_MAX_ACTIVE, runner: config.RUNNER_IMAGE },
      template: config.TEMPLATE_DIR,
      budgets: { run: config.BUDGET_PER_RUN_USD, projectMonth: config.BUDGET_PER_PROJECT_MONTH_USD },
    },
    "Forja Engine starting",
  );

  const keys = await resolveKeys(config.DATA_DIR, config, logger);
  await checkDataDir(config.DATA_DIR);

  const dbh = createDb(config.DATABASE_URL);
  const store = new PgStore(dbh.db);
  const secrets = new SecretsService(store, new SecretBox(keys.masterKey));
  const sandbox = new SandboxManager({
    dataDir: config.DATA_DIR,
    dataDirHost: config.DATA_DIR_HOST,
    runnerImage: config.RUNNER_IMAGE,
    dbImage: config.SANDBOX_DB_IMAGE,
    previewDomain: config.PREVIEW_DOMAIN,
    previewTls: config.PREVIEW_TLS,
    previewPublic: config.PREVIEW_PUBLIC,
    runtime: config.SANDBOX_RUNTIME === "runsc" ? "runsc" : undefined,
    mem: config.SANDBOX_MEM,
    cpus: config.SANDBOX_CPUS,
    pids: config.SANDBOX_PIDS,
    probe: networkProbe(),
  });

  const settings = new SettingsService(store, logger);
  const imageSourcing = createImageSourcing({
    env: { ...config.rawProviderEnv, IMAGES_FROM_WEB_SEARCH: String(config.IMAGES_FROM_WEB_SEARCH) },
    settings,
    logger: logger.child({ component: "media" }),
    // The ledger (02 §7): one `media_calls` row per search or generation, charged to the run.
    onCall: (call) =>
      store
        .insertMediaCall({
          projectId: call.projectId,
          runId: call.runId,
          provider: call.provider,
          kind: call.kind,
          model: call.model ?? null,
          units: call.units,
          costUsd: call.costUsd.toFixed(6),
          latencyMs: Math.round(call.latencyMs),
          outcome: call.outcome,
          error: call.error ?? null,
        })
        .catch((err: unknown) => logger.warn({ err, mediaCall: { provider: call.provider, outcome: call.outcome } }, "could not record a media call")),
  });
  logger.info(
    { imagesFromWebSearch: config.IMAGES_FROM_WEB_SEARCH, searchProviders: imageSourcing.searchProviders },
    "image sourcing ready (the UI may override the mode)",
  );

  // LLM gateway + agent roles (phase 2). A configuration that cannot serve the roles keeps
  // the engine up; agent/start explains what to configure (services/llm.ts).
  const llm = createLlmService({ env: process.env, logger });

  // The CMS needs the context (secrets, config) and the context needs the CMS: late-bound.
  const ctx: EngineContext = {
    config,
    store,
    logger,
    masterKey: keys.masterKey,
    secrets,
    sandbox,
    repo: (projectId) => new GitProjectRepo(config.DATA_DIR, projectId, logger),
    queue: pgBossQueue,
    cms: undefined as unknown as EngineContext["cms"],
    settings,
    imageSourcing,
    llm,
    selfContainer: selfContainer(config.ENGINE_CONTAINER),
    probe: networkProbe(),
  };
  ctx.cms = createDbCmsAdapter({
    urls: async (projectId) => {
      const pw = await dbPasswords(ctx, projectId);
      return {
        ro: databaseUrl(projectId, "cms_ro", pw.cms_ro, "app"),
        rw: databaseUrl(projectId, "cms_rw", pw.cms_rw, "app"),
      };
    },
    fileUrl: (projectId, fileNameId) => publicFileUrl(ctx, projectId, `uploads/${fileNameId}`, UPLOAD_URL_TTL_SECONDS),
  });

  const hostPath = await checkHostPath(ctx);
  logger.info({ dataDir: config.DATA_DIR, dataDirHost: config.DATA_DIR_HOST, hostPathCheck: hostPath }, "data dir checked");
  await ensureAppsNetwork(ctx);

  await runMigrations(config.DATABASE_URL, logger);
  await startQueue(config.DATABASE_URL, logger);
  await registerJobs(ctx);
  const resumed = await resumeOperations(ctx);
  if (resumed.resumed.length || resumed.failed.length) logger.warn(resumed, "operations left by the previous process");
  await reattachActive(ctx).catch((err: unknown) => logger.warn({ err }, "could not re-attach to project networks"));
  const runs = await recoverRuns(ctx);
  if (runs.requeued.length || runs.closed.length) logger.warn(runs, "agent runs left by the previous process");

  const app = createApp({
    config,
    engineKey: keys.engineKey,
    masterKey: keys.masterKey,
    logger,
    ctx,
    probes: {
      db: () => dbh.ping(),
      queue: () => pingQueue(),
      docker: () => probeDocker(config.DOCKER_HOST),
      diskFreeGb: () => diskFreeGb(config.DATA_DIR),
      dataDirCheck: () => hostPath,
    },
  });

  const server = serve({ fetch: app.fetch, port: config.ENGINE_PORT, hostname: "0.0.0.0" }, (info) =>
    logger.info({ port: info.port, selfContainer: ctx.selfContainer }, "engine listening"),
  );

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("shutdown timed out; exiting");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    server.close(async () => {
      try {
        await stopQueue();
        await ctx.cms.close();
        await dbh.close();
        logger.info("bye");
        process.exit(0);
      } catch (err) {
        logger.error({ err }, "error during shutdown");
        process.exit(1);
      }
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  // The logger may not exist yet; keep this on stderr without secrets.
  process.stderr.write(`Forja Engine failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
