/**
 * Magic-byte sniffing and header sizes. Protects: only the five bitmap formats pass,
 * SVG and HTML never do, sizes come from the bytes (EXIF rotation included).
 */
import { describe, expect, it } from "vitest";
import { detectKind, sniffImage } from "../src/sniff.js";
import { avif, fixture, gif, jpeg, png, svg, webpVp8, webpVp8l, webpVp8x } from "./helpers.js";

describe("sniffImage", () => {
  it("reads a real Flickr JPEG (recorded fixture, EXIF header) as 500×333", () => {
    expect(sniffImage(new Uint8Array(fixture("flickr-500x333.jpg")))).toEqual({
      kind: "jpeg", mediaType: "image/jpeg", extension: "jpg", width: 500, height: 333,
    });
  });

  it.each([
    ["png", png(1600, 900), 1600, 900, "png"],
    ["gif", gif(320, 200), 320, 200, "gif"],
    ["jpeg", jpeg(2048, 1365), 2048, 1365, "jpg"],
    ["webp VP8X", webpVp8x(3000, 2000), 3000, 2000, "webp"],
    ["webp VP8L", webpVp8l(1200, 800), 1200, 800, "webp"],
    ["webp VP8", webpVp8(1024, 768), 1024, 768, "webp"],
    ["avif", avif(1920, 1080), 1920, 1080, "avif"],
  ])("%s", (_name, bytes, w, h, ext) => {
    const s = sniffImage(bytes);
    expect(s).toMatchObject({ width: w, height: h, extension: ext });
  });

  it("swaps width and height for EXIF orientation 6 (rotated 90°)", () => {
    expect(sniffImage(jpeg(4000, 3000, 6))).toMatchObject({ width: 3000, height: 4000 });
    expect(sniffImage(jpeg(4000, 3000, 1))).toMatchObject({ width: 4000, height: 3000 });
  });

  it("never accepts SVG, HTML, text or truncated headers", () => {
    expect(detectKind(svg)).toBeNull();
    expect(sniffImage(svg)).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<!doctype html><html></html>"))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffImage(png(0, 10))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
});
