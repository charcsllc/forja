/**
 * `createImageSourcing`: the `ImageSourcingPort` the engine injects into the agent
 * runtime (tool `image_find`, docs/architecture/11).
 *
 * Protects:
 * - **The strategy is decided here, never by the model.** `web-search` (env
 *   `IMAGES_FROM_WEB_SEARCH=true` or the UI override) never touches a generator. `generate`
 *   uses a runnable generator when one exists and otherwise falls back to web search,
 *   logging why; the result's `mode` says which path produced the file.
 * - Providers are asked in order (enabled STOCK_* first, then Openverse, then Wikimedia)
 *   and the search stops at the first provider that yields a good, downloadable image, so
 *   free quotas are spent one request at a time. Answers are cached per query for an hour.
 * - Every file goes through the SSRF-guarded downloader and the magic-byte sniffer, is
 *   written as `public/images/<slot>.<ext>`, and its credit replaces the slot's entry in
 *   `public/images/credits.json` (updates are serialised per project).
 * - Every provider request is reported through `onCall` (for `media_calls`), with cost 0
 *   for search. `onCall` failures are logged, never thrown into the agent's turn.
 */
import {
  ImageFindRequestSchema,
  type ImageAttribution,
  type ImageFindRequest,
  type ImageFindResult,
  type ImageSourceMode,
  type ImageSourcingContext,
  type ImageSourcingPort,
  type ImageStrategySetting,
} from "@forja/contracts/media";
import { parseProviderEnv } from "@forja/llm/env";
import { CREDITS_PATH, IMAGES_DIR, mergeCredits, parseCredits, serializeCredits } from "./credits.js";
import { downloadImage } from "./download.js";
import { ImageSourcingError } from "./errors.js";
import type { ImageGenerator } from "./generator.js";
import { silentLogger, type FetchFn, type MediaLogger } from "./http.js";
import { buildSearchProviders, type ImageCandidate, type SearchProvider } from "./providers/index.js";
import { rankCandidates } from "./rank.js";
import type { LookupFn } from "./safe-url.js";
import { sniffImage, type SniffedImage } from "./sniff.js";
import { envImageMode, resolveImageStrategy } from "./strategy.js";

/** Default minimum width when the slot does not say (Openverse's Flickr files are 1024 wide). */
export const DEFAULT_MIN_WIDTH = 1000;
const MAX_DOWNLOADS_PER_PROVIDER = 3;
const MAX_DOWNLOADS_TOTAL = 8;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;

/** Where the UI override lives (the engine's settings service implements it). */
export interface ImageModeStore {
  /** The mode stored by the UI, or null when none is stored (the env default applies). */
  storedImageMode(): Promise<ImageSourceMode | null>;
}

/** One provider request, shaped for the engine's `media_calls` table. */
export interface MediaCallRecord {
  projectId: string;
  runId: string;
  provider: string;
  kind: "search" | "generate";
  query: string;
  model?: string;
  units: number;
  costUsd: number;
  latencyMs: number;
  outcome: "ok" | "empty" | "rate_limited" | "error";
  error?: string;
}

export interface CreateImageSourcingOptions {
  /** `IMAGES_FROM_WEB_SEARCH` plus the `STOCK_*` / `IMAGE_*` variables (usually process.env). */
  env: Record<string, string | undefined>;
  settings?: ImageModeStore;
  fetch?: FetchFn;
  logger?: MediaLogger;
  onCall?: (call: MediaCallRecord) => void | Promise<void>;
  /** DNS resolver for the SSRF guard (tests inject one). */
  lookup?: LookupFn;
  now?: () => number;
  /** IMAGE_* adapters; none exist yet. */
  generators?: ImageGenerator[];
  /** Replaces the env-derived provider list (tests). */
  providers?: SearchProvider[];
}

export interface ImageSourcing extends ImageSourcingPort {
  /** Search providers in the order they are asked, e.g. `["pexels", "openverse", "wikimedia"]`. */
  readonly searchProviders: readonly string[];
}

interface WrittenImage {
  image: SniffedImage;
  bytes: Uint8Array;
}

