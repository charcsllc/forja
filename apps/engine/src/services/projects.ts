/**
 * Projects: creation with the UI's slug rules, listing, the full `VcaasProject` shape, soft
 * delete and undelete (05 §1–§2, research/02 §1.1, §4).
 *
 * Protects:
 * - Creation validates exactly like the UI (`validateProjectSlug`) and refuses the platform's
 *   own subdomains (`RESERVED_PROJECT_NAME`). A taken id is NOT an error: the engine picks
 *   `<id>-2`, `<id>-3`… (trimmed to 35 chars) and echoes `requestedProjectId`; the returned
 *   `projectId` is the authority (the UI navigates to it).
 * - Deleted projects keep their id until purged, so an id is never silently reused while
 *   `undelete` is possible.
 * - `GET /projects` returns ALL projects when no `limit` is sent (the home page sends none).
 * - The project object carries every field the UI reads; `developmentUrlFieldToUse` is a
 *   field NAME, `internalDevelopmentUrl` is what the UI server's preview proxy may use.
 */
import {
  PROJECT_SLUG_MAX_LENGTH,
  isReservedProjectId,
  isRoutableProjectSlug,
  validateProjectSlug,
  type VcaasProject,
  type VcaasProjectSummary,
} from "@forja/contracts";
import { APP_PORT, names, previewUrl } from "@forja/sandbox";
import { EngineError, engineError, notFound } from "../http/errors.js";
import type { ProjectRow } from "../store/types.js";
import type { EngineContext } from "./context.js";

const MAX_SUFFIX = 999;

export function assertCreatableSlug(slug: string): void {
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new EngineError(400, "MISSING_PROJECT_ID", "projectId is required");
  }
  const problem = validateProjectSlug(slug);
  if (problem === "too-short" || problem === "too-long") {
    throw new EngineError(400, "INVALID_PROJECT_NAME_LENGTH", "The project id must be 4–35 characters long.");
  }
  if (problem === "reserved") {
    throw new EngineError(400, "RESERVED_PROJECT_NAME", 'The project id may not contain "-dev-".');
  }
  if (problem) {
    throw new EngineError(
      400,
      "INVALID_PROJECT_NAME",
      "The project id must start with a letter and use lowercase letters, digits and single hyphens.",
    );
  }
  if (isReservedProjectId(slug)) {
    throw new EngineError(400, "RESERVED_PROJECT_NAME", `"${slug}" is reserved by the platform.`);
  }
}

/** `<base>-<n>` trimmed so the whole id stays within 35 chars and ends without a hyphen. */
export function suffixed(base: string, n: number): string {
  const tail = `-${n}`;
  const head = base.slice(0, PROJECT_SLUG_MAX_LENGTH - tail.length).replace(/-+$/, "");
  return `${head}${tail}`;
}

export async function getLiveProject(ctx: EngineContext, projectId: string): Promise<ProjectRow> {
  if (!isRoutableProjectSlug(projectId)) throw notFound();
  const p = await ctx.store.getProject(projectId);
  if (!p) throw notFound();
  return p;
}

export interface CreateInput {
  projectId: string;
  description?: string | null;
  label?: string | null;
}

export interface CreateResult {
  project: ProjectRow;
  requestedProjectId: string;
}

/** Inserts the row (Creating). Provisioning is started by the caller (`lifecycle.startProvision`). */
export async function createProjectRow(ctx: EngineContext, input: CreateInput): Promise<CreateResult> {
  const requested = input.projectId?.trim().toLowerCase() ?? "";
  assertCreatableSlug(requested);
  const description = (input.description ?? "").toString();
  const label = (input.label ?? "").toString().trim() || requested;
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const id = n === 1 ? requested : suffixed(requested, n);
    if (n > 1 && (validateProjectSlug(id) !== null || isReservedProjectId(id))) continue;
    if (await ctx.store.projectIdTaken(id)) continue;
    const row = await ctx.store.insertProject({
      id,
      label,
      description,
      serverStatus: "Creating",
      devUrl: previewUrl(id, ctx.config.PREVIEW_DOMAIN, ctx.config.PREVIEW_TLS),
      internalDevUrl: `http://${names.appContainer(id)}:${APP_PORT}`,
      lastActivityAt: new Date(),
    });
    if (row) return { project: row, requestedProjectId: requested };
  }
  throw engineError("PROJECT_ALREADY_EXISTS", `Could not find a free id derived from "${requested}".`);
}

