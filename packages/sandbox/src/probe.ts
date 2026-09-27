/**
 * HTTP readiness probes for sandbox containers (04 §3: poll until 200).
 *
 * Protects: `*.localhost` does not resolve inside containers and the engine sits on
 * `forja-apps`, so there are two honest ways to ask "is the dev server up?":
 * - `networkProbe`: the engine fetches `http://<container>:3000<path>` over `forja-apps`
 *   (production strategy). Redirects are not followed; a 3xx counts as an answer.
 * - `inContainerProbe`: a short-lived exec inside the container hits 127.0.0.1 (tests,
 *   and hosts where the engine is not on the apps network). `node` uses fetch (runner
 *   image); `wget` is busybox's (alpine stand-ins).
 * A probe returns the HTTP status or null (no answer); readiness policy lives in the
 * manager.
 */
import type { DockerApi } from "./docker.js";

export interface ProbeTarget {
  container: string;
  port: number;
  path: string;
}

export interface HttpProbe {
  readonly kind: string;
  status(target: ProbeTarget): Promise<number | null>;
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function networkProbe({ fetchImpl = fetch, timeoutMs = 5_000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): HttpProbe {
  return {
    kind: "network",
    async status({ container, port, path }) {
      try {
        const response = await fetchImpl(`http://${container}:${port}${normalizePath(path)}`, {
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel().catch(() => undefined);
        return response.status;
      } catch {
        return null;
      }
    },
  };
}

const NODE_PROBE =
  "fetch(process.argv[1],{redirect:'manual',signal:AbortSignal.timeout(5000)})" +
  ".then(r=>{process.stdout.write(String(r.status))},()=>process.exit(3))";

export function inContainerProbe(docker: DockerApi, { tool = "node" }: { tool?: "node" | "wget" } = {}): HttpProbe {
  return {
    kind: `inContainer:${tool}`,
    async status({ container, port, path }) {
      const url = `http://127.0.0.1:${port}${normalizePath(path)}`;
      const argv = tool === "node" ? ["node", "-e", NODE_PROBE, url] : ["wget", "-q", "-S", "-T", "5", "-O", "/dev/null", url];
      try {
        const result = await docker.exec(container, argv, { timeoutSec: 8, maxOutputBytes: 16 * 1024 });
        if (tool === "node") {
          const status = Number(result.stdout.trim());
          return result.exitCode === 0 && Number.isInteger(status) && status > 0 ? status : null;
        }
        const match = /HTTP\/[\d.]+\s+(\d{3})/.exec(`${result.stderr}\n${result.stdout}`);
        return match?.[1] ? Number(match[1]) : null;
      } catch {
        return null;
      }
    },
  };
}
