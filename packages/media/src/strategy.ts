/**
 * The image strategy setting: env default, UI override, and what can actually run.
 *
 * Protects the rule the operator asked for: `IMAGES_FROM_WEB_SEARCH=true` means **never**
 * call an image-generation model; search the web instead. The UI can override the env
 * value (stored by the engine, key `images.mode`) and wins until it is reset. Mode
 * `generate` with no runnable generator is reported honestly (`generationAvailable:
 * false`) and falls back to web search; it is never an error.
 */
import type { ImageSourceMode, ImageStrategySetting } from "@forja/contracts/media";

const TRUTHY = new Set(["true", "1", "yes", "on"]);

/** `IMAGES_FROM_WEB_SEARCH` → the env default mode. Absent, empty or falsy → `generate`. */
export function envImageMode(env: Record<string, string | undefined>): ImageSourceMode {
  const raw = (env.IMAGES_FROM_WEB_SEARCH ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
  return TRUTHY.has(raw) ? "web-search" : "generate";
}

export function resolveImageStrategy(input: {
  envDefault: ImageSourceMode;
  override: ImageSourceMode | null;
  generationAvailable: boolean;
}): ImageStrategySetting {
  return {
    mode: input.override ?? input.envDefault,
    source: input.override ? "ui" : "env",
    envDefault: input.envDefault,
    generationAvailable: input.generationAvailable,
  };
}
