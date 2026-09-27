/**
 * Standalone migrations: `npm run db:migrate -w @forja/engine` (tsx) or `node dist/migrate.js`.
 * The server applies the same migrations at every boot (src/index.ts).
 */
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger({ level: config.LOG_LEVEL });
try {
  await runMigrations(config.DATABASE_URL, logger);
} catch (err) {
  logger.error({ err }, "migration failed");
  process.exitCode = 1;
}
