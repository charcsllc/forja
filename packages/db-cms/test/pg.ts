/**
 * A throwaway `postgres:17-alpine` for the integration suite: data on tmpfs, a random
 * loopback port, removed (`docker rm -f`) when the suite ends. Uses only the image that
 * is already present locally; nothing is pulled.
 */
import { execFileSync } from "node:child_process";
import postgres from "postgres";

export interface ThrowawayPg {
  name: string;
  url: string;
  stop(): void;
}

export async function startPostgres(): Promise<ThrowawayPg> {
  const name = `forja-dbcms-it-${Math.random().toString(36).slice(2, 8)}`;
  const password = Math.random().toString(36).slice(2);
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "--tmpfs", "/var/lib/postgresql/data:rw,size=256m",
    "-e", `POSTGRES_PASSWORD=${password}`,
    "-p", "127.0.0.1::5432",
    "--pull", "never",
    "postgres:17-alpine",
  ]);
  const stop = () => {
    try {
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  };
  try {
    const mapping = execFileSync("docker", ["port", name, "5432/tcp"]).toString().trim().split("\n")[0] ?? "";
    const port = mapping.slice(mapping.lastIndexOf(":") + 1);
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const probe = postgres(url, { max: 1, connect_timeout: 2, onnotice: () => {} });
      try {
        await probe`SELECT 1`;
        await probe.end();
        break;
      } catch (error) {
        await probe.end({ timeout: 0 }).catch(() => {});
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    return { name, url, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
