/**
 * @forja/media public surface: image sourcing for generated apps.
 * What this protects: the engine and the agent runtime depend on `ImageSourcingPort`
 * (from @forja/contracts/media) and `createImageSourcing`; provider adapters, the SSRF
 * guard and the sniffer stay internal details that can change without touching callers.
 */
export { createImageSourcing, DEFAULT_MIN_WIDTH } from "./sourcing.js";
export type { CreateImageSourcingOptions, ImageModeStore, ImageSourcing, MediaCallRecord } from "./sourcing.js";
export { envImageMode, resolveImageStrategy } from "./strategy.js";
export type { GeneratedImage, ImageGenerationRequest, ImageGenerator } from "./generator.js";
export { ImageSourcingError, type ImageSourcingErrorCode } from "./errors.js";
export { CREDITS_PATH, IMAGES_DIR, type CreditEntry } from "./credits.js";
export { downloadImage, MAX_IMAGE_BYTES, MAX_REDIRECTS, type DownloadResult } from "./download.js";
export { sniffImage, type ImageKind, type SniffedImage } from "./sniff.js";
export { isPrivateAddress, publicUrlRejectionReason, urlRejectionReason, type LookupFn } from "./safe-url.js";
export { USER_AGENT, type MediaLogger } from "./http.js";
export type { ImageCandidate, SearchProvider, SearchQuery, SearchOutcome } from "./providers/index.js";
