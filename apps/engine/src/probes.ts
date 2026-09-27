/**
 * Health probes that do not need the database.
 * Docker: phase 0 only pings the Docker API at DOCKER_HOST (the socket proxy in compose).
 * Phase 1 replaces this with dockerode in packages/sandbox.
 */
import { statfs } from "node:fs/promises";
import http from "node:http";

export type DockerState = "ok" | "error" | "unavailable";

/** GET /_ping on `tcp://host:port`, `http://host:port` or `unix:///path.sock`. */
export function probeDocker(dockerHost: string | undefined, timeoutMs = 2000): Promise<DockerState> {
  if (!dockerHost) return Promise.resolve("unavailable");
  let target: http.RequestOptions;
  try {
    if (dockerHost.startsWith("unix://")) {
      target = { socketPath: dockerHost.slice("unix://".length), path: "/_ping" };
    } else {
      const u = new URL(dockerHost.replace(/^tcp:\/\//, "http://"));
      if (u.protocol !== "http:") return Promise.resolve("error");
      target = { host: u.hostname, port: u.port || 2375, path: "/_ping" };
    }
  } catch {
    return Promise.resolve("error");
  }
  return new Promise((resolve) => {
    const req = http.get({ ...target, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? "ok" : "error");
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve("error"));
  });
}

export async function diskFreeGb(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}
