/**
 * DATA_DIR check. Phase 0 proves the engine can write and read back a nonce in DATA_DIR.
 * The cross-check that DATA_DIR_HOST is the same folder seen by the Docker daemon (read the
 * nonce from an ephemeral container, 04 §1) needs the sandbox manager: phase 1.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function checkDataDir(dataDir: string): Promise<{ nonce: string; path: string }> {
  await mkdir(dataDir, { recursive: true });
  const nonce = randomBytes(16).toString("hex");
  const path = join(dataDir, ".forja-nonce");
  await writeFile(path, nonce, { mode: 0o600 });
  const back = (await readFile(path, "utf8")).trim();
  if (back !== nonce) {
    await rm(path, { force: true });
    throw new Error(`DATA_DIR ${dataDir} did not return the nonce just written`);
  }
  return { nonce, path };
}
