/**
 * Ranking without vision. Protects: orientation and width beat relevance ties,
 * relevance decides among fitting images, the order is deterministic.
 */
import { describe, expect, it } from "vitest";
import type { ImageCandidate } from "../src/providers/types.js";
import { orientationOf, rankCandidates, tokens } from "../src/rank.js";

const cand = (id: string, width: number, height: number, text: string, rank = 0): ImageCandidate => ({
  provider: "openverse", id, downloadUrl: `https://x.example/${id}.jpg`, width, height, text, rank,
  attribution: { provider: "openverse", license: "CC0", attributionRequired: false },
});

describe("rankCandidates", () => {
  it("prefers the requested orientation and enough width", () => {
    const out = rankCandidates(
      [cand("tall", 1200, 1800, "coffee shop"), cand("small", 400, 300, "coffee shop"), cand("wide", 1600, 1000, "coffee shop")],
      "coffee shop",
      { orientation: "landscape", minWidth: 1000 },
    );
    expect(out.map((s) => s.candidate.id)).toEqual(["wide", "small", "tall"]);
    expect(out.map((s) => s.good)).toEqual([true, false, false]);
  });

  it("uses relevance among fitting candidates, with plural folding", () => {
    const out = rankCandidates(
      [cand("a", 1600, 1000, "mountain lake"), cand("b", 1600, 1000, "Coffee Shops in Paris"), cand("c", 1600, 1000, "shop")],
      "a photo of a coffee shop",
      { minWidth: 1000 },
    );
    expect(out.map((s) => s.candidate.id)).toEqual(["b", "c", "a"]);
    expect(out[2]?.good).toBe(false);
  });

  it("is deterministic on ties (provider rank, then id)", () => {
    const input = [cand("z", 1600, 1000, "cat", 2), cand("y", 1600, 1000, "cat", 1), cand("x", 1600, 1000, "cat", 1)];
    const a = rankCandidates(input, "cat", { minWidth: 1000 }).map((s) => s.candidate.id);
    const b = rankCandidates([...input].reverse(), "cat", { minWidth: 1000 }).map((s) => s.candidate.id);
    expect(a).toEqual(["x", "y", "z"]);
    expect(b).toEqual(a);
  });

  it("helpers", () => {
    expect(tokens("A photo of the Café-bar!")).toEqual(["cafe", "bar"]);
    expect(orientationOf(1000, 1000)).toBe("square");
    expect(orientationOf(1600, 900)).toBe("landscape");
    expect(orientationOf(900, 1600)).toBe("portrait");
    expect(orientationOf(0, 10)).toBeNull();
  });
});
