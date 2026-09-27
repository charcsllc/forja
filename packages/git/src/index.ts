/**
 * `@forja/git`: project repositories for the Forja Engine (04 §1, §5, §6).
 *
 * Protects: the engine talks to git only through `ProjectRepo` (native git, argv only,
 * hermetic config) and gets typed `GitError`s back, never raw stderr.
 */
export { GitError, GIT_ERROR_CODES, isGitError, type GitErrorCode, type GitErrorDetails } from "./errors.js";
export {
  INFO_EXCLUDE_LINES,
  LOCKFILES,
  SCRATCH_DIRS,
  TREE_EXCLUDED_NAMES,
  isRebuildRequiredPath,
  isScratchPath,
  normalizeRelPath,
} from "./paths.js";
export { FORJA_AUTHOR_EMAIL, FORJA_AUTHOR_NAME, GitRunner, type GitRunOptions, type GitRunResult } from "./runner.js";
export {
  DEFAULT_COALESCE_MAX_MS,
  DEFAULT_COALESCE_WINDOW_MS,
  DEFAULT_READ_MAX_BYTES,
  DEFAULT_TREE_LIMIT,
  DEFAULT_WRITE_MAX_BYTES,
  ProjectRepo,
  type CheckoutName,
  type CommitResult,
  type DiffResult,
  type InitResult,
  type LogResult,
  type MergeResult,
  type ProjectRepoOptions,
  type ReadFileOptions,
  type RestoreResult,
  type RunCheckout,
  type TreeOptions,
  type VersionEntry,
  type WriteFileOptions,
  type WriteFileResult,
} from "./repo.js";
