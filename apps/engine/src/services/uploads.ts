/**
 * Uploads (`POST files/upload`, 05 §1 `uploads`, 07 §1 "Subidas").
 *
 * Protects:
 * - The MIME type comes from the CONTENT (magic bytes), never from the client's name or
 *   header. Executables (ELF, PE, Mach-O, shebang scripts) and unknown binaries are refused
 *   with `INVALID_FILE_TYPE`.
 * - Stored under `DATA_DIR/projects/<id>/uploads/<fileNameId>` with a random name
 *   (`fileNameId`, UUID v7 + a safe extension); the original name is metadata only.
 * - The size limit is `UPLOAD_MAX_MB`, checked before anything is written.
 * - The returned URL is `${WEB_PUBLIC_URL}/api/files/<token>`: a signed, expiring, project-
 *   bound token served by the UI, so the engine is never exposed (05 §2.3).
 *
 * Deviation (phase 1): images are stored as uploaded, not re-encoded (re-encoding needs
 * `sharp`, which lives in the browser sidecar from phase 3).
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { signPublicToken } from "../auth/signed-url.js";
import { EngineError, engineError } from "../http/errors.js";
import { uuidv7 } from "../ids.js";
import type { EngineContext } from "./context.js";
import { projectRoot } from "./repo.js";

export const UPLOAD_URL_TTL_SECONDS = 30 * 86_400;

export interface Sniffed {
  mime: string;
  ext: string;
}

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  sig.every((v, i) => b[offset + i] === v);

const ascii = (b: Uint8Array, from: number, to: number): string => Buffer.from(b.subarray(from, to)).toString("latin1");

function isUtf8Text(b: Uint8Array): boolean {
  if (b.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

/** Content sniffing. Returns null for anything not on the allow-list. */
export function sniffMime(bytes: Uint8Array, originalName = ""): Sniffed | null {
  const b = bytes;
  if (b.length === 0) return null;
  // Refuse executables outright, whatever else they might look like.
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return null; // ELF
  if (startsWith(b, [0x4d, 0x5a])) return null; // PE / MZ
  if (startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(b, [0xfe, 0xed, 0xfa, 0xcf]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe])) return null; // Mach-O
  if (startsWith(b, [0x23, 0x21])) return null; // "#!" script

  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: ".png" };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: ".jpg" };
  if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return { mime: "image/gif", ext: ".gif" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return { mime: "image/webp", ext: ".webp" };
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE") return { mime: "audio/wav", ext: ".wav" };
  if (ascii(b, 4, 8) === "ftyp") {
    const brand = ascii(b, 8, 12);
    if (brand === "avif" || brand === "avis") return { mime: "image/avif", ext: ".avif" };
    if (brand === "heic" || brand === "heix" || brand === "mif1") return { mime: "image/heic", ext: ".heic" };
    if (brand === "qt  ") return { mime: "video/quicktime", ext: ".mov" };
    if (brand.startsWith("M4A")) return { mime: "audio/mp4", ext: ".m4a" };
    return { mime: "video/mp4", ext: ".mp4" };
  }
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { mime: "video/webm", ext: ".webm" };
  if (startsWith(b, [0x00, 0x00, 0x01, 0x00])) return { mime: "image/x-icon", ext: ".ico" };
  if (ascii(b, 0, 5) === "%PDF-") return { mime: "application/pdf", ext: ".pdf" };
  if (ascii(b, 0, 3) === "ID3" || startsWith(b, [0xff, 0xfb]) || startsWith(b, [0xff, 0xf3])) return { mime: "audio/mpeg", ext: ".mp3" };
  if (ascii(b, 0, 4) === "OggS") return { mime: "audio/ogg", ext: ".ogg" };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) {
    const ext = path.extname(originalName).toLowerCase();
    if (ext === ".docx") return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext };
    if (ext === ".xlsx") return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext };
    if (ext === ".pptx") return { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext };
    return { mime: "application/zip", ext: ".zip" };
  }
  if (startsWith(b, [0x1f, 0x8b])) return { mime: "application/gzip", ext: ".gz" };
  if (startsWith(b, [0x77, 0x4f, 0x46, 0x32])) return { mime: "font/woff2", ext: ".woff2" };
  if (startsWith(b, [0x77, 0x4f, 0x46, 0x46])) return { mime: "font/woff", ext: ".woff" };

  const head = b.subarray(0, Math.min(b.length, 64 * 1024));
  if (isUtf8Text(head) && isUtf8Text(b)) {
    const text = Buffer.from(head).toString("utf8").replace(/^﻿/, "").trimStart();
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(text)) return { mime: "image/svg+xml", ext: ".svg" };
    const ext = path.extname(originalName).toLowerCase();
    const textTypes: Record<string, string> = {
      ".json": "application/json",
      ".csv": "text/csv",
      ".md": "text/markdown",
      ".markdown": "text/markdown",
      ".txt": "text/plain",
    };
    const mime = textTypes[ext];
    return mime ? { mime: `${mime}; charset=utf-8`, ext } : { mime: "text/plain; charset=utf-8", ext: ".txt" };
  }
  return null;
}

export function publicFileUrl(ctx: EngineContext, projectId: string, resource: string, ttlSeconds: number): string {
  const token = signPublicToken(ctx.masterKey, { projectId, resource, ttlSeconds });
  return `${ctx.config.WEB_PUBLIC_URL}/api/files/${token}`;
}

export function uploadsDir(ctx: EngineContext, projectId: string): string {
  return path.join(projectRoot(ctx.config.DATA_DIR, projectId), "uploads");
}

export async function storeUpload(
  ctx: EngineContext,
  projectId: string,
  file: { name: string; bytes: Uint8Array },
): Promise<{ url: string; fileNameId: string }> {
  const max = ctx.config.UPLOAD_MAX_MB * 1024 * 1024;
  if (file.bytes.byteLength > max) {
    throw engineError("FILE_TOO_LARGE", `The file is larger than ${ctx.config.UPLOAD_MAX_MB} MB.`, { limit: max, size: file.bytes.byteLength });
  }
  if (file.bytes.byteLength === 0) throw new EngineError(400, "MISSING_FILE", "The file is empty.");
  const sniffed = sniffMime(file.bytes, file.name);
  if (!sniffed) throw engineError("INVALID_FILE_TYPE", "This kind of file cannot be uploaded.");
  const fileNameId = `${uuidv7()}${sniffed.ext}`;
  const dir = uploadsDir(ctx, projectId);
  await mkdir(dir, { recursive: true });
  const abs = path.join(dir, fileNameId);
  await writeFile(abs, file.bytes, { mode: 0o644, flag: "wx" });
  await ctx.store.insertUpload({
    projectId,
    fileNameId,
    originalName: (file.name || "file").slice(0, 255),
    mime: sniffed.mime,
    size: file.bytes.byteLength,
    path: path.relative(ctx.config.DATA_DIR, abs),
    sha256: createHash("sha256").update(file.bytes).digest("hex"),
  });
  return { url: publicFileUrl(ctx, projectId, `uploads/${fileNameId}`, UPLOAD_URL_TTL_SECONDS), fileNameId };
}
