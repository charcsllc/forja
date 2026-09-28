/**
 * Which search providers run, in which order.
 *
 * Protects the documented order (docs/architecture/02 §7): enabled STOCK_* providers
 * first (curated photography), then Openverse, then Wikimedia Commons. A STOCK_*
 * provider is used only when `@forja/llm`'s env report says `enabled` and hands out a
 * key; keyless providers are always available. Keys are read through the report's
 * non-enumerable accessor and captured by the adapter closure only.
 */
import { parseProviderEnv, type StockProviderId } from "@forja/llm/env";
import type { FetchFn } from "../http.js";
import { createOpenverseProvider } from "./openverse.js";
import { createPexelsProvider } from "./pexels.js";
import { createPixabayProvider } from "./pixabay.js";
import type { SearchProvider } from "./types.js";
import { createUnsplashProvider } from "./unsplash.js";
import { createWikimediaProvider } from "./wikimedia.js";

export const STOCK_ORDER: readonly StockProviderId[] = ["pexels", "unsplash", "pixabay"];

const STOCK_FACTORIES: Record<StockProviderId, (d: { fetch: FetchFn; now: () => number; apiKey: string }) => SearchProvider> = {
  pexels: createPexelsProvider,
  unsplash: createUnsplashProvider,
  pixabay: createPixabayProvider,
};

export function buildSearchProviders(env: Record<string, string | undefined>, deps: { fetch: FetchFn; now: () => number }): SearchProvider[] {
  const report = parseProviderEnv(env);
  const out: SearchProvider[] = [];
  for (const id of STOCK_ORDER) {
    const entry = report.providers.find((p) => p.kind === "stock" && p.id === id);
    const apiKey = report.getApiKey(id, "stock");
    if (entry?.status === "enabled" && apiKey) out.push(STOCK_FACTORIES[id]({ ...deps, apiKey }));
  }
  out.push(createOpenverseProvider(deps), createWikimediaProvider(deps));
  return out;
}

export type { ImageCandidate, SearchOutcome, SearchProvider, SearchQuery } from "./types.js";
