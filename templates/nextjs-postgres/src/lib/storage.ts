/**
 * File storage port with two adapters, chosen from the environment:
 *
 * - S3-compatible (AWS S3, Cloudflare R2, MinIO…) when `S3_BUCKET` is set.
 * - Local disk otherwise, under `STORAGE_DIR` (default `/data/uploads` in production, where
 *   the container mounts a volume, and `.data/uploads` in development).
 *
 * Database file fields (`*_file` / `*_image` jsonb columns) store `{ name, url? }`; resolve a
 * public URL with `fileUrl(value)`. Files are served by `/api/files/<name>` unless
 * `S3_PUBLIC_URL` points at a public bucket or CDN.
 */
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AwsClient } from "aws4fetch";
import { env } from "@/env";
import { defaultRandom, type FileRef } from "@/db/schema/columns";

export type StoredFile = { body: ReadableStream<Uint8Array>; contentType: string; size?: number };

export interface Storage {
  put(name: string, body: Uint8Array, options?: { contentType?: string }): Promise<FileRef>;
  get(name: string): Promise<StoredFile | null>;
  delete(name: string): Promise<void>;
  /** Public URL for a stored name. */
  url(name: string): string;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,254}$/;

/** Throws unless `name` is a relative, traversal-free object name. */
export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name) || name.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Invalid file name");
  }
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
};

export function contentTypeFor(name: string): string {
  return TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** A fresh, collision-free object name that keeps the original extension. */
export function newFileName(originalName: string, folder = "uploads"): string {
  const ext = path
    .extname(originalName)
    .toLowerCase()
    .replace(/[^a-z0-9.]/g, "")
    .slice(0, 10);
  return `${folder}/${defaultRandom()}${ext}`;
}

function servedUrl(name: string): string {
  return `/api/files/${name.split("/").map(encodeURIComponent).join("/")}`;
}

export function localStorageAdapter(root: string): Storage {
  const resolve = (name: string) => {
    assertSafeName(name);
    const full = path.resolve(root, name);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("Invalid file name");
    return full;
  };
  return {
    async put(name, body, options) {
      const full = resolve(name);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, body);
      if (options?.contentType) await writeFile(`${full}.type`, options.contentType);
      return { name };
    },
    async get(name) {
      const full = resolve(name);
      try {
        const info = await stat(full);
        if (!info.isFile()) return null;
        const declared = await readFile(`${full}.type`, "utf8").catch(() => null);
        const stream = createReadStream(full);
        return {
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              stream.on("data", (chunk) =>
                controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk)),
              );
              stream.on("end", () => controller.close());
              stream.on("error", (error) => controller.error(error));
            },
            cancel() {
              stream.destroy();
            },
          }),
          contentType: declared ?? contentTypeFor(name),
          size: info.size,
        };
      } catch {
        return null;
      }
    },
    async delete(name) {
      const full = resolve(name);
      await rm(full, { force: true });
      await rm(`${full}.type`, { force: true });
    },
    url: servedUrl,
  };
}

export function s3StorageAdapter(config: {
  bucket: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl?: string;
  forcePathStyle: boolean;
}): Storage {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: "s3",
  });
  const endpoint = new URL(config.endpoint ?? `https://s3.${config.region}.amazonaws.com`);
  const objectUrl = (name: string) => {
    assertSafeName(name);
    const key = name.split("/").map(encodeURIComponent).join("/");
    return config.forcePathStyle
      ? `${endpoint.origin}/${config.bucket}/${key}`
      : `${endpoint.protocol}//${config.bucket}.${endpoint.host}/${key}`;
  };
  const call = (url: string, init: RequestInit) => client.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });

  return {
    async put(name, body, options) {
      const response = await call(objectUrl(name), {
        method: "PUT",
        body,
        headers: { "content-type": options?.contentType ?? contentTypeFor(name) },
      });
      if (!response.ok) throw new Error(`Storage upload failed (${response.status})`);
      return { name };
    },
    async get(name) {
      const response = await call(objectUrl(name), { method: "GET" });
      if (response.status === 404) return null;
      if (!response.ok || !response.body) throw new Error(`Storage read failed (${response.status})`);
      const size = Number(response.headers.get("content-length") ?? "") || undefined;
      return { body: response.body, contentType: response.headers.get("content-type") ?? contentTypeFor(name), size };
    },
    async delete(name) {
      const response = await call(objectUrl(name), { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error(`Storage delete failed (${response.status})`);
    },
    url(name) {
      assertSafeName(name);
      return config.publicUrl ? `${config.publicUrl.replace(/\/$/, "")}/${name}` : servedUrl(name);
    },
  };
}

let instance: Storage | undefined;

export function getStorage(): Storage {
  if (instance) return instance;
  if (env.S3_BUCKET) {
    if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error("S3_BUCKET is set but S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are missing");
    }
    instance = s3StorageAdapter({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      publicUrl: env.S3_PUBLIC_URL,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  } else {
    const root =
      env.STORAGE_DIR ??
      (env.NODE_ENV === "production" ? "/data/uploads" : path.join(process.cwd(), ".data", "uploads"));
    instance = localStorageAdapter(root);
  }
  return instance;
}

/** Public URL of a file field value (`{ name, url? }`), or `null` when empty. */
export function fileUrl(value: FileRef | null | undefined): string | null {
  if (!value?.name) return null;
  return value.url ?? getStorage().url(value.name);
}
