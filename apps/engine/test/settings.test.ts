/**
 * Instance settings (contract C4) and the image-mode override.
 * Protects: the env default comes from IMAGES_FROM_WEB_SEARCH, the UI override wins until
 * DELETE, bodies are validated, the routes need the engine api-key, an invalid stored
 * value is ignored, and `ctx.imageSourcing` sees the same override the routes write.
 */
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ImageStrategySettingSchema } from "@forja/contracts/media";
import { parseConfig } from "../src/config.js";
import { SettingsService, SETTING_KEYS } from "../src/services/settings.js";
import { MemoryStore } from "../src/store/memory.js";
import { makeTestEngine } from "./fakes.js";

describe("IMAGES_FROM_WEB_SEARCH", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["true", true],
    ["1", true],
    ["YES", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["no", false],
    ["off", false],
  ])("%j → %s", (raw, expected) => {
    const r = parseConfig(raw === undefined ? {} : { IMAGES_FROM_WEB_SEARCH: raw });
    expect(r.ok && r.config.IMAGES_FROM_WEB_SEARCH).toBe(expected);
  });

  it("rejects anything else with a readable problem", () => {
    const r = parseConfig({ IMAGES_FROM_WEB_SEARCH: "maybe" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems[0]).toMatchObject({ variable: "IMAGES_FROM_WEB_SEARCH", problem: "must be true or false" });
  });
});

describe("SettingsService", () => {
  it("stores, reads and clears the image mode", async () => {
    const store = new MemoryStore();
    const s = new SettingsService(store, pino({ level: "silent" }));
    expect(await s.storedImageMode()).toBeNull();
    await s.setImageMode("web-search");
    expect(await s.storedImageMode()).toBe("web-search");
    expect(await store.getSetting(SETTING_KEYS.imagesMode)).toBe("web-search");
    expect(await s.clearImageMode()).toBe(true);
    expect(await s.clearImageMode()).toBe(false);
    expect(await s.storedImageMode()).toBeNull();
  });

  it("ignores an invalid stored value and warns", async () => {
    const store = new MemoryStore();
    const warnings: unknown[] = [];
    const s = new SettingsService(store, { warn: (o: unknown) => void warnings.push(o) } as never);
    await store.putSetting(SETTING_KEYS.imagesMode, { mode: "dalle" });
    expect(await s.storedImageMode()).toBeNull();
    expect(warnings).toHaveLength(1);
  });

  it("refuses to store an invalid mode", async () => {
    const s = new SettingsService(new MemoryStore(), pino({ level: "silent" }));
    await expect(s.setImageMode("dalle" as never)).rejects.toThrow();
  });
});

describe("/v2/system/settings", () => {
  it("GET reports the env default; PUT overrides; DELETE resets", async () => {
    const e = makeTestEngine({ env: { IMAGES_FROM_WEB_SEARCH: "true" } });

    const initial = await e.json("GET", "/v2/system/settings");
    expect(initial.status).toBe(200);
    expect(ImageStrategySettingSchema.parse(initial.body.images)).toEqual({
      mode: "web-search", source: "env", envDefault: "web-search", generationAvailable: false,
    });

    const put = await e.json("PUT", "/v2/system/settings", { images: { mode: "generate" } });
    expect(put.status).toBe(200);
    expect(put.body.images).toEqual({ mode: "generate", source: "ui", envDefault: "web-search", generationAvailable: false });
    expect(await e.ctx.imageSourcing.setting()).toMatchObject({ mode: "generate", source: "ui" });
    expect((await e.json("GET", "/v2/system/settings")).body.images.source).toBe("ui");

    const del = await e.json("DELETE", "/v2/system/settings/images");
    expect(del.status).toBe(200);
    expect(del.body.images).toEqual({ mode: "web-search", source: "env", envDefault: "web-search", generationAvailable: false });
    // Idempotent.
    expect((await e.json("DELETE", "/v2/system/settings/images")).status).toBe(200);
  });

  it("defaults to generate when the variable is unset", async () => {
    const e = makeTestEngine();
    expect((await e.json("GET", "/v2/system/settings")).body.images).toMatchObject({ mode: "generate", envDefault: "generate" });
  });

  it.each([
    [{ images: { mode: "dalle" } }],
    [{ images: {} }],
    [{ images: { mode: "web-search", extra: 1 } }],
    [{ other: true }],
    ["web-search"],
  ])("PUT %j → 400 VALIDATION", async (body) => {
    const e = makeTestEngine();
    const res = await e.json("PUT", "/v2/system/settings", body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    expect(await e.ctx.settings.storedImageMode()).toBeNull();
  });

  it("PUT with a non-JSON body → 400", async () => {
    const e = makeTestEngine();
    const res = await e.call("PUT", "/v2/system/settings", undefined, { "content-type": "application/json" });
    expect(res.status).toBe(400);
  });

  it("requires the engine api-key", async () => {
    const e = makeTestEngine();
    for (const [method, path] of [["GET", "/v2/system/settings"], ["PUT", "/v2/system/settings"], ["DELETE", "/v2/system/settings/images"]] as const) {
      const res = await e.app.request(path, { method });
      expect(res.status).toBe(401);
    }
  });
});
