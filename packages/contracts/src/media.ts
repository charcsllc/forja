/**
 * Image sourcing: the port between the agent runtime (tool `image_find`) and
 * `packages/media`, plus the instance setting that picks the strategy.
 *
 * Protects: the agent never knows whether an image was generated or found on the web.
 * It asks for a slot (what the image is for) and gets back a file inside the project and
 * the attribution the app must show. Which path is taken is decided by
 * `ImageStrategySetting` (env `IMAGES_FROM_WEB_SEARCH`, overridable from the UI), never
 * by the model.
 */
import { z } from "zod";

// ─── Setting ───────────────────────────────────────────────────────────────

/**
 * `web-search`: never call an image-generation model; search the web (openly licensed
 * sources first, then any enabled STOCK_* provider).
 * `generate`: use an enabled IMAGE_* generator; fall back to web search when none can run.
 */
export const ImageSourceModeSchema = z.enum(["web-search", "generate"]);
export type ImageSourceMode = z.infer<typeof ImageSourceModeSchema>;

/** `GET/PUT /v2/system/settings` → `images`. */
export const ImageStrategySettingSchema = z.object({
  /** The mode in force. */
  mode: ImageSourceModeSchema,
  /** Where `mode` comes from: the UI override stored in the engine, or the env default. */
  source: z.enum(["ui", "env"]),
  /** The value `IMAGES_FROM_WEB_SEARCH` gives, so the UI can offer "reset to .env". */
  envDefault: ImageSourceModeSchema,
  /** Whether an IMAGE_* generator is enabled and implemented; false forces web search. */
  generationAvailable: z.boolean(),
});
export type ImageStrategySetting = z.infer<typeof ImageStrategySettingSchema>;

// ─── Port ──────────────────────────────────────────────────────────────────

export const ImageOrientationSchema = z.enum(["landscape", "portrait", "square"]);
export type ImageOrientation = z.infer<typeof ImageOrientationSchema>;

export const ImageFindRequestSchema = z.object({
  /** Stable slot name, becomes the file name: `hero`, `team-1`, `product-candle`. */
  slot: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  /** English search/generation query describing the subject. */
  query: z.string().min(2).max(200),
  /** Alt text the page will use (in the app's language). */
  alt: z.string().min(1).max(300),
  orientation: ImageOrientationSchema.optional(),
  minWidth: z.number().int().positive().max(4096).optional(),
});
export type ImageFindRequest = z.infer<typeof ImageFindRequestSchema>;

export const ImageAttributionSchema = z.object({
  /** `openverse`, `wikimedia`, `pexels`, `pixabay`, `unsplash`, or a generator id. */
  provider: z.string(),
  title: z.string().optional(),
  author: z.string().optional(),
  authorUrl: z.string().url().optional(),
  /** Page of the original work (not the file URL). */
  pageUrl: z.string().url().optional(),
  /** e.g. `CC BY 4.0`, `CC0`, `Pexels License`, `generated`. */
  license: z.string(),
  licenseUrl: z.string().url().optional(),
  /** Whether the license requires visible credit. */
  attributionRequired: z.boolean(),
});
export type ImageAttribution = z.infer<typeof ImageAttributionSchema>;

export const ImageFindResultSchema = z.object({
  /** Project-relative POSIX path of the written file, e.g. `public/images/hero.jpg`. */
  path: z.string(),
  /** URL the app uses, e.g. `/images/hero.jpg`. */
  publicUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mediaType: z.string(),
  alt: z.string(),
  mode: ImageSourceModeSchema,
  attribution: ImageAttributionSchema,
});
export type ImageFindResult = z.infer<typeof ImageFindResultSchema>;

/** Structural subset of `AbortSignal`: this package compiles without DOM or Node types. */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface ImageSourcingContext {
  projectId: string;
  runId: string;
  /** Writes into the run checkout; path is project-relative POSIX. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /**
   * Reads a file of the run checkout (null when absent). Optional: `packages/media` uses it
   * to merge `public/images/credits.json` with entries from earlier runs; without it, it
   * merges only with what this process wrote for the project.
   */
  readFile?(path: string): Promise<Uint8Array | null>;
  abortSignal: AbortSignalLike;
}

/** Implemented by `packages/media`, injected into the agent runtime by the engine. */
export interface ImageSourcingPort {
  setting(): Promise<ImageStrategySetting>;
  find(req: ImageFindRequest, ctx: ImageSourcingContext): Promise<ImageFindResult>;
}
