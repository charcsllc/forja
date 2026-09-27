/**
 * Every Docker name and label the Forja sandboxes use, in one place (04 §1, §4).
 *
 * Protects:
 * - Names are derived from the project id only through these helpers, so the engine,
 *   Traefik labels, firewall rules (bridge prefix `fj-i-`) and cleanup all agree.
 * - Linux caps interface names at 15 chars: the per-project bridge is `fj-i-<hash8>`
 *   (13 chars), a stable hash of the id, never the id itself.
 * - Every object carries `forja.project=<id>` and a `forja.role`, so
 *   `docker ps -a --filter label=forja.project` finds everything Forja created.
 * - Ids reaching Docker or SQL are validated here: project ids are slugs (`^[a-z0-9-]`,
 *   ≤63), run ids become `verify_<sanitized>` database names (≤63 bytes).
 */
import { createHash } from "node:crypto";

export const APPS_NETWORK = "forja-apps";
export const APP_PORT = 3000;
export const DEFAULT_DB_IMAGE = "postgres:17-alpine";
export const PROBE_IMAGE = "alpine:3.22";
export const DB_SUPERUSER = "postgres";
export const APP_DATABASE = "app";
export const DB_ROLES = ["app_rw", "cms_ro", "cms_rw"] as const;
export type DbRole = (typeof DB_ROLES)[number];

export const LABEL_PROJECT = "forja.project";
export const LABEL_ROLE = "forja.role";
export const LABEL_RUN = "forja.run";
export type SandboxRole = "app" | "verify" | "db" | "probe" | "init";

const PROJECT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class InvalidIdError extends Error {
  override readonly name = "InvalidIdError";
}

export function assertProjectId(projectId: string): string {
  if (!PROJECT_ID_RE.test(projectId)) throw new InvalidIdError(`Invalid project id: ${JSON.stringify(projectId)}`);
  return projectId;
}

export function assertRunId(runId: string): string {
  if (!RUN_ID_RE.test(runId)) throw new InvalidIdError(`Invalid run id: ${JSON.stringify(runId)}`);
  return runId;
}

export function hash8(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export const names = {
  internalNetwork: (id: string) => `forja-int-${assertProjectId(id)}`,
  internalBridge: (id: string) => `fj-i-${hash8(assertProjectId(id))}`,
  dbContainer: (id: string) => `forja-db-${assertProjectId(id)}`,
  dbVolume: (id: string) => `forja-pgdata-${assertProjectId(id)}`,
  appContainer: (id: string) => `forja-app-${assertProjectId(id)}`,
  appNextVolume: (id: string) => `forja-next-${assertProjectId(id)}`,
  verifyContainer: (id: string) => `forja-verify-${assertProjectId(id)}`,
  verifyNextVolume: (id: string) => `forja-next-verify-${assertProjectId(id)}`,
  /** `verify_<runId>`: lowercase, `[a-z0-9_]`, ≤63 bytes (Postgres identifier limit). */
  verifyDatabase: (runId: string) => `verify_${assertRunId(runId).toLowerCase().replace(/[^a-z0-9_]/g, "_")}`.slice(0, 63),
  probeContainer: (nonce: string) => `forja-hostcheck-${nonce}`,
  /** One-shot container that hands a fresh named volume to uid 1000. */
  volumeInitContainer: (volume: string) => `forja-init-${volume}`,
  /** Traefik router/service name. */
  router: (id: string) => `app-${assertProjectId(id)}`,
} as const;

/** Host-side layout under `DATA_DIR` / `DATA_DIR_HOST` (04 §1). */
export const projectPaths = (base: string, id: string) => {
  const root = `${base.replace(/\/+$/, "")}/projects/${assertProjectId(id)}`;
  return { root, work: `${root}/work`, run: `${root}/run`, home: `${root}/home` };
};

export function baseLabels(projectId: string, role: SandboxRole, runId?: string): Record<string, string> {
  const labels: Record<string, string> = { [LABEL_PROJECT]: assertProjectId(projectId), [LABEL_ROLE]: role };
  if (runId !== undefined) labels[LABEL_RUN] = assertRunId(runId);
  return labels;
}

export interface TraefikLabelOptions {
  previewDomain: string;
  /** `websecure` entrypoint (plus `tls=true`) instead of `web`. */
  previewTls?: boolean;
  /** false adds the `forja-preview-auth@file` forward-auth middleware. */
  previewPublic?: boolean;
}

/** Labels of `forja-app-<id>`, exactly as 04 §4. */
export function traefikLabels(projectId: string, { previewDomain, previewTls = false, previewPublic = true }: TraefikLabelOptions): Record<string, string> {
  const router = names.router(projectId);
  const labels: Record<string, string> = {
    "traefik.enable": "true",
    "traefik.docker.network": APPS_NETWORK,
    [`traefik.http.routers.${router}.rule`]: `Host(\`${projectId}.${previewDomain}\`)`,
    [`traefik.http.routers.${router}.entrypoints`]: previewTls ? "websecure" : "web",
    [`traefik.http.services.${router}.loadbalancer.server.port`]: String(APP_PORT),
  };
  if (previewTls) labels[`traefik.http.routers.${router}.tls`] = "true";
  if (!previewPublic) labels[`traefik.http.routers.${router}.middlewares`] = "forja-preview-auth@file";
  return labels;
}

export function previewUrl(projectId: string, previewDomain: string, previewTls = false): string {
  return `${previewTls ? "https" : "http"}://${assertProjectId(projectId)}.${previewDomain}`;
}
