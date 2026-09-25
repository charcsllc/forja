import { Hono } from "hono";
import { ENGINE_VERSION } from "../../version.js";
import type { DockerState } from "../../probes.js";

export interface HealthProbes {
  db(): Promise<boolean>;
  queue(): Promise<boolean>;
  docker(): Promise<DockerState>;
  diskFreeGb(): Promise<number | null>;
  /** Host-path check runs in phase 1 (needs a container); "skipped" until then. */
  dataDirCheck(): "ok" | "skipped";
}

export interface HealthBody {
  ok: boolean;
  version: string;
  db: "ok" | "error";
  queue: "ok" | "error";
  docker: DockerState;
  disk: { freeGb: number | null };
  dataDirCheck: "ok" | "skipped";
}

/** `GET /v2/system/health` (public). 200 when db and queue are up, else 503. */
export function healthRoutes(probes: HealthProbes): Hono {
  const r = new Hono();
  r.get("/v2/system/health", async (c) => {
    const [db, queue, docker, freeGb] = await Promise.all([
      probes.db().catch(() => false),
      probes.queue().catch(() => false),
      probes.docker().catch((): DockerState => "error"),
      probes.diskFreeGb().catch(() => null),
    ]);
    const body: HealthBody = {
      ok: db && queue,
      version: ENGINE_VERSION,
      db: db ? "ok" : "error",
      queue: queue ? "ok" : "error",
      docker,
      disk: { freeGb },
      dataDirCheck: probes.dataDirCheck(),
    };
    c.header("Cache-Control", "no-store");
    return c.json(body, body.ok ? 200 : 503);
  });
  return r;
}
