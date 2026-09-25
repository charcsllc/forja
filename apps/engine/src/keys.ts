/**
 * Engine and master keys. Precedence: environment → `DATA_DIR/engine/{engine,master}.key`
 * (written by compose's `init` service) → generated here and written with mode 0600.
 *
 * ⚠️ Never log key values. `FORJA_MASTER_KEY` encrypts project secrets: losing it makes
 * every stored secret unreadable, so a generated one is announced with a warning.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "./logger.js";

export interface EngineKeys {
  engineKey: string;
  masterKey: string;
}

export type KeySource = "env" | "file" | "generated";

async function readKeyFile(path: string): Promise<string | null> {
  try {
    const v = (await readFile(path, "utf8")).trim();
    return v === "" ? null : v;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function resolveOne(
  envValue: string | undefined,
  path: string,
  generate: () => string,
): Promise<{ value: string; source: KeySource }> {
  if (envValue) return { value: envValue, source: "env" };
  const fromFile = await readKeyFile(path);
  if (fromFile) return { value: fromFile, source: "file" };
  const value = generate();
  await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" });
  return { value, source: "generated" };
}

export async function resolveKeys(
  dataDir: string,
  env: { FORJA_ENGINE_KEY?: string | undefined; FORJA_MASTER_KEY?: string | undefined },
  logger: Logger,
): Promise<EngineKeys> {
  const dir = join(dataDir, "engine");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const engine = await resolveOne(env.FORJA_ENGINE_KEY, join(dir, "engine.key"), () =>
    randomBytes(32).toString("base64url"),
  );
  const master = await resolveOne(env.FORJA_MASTER_KEY, join(dir, "master.key"), () =>
    randomBytes(32).toString("base64"),
  );
  if (Buffer.from(master.value, "base64").length !== 32) {
    throw new Error("master key must be 32 bytes, base64-encoded");
  }
  for (const [name, k] of [
    ["engine.key", engine],
    ["master.key", master],
  ] as const) {
    if (k.source === "generated") {
      logger.warn({ file: join(dir, name) }, `generated a new ${name}; back it up`);
    } else {
      logger.info({ source: k.source }, `${name} loaded`);
    }
  }
  return { engineKey: engine.value, masterKey: master.value };
}