export function toSummary(p: ProjectRow): VcaasProjectSummary {
  return {
    projectId: p.id,
    label: p.label,
    description: p.description ?? "",
    plan: "self-hosted",
    createdAt: p.createdAt.toISOString(),
    lastModifiedAt: (p.lastActivityAt ?? p.updatedAt).toISOString(),
    previewImageUrl: null,
  };
}

export type EngineProject = VcaasProject & {
  /** Engine extension: why the sandbox is not Active (provision/wake/restart failure). */
  serverErrorMessage: string | null;
  lastModifiedAt: string;
  templateVersion: string | null;
  requestedProjectId?: string;
};

export async function toProject(ctx: EngineContext, p: ProjectRow): Promise<EngineProject> {
  const secrets = await ctx.secrets.listForApi(p.id);
  const recovery = p.versionRecovery as VcaasProject["versionRecovery"];
  return {
    projectId: p.id,
    label: p.label,
    description: p.description ?? "",
    plan: "self-hosted",
    agentProcessStatus: p.processStatus as VcaasProject["agentProcessStatus"],
    agentServerStatus: p.serverStatus as VcaasProject["agentServerStatus"],
    createdAt: p.createdAt.toISOString(),
    lastModifiedAt: (p.lastActivityAt ?? p.updatedAt).toISOString(),
    deployment: null,
    versionRecovery: recovery ?? null,
    importInProgress: null,
    secrets,
    customDomain: null,
    temporalDevelopmentProjectUrl: p.devUrl ?? previewUrl(p.id, ctx.config.PREVIEW_DOMAIN, ctx.config.PREVIEW_TLS),
    cachedDevelopmentUrl: p.cachedUrl,
    developmentUrlFieldToUse: p.urlFieldToUse,
    previewImageUrl: null,
    totalCreditsSpent: 0,
    internalDevelopmentUrl: p.internalDevUrl ?? `http://${names.appContainer(p.id)}:${APP_PORT}`,
    serverErrorMessage: p.serverError,
    templateVersion: p.templateVersion,
  };
}

export interface ListQuery {
  limit?: number;
  skip?: number;
  search?: string;
  sortDirection?: "asc" | "desc";
}

export async function listProjects(ctx: EngineContext, q: ListQuery = {}): Promise<VcaasProjectSummary[]> {
  let rows = await ctx.store.listProjects();
  if (q.search) {
    const needle = q.search.toLowerCase();
    rows = rows.filter((p) => [p.id, p.label, p.description ?? ""].some((v) => v.toLowerCase().includes(needle)));
  }
  const key = (p: ProjectRow) => (p.lastActivityAt ?? p.updatedAt).getTime();
  rows.sort((a, b) => (q.sortDirection === "asc" ? key(a) - key(b) : key(b) - key(a)));
  const skip = q.skip ?? 0;
  const page = q.limit === undefined ? rows.slice(skip) : rows.slice(skip, skip + q.limit);
  return page.map(toSummary);
}

export async function updateProjectMeta(
  ctx: EngineContext,
  projectId: string,
  patch: { label?: string | null; description?: string | null },
): Promise<ProjectRow> {
  const p = await getLiveProject(ctx, projectId);
  const next: { label?: string; description?: string } = {};
  if (patch.label !== undefined) next.label = patch.label === null || patch.label.trim() === "" ? p.id : patch.label.trim();
  if (patch.description !== undefined) next.description = patch.description ?? "";
  const out = await ctx.store.updateProject(projectId, next);
  if (!out) throw notFound();
  return out;
}
