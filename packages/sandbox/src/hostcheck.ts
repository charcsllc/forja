/**
 * Startup check that `DATA_DIR` (engine view) and `DATA_DIR_HOST` (daemon view) are the
 * same folder (04 §1). Every bind mount of every sandbox depends on it.
 *
 * Protects: a nonce is written through `dataDir` and read back by an ephemeral
 * `alpine:3.22` container that binds `dataDirHost` read-only, with no network and no
 * capabilities. Any other answer (different content, missing source, container failure)
 * is `mismatch`; the engine refuses to start. The probe container and the nonce file are
 * always removed.
 */
import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DockerApi } from "./docker.js";
import { LABEL_ROLE, PROBE_IMAGE, names } from "./names.js";

export interface HostPathCheckResult {
  status: "ok" | "mismatch";
  reason?: string;
}

export async function hostPathCheck(
  dataDir: string,
  dataDirHost: string,
  { docker, image = PROBE_IMAGE }: { docker: DockerApi; image?: string },
): Promise<HostPathCheckResult> {
  const nonce = randomBytes(12).toString("hex");
  const fileName = `.forja-hostcheck-${nonce}`;
  const localFile = path.join(dataDir, fileName);
  const container = names.probeContainer(nonce);
  try {
    await writeFile(localFile, nonce, { mode: 0o644 });
  } catch (error) {
    return { status: "mismatch", reason: `cannot write in DATA_DIR: ${(error as Error).message}` };
  }
  try {
    try {
      await docker.createContainer({
        name: container,
        Image: image,
        Cmd: ["cat", `/probe/${fileName}`],
        User: "1000:1000",
        // Not tied to a project, so only the role label.
        Labels: { [LABEL_ROLE]: "probe" },
        HostConfig: {
          Mounts: [{ Type: "bind", Source: dataDirHost, Target: "/probe", ReadOnly: true }],
          NetworkMode: "none",
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          ReadonlyRootfs: true,
          PidsLimit: 16,
          Memory: 32 * 1024 * 1024,
        },
      });
    } catch (error) {
      return { status: "mismatch", reason: `probe container refused: ${(error as Error).message}` };
    }
    await docker.startContainer(container);
    const exitCode = await docker.waitContainer(container);
    const output = (await docker.logs(container)).trim();
    if (exitCode === 0 && output === nonce) return { status: "ok" };
    return { status: "mismatch", reason: exitCode === 0 ? "different content" : `probe exited ${exitCode}` };
  } finally {
    await docker.removeContainer(container, { force: true }).catch(() => false);
    await rm(localFile, { force: true });
  }
}

