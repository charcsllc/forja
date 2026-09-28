/**
 * The search-provider seam.
 *
 * Protects: every provider (keyless Openverse and Wikimedia Commons, keyed STOCK_*
 * services) turns its own answer into the same `ImageCandidate`, with the license and
 * attribution already normalised to `ImageAttribution`. Only candidates whose license
 * allows commercial use and modification ever leave a provider; the ranking and the
 * downloader never see anything else.
 */
import type { AbortSignalLike, ImageAttribution, ImageOrientation } from "@forja/contracts/media";

export interface ImageCandidate {
  provider: string;
  /** Provider-local id, for logs and deterministic tie-breaks. */
  id: string;
  /** Where the bytes are fetched from (goes through the SSRF-guarded downloader). */
  downloadUrl: string;
  /** Dimensions the provider says `downloadUrl` serves (ranking only; the file is re-measured). */
  width: number;
  height: number;
  /** Title, tags and description, for relevance scoring. */
  text: string;
  attribution: ImageAttribution;
  /** Position in the provider's own answer (0 = its best match). */
  rank: number;
  /** Side effect some licenses require once the image is actually used (Unsplash download tracking). */
  onChosen?: (signal: AbortSignalLike) => Promise<void>;
}

export interface SearchQuery {
  query: string;
  orientation?: ImageOrientation;
  minWidth: number;
  /** Width worth asking for when the provider can resize server-side. */
  targetWidth: number;
  signal: AbortSignalLike;
}

export type SearchOutcome =
  | { ok: true; candidates: ImageCandidate[] }
  /** `skipped`: the local gate was closed, so no request was made (nothing to record). */
  | { ok: false; reason: string; rateLimited: boolean; skipped?: boolean };

export interface SearchProvider {
  readonly id: string;
  search(q: SearchQuery): Promise<SearchOutcome>;
}