export function createImageSourcing(opts: CreateImageSourcingOptions): ImageSourcing {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const logger = opts.logger ?? silentLogger;
  const providers = opts.providers ?? buildSearchProviders(opts.env, { fetch: fetchFn, now });
  const generators = opts.generators ?? [];
  const envDefault = envImageMode(opts.env);
  const cache = new Map<string, { at: number; candidates: ImageCandidate[] }>();
  const creditLocks = new Map<string, Promise<unknown>>();
  const creditsInMemory = new Map<string, unknown[]>();

  const enabledImageProviders = parseProviderEnv(opts.env)
    .providers.filter((p) => p.kind === "image" && p.status === "enabled")
    .map((p) => p.id);
  const unimplemented = enabledImageProviders.filter((id) => !generators.some((g) => g.id === id));
  if (unimplemented.length > 0) {
    logger.warn({ providers: unimplemented }, "IMAGE_* provider enabled but no generator adapter exists yet; images come from web search");
  }

  const generationAvailable = () => generators.some((g) => g.available());

  async function record(call: MediaCallRecord): Promise<void> {
    if (!opts.onCall) return;
    try {
      await opts.onCall(call);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), provider: call.provider }, "media call could not be recorded");
    }
  }

  async function setting(): Promise<ImageStrategySetting> {
    let override: ImageSourceMode | null = null;
    try {
      override = (await opts.settings?.storedImageMode()) ?? null;
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "image mode setting unreadable; using the env default");
    }
    return resolveImageStrategy({ envDefault, override, generationAvailable: generationAvailable() });
  }

  async function search(provider: SearchProvider, req: ImageFindRequest, ctx: ImageSourcingContext, minWidth: number, targetWidth: number) {
    const key = JSON.stringify([provider.id, req.query.toLowerCase(), req.orientation ?? "", targetWidth]);
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return { ok: true as const, candidates: hit.candidates, cached: true };
    const started = now();
    const res = await provider.search({ query: req.query, orientation: req.orientation, minWidth, targetWidth, signal: ctx.abortSignal });
    if (!(res.ok === false && res.skipped)) {
      await record({
        projectId: ctx.projectId,
        runId: ctx.runId,
        provider: provider.id,
        kind: "search",
        query: req.query,
        units: 1,
        costUsd: 0,
        latencyMs: Math.max(0, now() - started),
        outcome: res.ok ? (res.candidates.length > 0 ? "ok" : "empty") : res.rateLimited ? "rate_limited" : "error",
        ...(res.ok ? {} : { error: res.reason }),
      });
    }
    if (res.ok) {
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: now(), candidates: res.candidates });
    }
    return { ...res, cached: false };
  }

  async function updateCredits(ctx: ImageSourcingContext, entry: { slot: string; path: string; alt: string; attribution: ImageAttribution }) {
    const previous = creditLocks.get(ctx.projectId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const existing = ctx.readFile ? parseCredits(await ctx.readFile(CREDITS_PATH)) : (creditsInMemory.get(ctx.projectId) ?? []);
      const merged = mergeCredits(existing, entry);
      await ctx.writeFile(CREDITS_PATH, serializeCredits(merged));
      creditsInMemory.set(ctx.projectId, merged);
    });
    creditLocks.set(ctx.projectId, next);
    try {
      await next;
    } finally {
      if (creditLocks.get(ctx.projectId) === next) creditLocks.delete(ctx.projectId);
    }
  }

  async function finish(
    req: ImageFindRequest,
    ctx: ImageSourcingContext,
    written: WrittenImage,
    mode: ImageSourceMode,
    attribution: ImageAttribution,
  ): Promise<ImageFindResult> {
    const path = `${IMAGES_DIR}/${req.slot}.${written.image.extension}`;
    const publicUrl = `/${path.slice("public/".length)}`;
    await ctx.writeFile(path, written.bytes);
    await updateCredits(ctx, { slot: req.slot, path: publicUrl, alt: req.alt, attribution });
    return {
      path,
      publicUrl,
      width: written.image.width,
      height: written.image.height,
      mediaType: written.image.mediaType,
      alt: req.alt,
      mode,
      attribution,
    };
  }

  async function tryGenerate(req: ImageFindRequest, ctx: ImageSourcingContext, minWidth: number, attempts: string[]): Promise<ImageFindResult | null> {
    for (const g of generators.filter((x) => x.available())) {
      const started = now();
      try {
        const out = await g.generate({ prompt: req.query, orientation: req.orientation, minWidth, signal: ctx.abortSignal });
        const image = sniffImage(out.bytes);
        await record({
          projectId: ctx.projectId,
          runId: ctx.runId,
          provider: g.id,
          kind: "generate",
          query: req.query,
          model: out.model,
          units: 1,
          costUsd: out.costUsd,
          latencyMs: Math.max(0, now() - started),
          outcome: image ? "ok" : "error",
          ...(image ? {} : { error: "generator returned an unsupported file" }),
        });
        if (!image) {
          attempts.push(`${g.id}: unsupported file`);
          continue;
        }
        return await finish(req, ctx, { image, bytes: out.bytes }, "generate", {
          provider: g.id,
          license: "generated",
          attributionRequired: false,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        attempts.push(`${g.id}: ${reason}`);
        await record({
          projectId: ctx.projectId, runId: ctx.runId, provider: g.id, kind: "generate", query: req.query,
          units: 1, costUsd: 0, latencyMs: Math.max(0, now() - started), outcome: "error", error: reason,
        });
        if (ctx.abortSignal.aborted) throw new ImageSourcingError("aborted", "Image sourcing was cancelled", attempts);
      }
    }
    return null;
  }

  async function find(input: ImageFindRequest, ctx: ImageSourcingContext): Promise<ImageFindResult> {
    const parsed = ImageFindRequestSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ImageSourcingError("invalid_request", `Invalid image request${issue ? ` at ${issue.path.join(".") || "(root)"}: ${issue.message}` : ""}`);
    }
    const req = parsed.data;
    const attempts: string[] = [];
    const checkAbort = () => {
      if (ctx.abortSignal.aborted) throw new ImageSourcingError("aborted", "Image sourcing was cancelled", attempts);
    };
    checkAbort();

    const minWidth = req.minWidth ?? DEFAULT_MIN_WIDTH;
    const targetWidth = Math.min(Math.max(minWidth, 1600), 3840);
    const strategy = await setting();

    if (strategy.mode === "generate") {
      if (strategy.generationAvailable) {
        const generated = await tryGenerate(req, ctx, minWidth, attempts);
        if (generated) return generated;
        logger.info({ slot: req.slot, attempts }, "image generation failed; searching the web instead");
      } else {
        logger.info(
          { slot: req.slot, reason: enabledImageProviders.length ? "no generator adapter implemented" : "no IMAGE_* provider enabled" },
          "image mode is generate but no generator can run; searching the web instead",
        );
      }
    }

    const tried = new Set<string>();
    const leftovers: ImageCandidate[] = [];
    let downloads = 0;

    const attempt = async (c: ImageCandidate): Promise<ImageFindResult | null> => {
      if (tried.has(c.downloadUrl) || downloads >= MAX_DOWNLOADS_TOTAL) return null;
      tried.add(c.downloadUrl);
      downloads++;
      const got = await downloadImage(c.downloadUrl, { fetch: fetchFn, lookup: opts.lookup, signal: ctx.abortSignal });
      checkAbort();
      if (!got.ok) {
        attempts.push(`${c.provider}/${c.id}: ${got.reason}`);
        return null;
      }
      if (c.onChosen) {
        await c.onChosen(ctx.abortSignal).catch((err: unknown) =>
          logger.warn({ provider: c.provider, err: err instanceof Error ? err.message : String(err) }, "provider download tracking failed"),
        );
      }
      return finish(req, ctx, { image: got.image, bytes: got.bytes }, "web-search", c.attribution);
    };

    for (const provider of providers) {
      checkAbort();
      const res = await search(provider, req, ctx, minWidth, targetWidth);
      checkAbort();
      if (!res.ok) {
        attempts.push(`${provider.id}: ${res.reason}`);
        continue;
      }
      const ranked = rankCandidates(res.candidates, req.query, { orientation: req.orientation, minWidth });
      if (ranked.length === 0) attempts.push(`${provider.id}: no usable results`);
      let perProvider = 0;
      for (const s of ranked) {
        if (!s.good) {
          leftovers.push(s.candidate);
          continue;
        }
        if (perProvider >= MAX_DOWNLOADS_PER_PROVIDER) {
          leftovers.push(s.candidate);
          continue;
        }
        perProvider++;
        const done = await attempt(s.candidate);
        if (done) return done;
      }
      if (perProvider === 0 && ranked.length > 0) attempts.push(`${provider.id}: no result met orientation, width and relevance`);
    }

    // Nothing good anywhere: the best of what is left, across providers, beats no image.
    for (const s of rankCandidates(leftovers, req.query, { orientation: req.orientation, minWidth })) {
      if (downloads >= MAX_DOWNLOADS_TOTAL) break;
      const done = await attempt(s.candidate);
      if (done) return done;
    }

    throw new ImageSourcingError("not_found", `No usable openly licensed image found for "${req.query}"`, attempts);
  }

  return {
    searchProviders: providers.map((p) => p.id),
    setting,
    find,
  };
}
