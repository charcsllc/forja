/**
 * Version shapes of API v1: list, recover and diff.
 *
 * Protects: `commitSha` is the only handle for a diff (`version-diff?commitSha=`);
 * `commitMessage` is a sentence, never a URL. Recovery is async: the UI watches
 * `project.versionRecovery`.
 */
import { z } from "zod";

export const ProjectVersionSchema = z.object({
  _id: z.string(),
  name: z.string(),
  commitSha: z.string().optional(),
  commitMessage: z.string().optional(),
  prompt: z.string().optional(),
  createdAt: z.string(),
});
export type ProjectVersion = z.infer<typeof ProjectVersionSchema>;

/** `GET P/versions?limit&skip`. */
export const VersionsListSchema = z.object({
  versions: z.array(ProjectVersionSchema),
  totalCount: z.number().int().nonnegative(),
});
export type VersionsList = z.infer<typeof VersionsListSchema>;

export const VersionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
  skip: z.coerce.number().int().nonnegative().optional(),
});
export type VersionsQuery = z.infer<typeof VersionsQuerySchema>;

/** `GET P/version-diff?commitSha=`: a unified diff. */
export const VersionDiffSchema = z.object({
  commitSha: z.string(),
  diff: z.string(),
});
export type VersionDiff = z.infer<typeof VersionDiffSchema>;

/** `GET /api/vcaas/git-diff?url=` (UI route) data. */
export const GitDiffResultSchema = z.object({ diff: z.string() });
export type GitDiffResult = z.infer<typeof GitDiffResultSchema>;
