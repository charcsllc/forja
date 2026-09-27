/**
 * Forja Engine entry point.
 *
 * Boot: config → logger → keys → DATA_DIR check → migrations → queue → HTTP.
 * SIGTERM/SIGINT: stop accepting requests, drain the queue, close the pool, exit.
 */
import { serve } from "@hono/node-server";
import { loadConfig } from "./config.js";
import { checkDataDir } from "./data-dir.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createApp } from "./http/app.js";
import { resolveKeys } from "./keys.js";
import { createLogger } from "./logger.js";
import { diskFreeGb, probeDocker } from "./probes.js";
import { pingQueue, startQueue, stopQueue } from "./queue.js";
import { ENGINE_VERSION } from "./version.js";

const SHUTDOWN_GRACE_MS = 25_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL });
  logger.info(
    {
      version: ENGINE_VERSION,
      preview: `${config.PREVIEW_TLS ? "https" : "http"}://<id>.${config.PREVIEW_DOMAIN}`,
      publish: `${config.PUBLISH_TLS ? "https" : "http"}://<id>.${config.PUBLISH_DOMAIN}`,
      previewPublic: config.PREVIEW_PUBLIC,
      sandbox: { driver: config.SANDBOX_DRIVER, maxActive: config.SANDBOX_MAX_ACTIVE },
      budgets: { run: config.BUDGET_PER_RUN_USD, projectMonth: config.BUDGET_PER_PROJECT_MONTH_USD },
    },
    "Forja Engine starting",
  );

  const keys = await resolveKeys(config.DATA_DIR, config, logger);

  await checkDataDir(config.DATA_DIR);
  logger.info(
    { dataDir: config.DATA_DIR, dataDirHost: config.DATA_DIR_HOST, hostPathCheck: "skipped" },
    "data dir writable; host-path check via container is deferred to phase 1 (skipped)",
  );

  const dbh = createDb(config.DATABASE_URL);
  await runMigrations(config.DATABASE_URL, logger);
  await startQueue(config.DATABASE_URL, logger);

  const app = createApp({
    config,
    engineKey: keys.engineKey,
    masterKey: keys.masterKey,
    logger,
    probes: {
      db: () => dbh.ping(),
      queue: () => pingQueue(),
      docker: () => probeDocker(config.DOCKER_HOST),
      diskFreeGb: () => diskFreeGb(config.DATA_DIR),
      dataDirCheck: () => "skipped",
    },
  });

  const server = serve({ fetch: app.fetch, port: config.ENGINE_PORT, hostname: "0.0.0.0" }, (info) =>
    logger.info({ port: info.port }, "engine listening"),
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
  process.stderr.write(`Forja Engine failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
