/**
 * Project file shapes of API v1: tree, content, write, upload and source archive.
 *
 * Protects: writes are always base64 (`encoding: "base64"`), and `bytesWritten` equals
 * the decoded byte length (the visual editor's fidelity canary checks it). Upload
 * answers `{url, fileNameId}`; `fileNameId` is what file fields store.
 */
import { z } from "zod";

export const FileTreeEntrySchema = z.object({
  /** Root-relative, e.g. `src/app/page.tsx`. */
  path: z.string(),
  name: z.string(),
  type: z.enum(["file", "folder"]),
  size: z.number().int().nonnegative().optional(),
  /** 0 at the project root. */
  depth: z.number().int().nonnegative(),
});
export type FileTreeEntry = z.infer<typeof FileTreeEntrySchema>;

/** `GET P/files/tree?path&limit&offset`. */
export const FileTreeSchema = z.object({
  entries: z.array(FileTreeEntrySchema),
  totalEntries: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  commitSha: z.string().nullable(),
  filesCount: z.number().int().nonnegative(),
});
export type FileTree = z.infer<typeof FileTreeSchema>;

export const FileTreeQuerySchema = z.object({
  path: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
export type FileTreeQuery = z.infer<typeof FileTreeQuerySchema>;

export const FileEncodingSchema = z.enum(["utf8", "base64"]);
export type FileEncoding = z.infer<typeof FileEncodingSchema>;

/** `GET P/files/content?path=`. `base64` when the file looks binary. */
export const FileContentSchema = z.object({
  path: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  encoding: FileEncodingSchema,
  content: z.string(),
  commitSha: z.string().nullable(),
});
export type FileContent = z.infer<typeof FileContentSchema>;

/** `PUT P/files/content`. `baseCommitSha` → `409 STALE_WRITE` when `main` moved. */
export const FileWriteRequestSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.literal("base64"),
  baseCommitSha: z.string().optional(),
});
export type FileWriteRequest = z.infer<typeof FileWriteRequestSchema>;

export const FileWriteResultSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  created: z.boolean(),
  commitSha: z.string().optional(),
  filesCount: z.number().int().nonnegative().optional(),
  /** Always true: the running server serves the old build until a rebuild. */
  rebuildRequired: z.boolean(),
});
export type FileWriteResult = z.infer<typeof FileWriteResultSchema>;

/** `POST P/files/upload` (multipart field `file`). */
export const UploadResultSchema = z.object({
  url: z.string(),
  fileNameId: z.string(),
});
export type UploadResult = z.infer<typeof UploadResultSchema>;

/** `GET P/source-code`: a signed archive URL (zip, tar.gz or tar). */
export const SourceCodeResultSchema = z.object({
  downloadUrl: z.string(),
  filesCount: z.number().int().nonnegative().optional(),
  lastCommitSha: z.string().optional(),
});
export type SourceCodeResult = z.infer<typeof SourceCodeResultSchema>;
