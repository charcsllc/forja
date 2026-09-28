/**
 * Instance-wide settings the UI can change (table `settings`, key/value JSON).
 *
 * Protects:
 * - One key per setting, validated on write **and on read**: a row written by an older
 *   engine or by hand that does not parse is ignored (logged), never trusted, so the env
 *   default applies instead of a garbage value.
 * - `images.mode` is the UI override of `IMAGES_FROM_WEB_SEARCH` (02 §7). Absent row =
 *   the env default; `clearImageMode` is "reset to .env". What the mode resolves to
 *   (source, env default, whether generation can run) is computed by `@forja/media`
 *   (`ImageSourcingPort.setting()`), which reads the override through `storedImageMode`.
 * Works on both store backends (Postgres and memory) through the `Store` port.
 */
import { ImageSourceModeSchema, type ImageSourceMode } from "@forja/contracts/media";
import type { ImageModeStore } from "@forja/media";
import type { Logger } from "../logger.js";
import type { Store } from "../store/types.js";

export const SETTING_KEYS = { imagesMode: "images.mode" } as const;

export class SettingsService implements ImageModeStore {
  constructor(
    private readonly store: Store,
    private readonly logger: Pick<Logger, "warn">,
  ) {}

  /** The UI override of the image mode, or null (the env default applies). */
  async storedImageMode(): Promise<ImageSourceMode | null> {
    const raw = await this.store.getSetting(SETTING_KEYS.imagesMode);
    if (raw === null) return null;
    const parsed = ImageSourceModeSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.logger.warn({ key: SETTING_KEYS.imagesMode }, "ignoring an invalid stored setting");
    return null;
  }

  async setImageMode(mode: ImageSourceMode): Promise<void> {
    await this.store.putSetting(SETTING_KEYS.imagesMode, ImageSourceModeSchema.parse(mode));
  }

  /** Back to `IMAGES_FROM_WEB_SEARCH`. Returns whether an override existed. */
  async clearImageMode(): Promise<boolean> {
    return this.store.deleteSetting(SETTING_KEYS.imagesMode);
  }
}
