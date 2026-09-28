/**
 * Catalog invariants. Protects: every provider id has a definition, every model is
 * verified, NVIDIA lists only ids NIM actually serves, pending adapters are flagged, and
 * prompt notes are assembled in the documented order.
 */
import { describe, expect, it } from "vitest";
import { CATALOG, modelsWithExtras, outputPricePer1M, peakPrice, promptNotesFor, promptTieredPrice } from "../src/catalog/index.js";
import { LLM_PROVIDER_IDS } from "../src/env.js";
import { fixtureJson } from "./helpers.js";

describe("catalog", () => {
  it("covers every LLM provider id", () => {
    expect(Object.keys(CATALOG).sort()).toEqual([...LLM_PROVIDER_IDS].sort());
    for (const id of LLM_PROVIDER_IDS) expect(CATALOG[id].id).toBe(id);
  });

  it("every model is verified and sane", () => {
    for (const p of Object.values(CATALOG)) {
      expect(p.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.verifiedFrom).not.toBe("");
      for (const m of p.models) {
        expect(m.verifiedAt, `${p.id}:${m.id}`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(m.verifiedFrom, `${p.id}:${m.id}`).not.toBe("");
        expect(m.contextTokens).toBeGreaterThan(m.maxOutputTokens);
        expect(outputPricePer1M(m.price, new Date())).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("marks the providers whose adapter is pending", () => {
    const pending = Object.values(CATALOG).filter((p) => !p.adapterReady).map((p) => p.id).sort();
    expect(pending).toEqual(["anthropic", "google", "openai", "xai"]);
    for (const p of Object.values(CATALOG)) if (p.adapterReady) expect(p.adapter).toBe("openai-compatible");
  });

  it("NVIDIA lists only ids served by NIM, free, with native tools where captured", () => {
    const served = new Set(fixtureJson<{ data: Array<{ id: string }> }>("models.json").data.map((m) => m.id));
    const nvidia = CATALOG.nvidia;
    expect(nvidia.models.map((m) => m.id)).toEqual([
      "z-ai/glm-5.3",
      "z-ai/glm-5.3-flash",
      "moonshotai/kimi-k3",
      "moonshotai/kimi-k2.6",
      "deepseek-ai/deepseek-v4.1-flash",
      "openai/gpt-oss-20b",
      "nvidia/nemotron-3-super-120b-a12b",
      "meta/llama-3.2-90b-vision-instruct",
    ]);
    for (const m of nvidia.models) {
      expect(served.has(m.id), m.id).toBe(true);
      expect(outputPricePer1M(m.price, new Date())).toBe(0);
      expect(m.capabilities.vision).toBe(m.id.includes("vision"));
    }
    expect(nvidia.models.filter((m) => m.capabilities.nativeTools).map((m) => m.id)).toEqual(["z-ai/glm-5.3", "z-ai/glm-5.3-flash"]);
    expect(nvidia.limits).toMatchObject({ rpm: 40, firstByteTimeoutMs: 300_000 });
    expect(nvidia.local).toBe(false);
  });

  it("merges LLM_<P>_EXTRA_MODELS: new ids get conservative defaults, known ids are overridden", () => {
    const models = modelsWithExtras(CATALOG.nvidia, [
      { id: "moonshotai/kimi-k3", contextTokens: 262_144, maxOutputTokens: 16_000, nativeTools: true },
      { id: "qwen/qwen3-coder", contextTokens: 128_000, maxOutputTokens: 8_000 },
    ]);
    expect(models.find((m) => m.id === "moonshotai/kimi-k3")).toMatchObject({ contextTokens: 262_144, capabilities: { nativeTools: true, vision: false } });
    expect(models.at(-1)).toMatchObject({ id: "qwen/qwen3-coder", tier: "strong", capabilities: { nativeTools: false, vision: false }, verifiedFrom: "LLM_NVIDIA_EXTRA_MODELS" });
    expect(CATALOG.nvidia.models.find((m) => m.id === "moonshotai/kimi-k3")!.capabilities.nativeTools).toBe(false);
    expect(modelsWithExtras(CATALOG.ollama, [{ id: "qwen3:32b", contextTokens: 32_768, maxOutputTokens: 8_192 }])[0]!.tier).toBe("local");
  });

  it("assembles prompt notes: provider note, then family note for aggregators", () => {
    const glm = CATALOG.nvidia.models[0];
    expect(promptNotesFor("nvidia", glm)).toEqual(["nvidia", "zai"]);
    expect(promptNotesFor("nvidia", CATALOG.nvidia.models.find((m) => m.family === "nemotron"))).toEqual(["nvidia"]);
    expect(promptNotesFor("zai", CATALOG.zai.models[0])).toEqual(["zai"]);
    expect(promptNotesFor("nope", glm)).toEqual([]);
  });

  it("prices tiers and peak hours", () => {
    const tiered = promptTieredPrice(100, { input: 1, output: 2 }, { input: 10, output: 20 });
    expect(tiered({ input: 50, output: 1_000_000, cachedInput: 0, cacheWrite: 0 }, new Date())).toBeCloseTo(2.00005);
    expect(tiered({ input: 101, output: 0, cachedInput: 0, cacheWrite: 0 }, new Date())).toBeCloseTo(0.00101);
    const peak = peakPrice({ hoursUtc: [[1, 4]], weekdaysOnly: true }, { input: 0, output: 2 }, { input: 0, output: 1 });
    const out = { input: 0, output: 1_000_000, cachedInput: 0, cacheWrite: 0 };
    expect(peak(out, new Date(Date.UTC(2026, 8, 28, 2)))).toBe(2); // Monday 02:00
    expect(peak(out, new Date(Date.UTC(2026, 8, 28, 5)))).toBe(1);
    expect(peak(out, new Date(Date.UTC(2026, 8, 27, 2)))).toBe(1); // Sunday
  });
});
