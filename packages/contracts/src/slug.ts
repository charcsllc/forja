/**
 * Project slug rules.
 *
 * Protects: `projects.id` is immutable and doubles as a hostname label, so creation
 * rules mirror the UI (`apps/web/src/lib/project-slug.ts`, itself a copy of Totalum's
 * `createProject`) character for character, and the engine additionally refuses the
 * names its own infrastructure uses as subdomains (`RESERVED_PROJECT_IDS`,
 * docs/architecture/05-data-model-and-api.md §1).
 *
 * Creation (`isValidProjectSlug`) and reading (`isRoutableProjectSlug`) are different
 * jobs: an existing project minted under other limits must still be reachable.
 */

/** Totalum's own regex, character for character. */
export const PROJECT_SLUG_REGEX = /^[a-z]([a-z0-9]|-(?!-))*(?<!-)$/;

export const PROJECT_SLUG_MIN_LENGTH = 4;
export const PROJECT_SLUG_MAX_LENGTH = 35;

/** Longest id a URL may carry: a DNS label. */
export const ROUTABLE_SLUG_MAX_LENGTH = 63;

/** `-dev-` is reserved: development hostnames are derived from it. */
export const RESERVED_SLUG_FRAGMENT = "-dev-";

/** Subdomains the platform itself uses; never valid as a new project id. */
export const RESERVED_PROJECT_IDS: ReadonlySet<string> = new Set([
  "apps",
  "www",
  "traefik",
  "engine",
  "web",
  "api",
  "preview",
  "mail",
  "admin",
  "static",
  "cdn",
  "forja",
  "localhost",
  "db",
  "postgres",
  "ns1",
  "ns2",
  "smtp",
  "ftp",
  "git",
  "docs",
  "status",
  "app",
  "dev",
  "prod",
  "test",
]);

/** Why a slug is not acceptable for creation. */
export type SlugProblem = "empty" | "too-short" | "too-long" | "invalid-format" | "reserved";

/**
 * Creation rules in the UI's order: format, length, `-dev-`. Reserved ids are a
 * separate check (`isReservedProjectId`) because they map to a different error code
 * (`RESERVED_PROJECT_NAME`) and several are shorter than the minimum length anyway.
 */
export function validateProjectSlug(slug: string): SlugProblem | null {
  if (!slug) return "empty";
  if (!PROJECT_SLUG_REGEX.test(slug)) return "invalid-format";
  if (slug.length < PROJECT_SLUG_MIN_LENGTH) return "too-short";
  if (slug.length > PROJECT_SLUG_MAX_LENGTH) return "too-long";
  if (slug.includes(RESERVED_SLUG_FRAGMENT)) return "reserved";
  return null;
}

/** Whether a new project may be created with this id (format and length rules only). */
export function isValidProjectSlug(slug: string): boolean {
  return validateProjectSlug(slug) === null;
}

/** Whether an existing project id may appear in a route (read path). */
export function isRoutableProjectSlug(slug: string): boolean {
  if (!slug) return false;
  if (slug.length > ROUTABLE_SLUG_MAX_LENGTH) return false;
  return PROJECT_SLUG_REGEX.test(slug);
}

/** Whether the id is one of the platform's own subdomains (case-insensitive). */
export function isReservedProjectId(id: string): boolean {
  return RESERVED_PROJECT_IDS.has(id.toLowerCase());
}
