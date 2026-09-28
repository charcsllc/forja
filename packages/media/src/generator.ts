/**
 * The image-generation seam (IMAGE_* providers).
 *
 * Protects: callers (`createImageSourcing`, the engine, the agent runtime) never change
 * when a generator adapter is added. No adapter exists yet, so `generationAvailable` is
 * false and mode `generate` falls back to web search. An adapter implements this
 * interface, reads its key from `@forja/llm`'s env report, and is passed in
 * `createImageSourcing({ generators })`; its cost is recorded through `onCall`.
 */
import type { AbortSignalLike, ImageOrientation } from "@forja/contracts/media";

export interface ImageGenerationRequest {
  /** English description of the subject (the `image_find` query). */
  prompt: string;
  orientation?: ImageOrientation;
  minWidth: number;
  signal: AbortSignalLike;
}

export interface GeneratedImage {
  /** Encoded image (JPEG, PNG, WebP or AVIF); re-sniffed before it is written. */
  bytes: Uint8Array;
  model: string;
  costUsd: number;
}

export interface ImageGenerator {
  /** IMAGE_* provider id, e.g. `openai`, `fal`. */
  readonly id: string;
  /** True when its IMAGE_* provider is enabled and configured. */
  available(): boolean;
  generate(req: ImageGenerationRequest): Promise<GeneratedImage>;
}
