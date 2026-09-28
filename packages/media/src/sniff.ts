/**
 * What an image file really is, and how big it is, read from its bytes.
 *
 * Protects: the content type a server claims is never trusted. Only JPEG, PNG, WebP,
 * AVIF and GIF are accepted, recognised by their magic bytes; **SVG is never accepted**
 * (it is a document that can carry scripts and external references). Width and height
 * come from the format's own header, with no native dependency (`sharp` lives in the
 * browser sidecar, not in the engine). A file whose header cannot be parsed is rejected
 * rather than written with guessed dimensions.
 *
 * JPEG: EXIF orientation 5–8 swaps the reported width/height, because that is how the
 * browser lays the picture out and `next/image` needs the displayed aspect ratio.
 * AVIF: the first `ispe` box is the primary item's size (true for every encoder we know;
 * a file where it is not would only get a wrong aspect ratio, never be unsafe).
 */

export type ImageKind = "jpeg" | "png" | "webp" | "avif" | "gif";

export interface SniffedImage {
  kind: ImageKind;
  mediaType: string;
  extension: string;
  width: number;
  height: number;
}

const MEDIA: Record<ImageKind, { mediaType: string; extension: string }> = {
  jpeg: { mediaType: "image/jpeg", extension: "jpg" },
  png: { mediaType: "image/png", extension: "png" },
  webp: { mediaType: "image/webp", extension: "webp" },
  avif: { mediaType: "image/avif", extension: "avif" },
  gif: { mediaType: "image/gif", extension: "gif" },
};

const ascii = (b: Uint8Array, start: number, len: number): string => {
  let s = "";
  for (let i = start; i < start + len && i < b.length; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
};
const u8 = (b: Uint8Array, i: number): number => b[i] ?? 0;
const be16 = (b: Uint8Array, i: number): number => (u8(b, i) << 8) | u8(b, i + 1);
const le16 = (b: Uint8Array, i: number): number => u8(b, i) | (u8(b, i + 1) << 8);
const be32 = (b: Uint8Array, i: number): number => ((u8(b, i) << 24) >>> 0) + (u8(b, i + 1) << 16) + (u8(b, i + 2) << 8) + u8(b, i + 3);
const le32 = (b: Uint8Array, i: number): number => (u8(b, i) | (u8(b, i + 1) << 8) | (u8(b, i + 2) << 16) | (u8(b, i + 3) << 24)) >>> 0;
const le24 = (b: Uint8Array, i: number): number => u8(b, i) | (u8(b, i + 1) << 8) | (u8(b, i + 2) << 16);

/** The format by magic bytes, or null (SVG, HTML, TIFF, anything else). */
export function detectKind(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && u8(b, 0) === 0xff && u8(b, 1) === 0xd8 && u8(b, 2) === 0xff) return "jpeg";
  if (b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "webp";
  if (b.length >= 16 && ascii(b, 4, 4) === "ftyp") {
    const size = Math.min(be32(b, 0), b.length);
    for (let i = 8; i + 4 <= size; i += 4) {
      if (i === 12) continue; // minor version, not a brand
      const brand = ascii(b, i, 4);
      if (brand === "avif" || brand === "avis") return "avif";
    }
  }
  return null;
}

function pngSize(b: Uint8Array): [number, number] | null {
  if (b.length < 24 || ascii(b, 12, 4) !== "IHDR") return null;
  return [be32(b, 16), be32(b, 20)];
}

function gifSize(b: Uint8Array): [number, number] | null {
  if (b.length < 10) return null;
  return [le16(b, 6), le16(b, 8)];
}

function webpSize(b: Uint8Array): [number, number] | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") return [le24(b, 24) + 1, le24(b, 27) + 1];
  if (chunk === "VP8L") {
    if (u8(b, 20) !== 0x2f) return null;
    const bits = le32(b, 21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === "VP8 ") {
    if (u8(b, 23) !== 0x9d || u8(b, 24) !== 0x01 || u8(b, 25) !== 0x2a) return null;
    return [le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff];
  }
  return null;
}

/** EXIF orientation (1–8) from an APP1 segment payload, or 1. */
function exifOrientation(b: Uint8Array, start: number, end: number): number {
  if (ascii(b, start, 6) !== "Exif\0\0") return 1;
  const tiff = start + 6;
  const order = ascii(b, tiff, 2);
  const little = order === "II";
  if (!little && order !== "MM") return 1;
  const r16 = (i: number) => (little ? le16(b, i) : be16(b, i));
  const r32 = (i: number) => (little ? le32(b, i) : be32(b, i));
  const ifd = tiff + r32(tiff + 4);
  if (ifd + 2 > end) return 1;
  const count = r16(ifd);
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > end) break;
    if (r16(entry) === 0x0112) {
      const v = r16(entry + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegSize(b: Uint8Array): [number, number] | null {
  let i = 2;
  let orientation = 1;
  while (i + 4 <= b.length) {
    if (u8(b, i) !== 0xff) return null;
    let marker = u8(b, i + 1);
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = u8(b, i + 1);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan before a frame header
    const len = be16(b, i + 2);
    if (len < 2) return null;
    if (marker === 0xe1) orientation = Math.max(orientation, exifOrientation(b, i + 4, Math.min(b.length, i + 2 + len)));
    if (SOF.has(marker)) {
      if (i + 9 > b.length) return null;
      const h = be16(b, i + 5);
      const w = be16(b, i + 7);
      return orientation >= 5 ? [h, w] : [w, h];
    }
    i += 2 + len;
  }
  return null;
}

function avifSize(b: Uint8Array): [number, number] | null {
  for (let i = 4; i + 16 <= b.length; i++) {
    if (u8(b, i) === 0x69 && ascii(b, i, 4) === "ispe") {
      // box: size(4) 'ispe'(4) version+flags(4) width(4) height(4)
      return [be32(b, i + 8), be32(b, i + 12)];
    }
  }
  return null;
}

/** Kind, media type, extension and displayed size; null when the bytes are not an accepted image. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const kind = detectKind(bytes);
  if (!kind) return null;
  const size =
    kind === "jpeg" ? jpegSize(bytes) :
    kind === "png" ? pngSize(bytes) :
    kind === "gif" ? gifSize(bytes) :
    kind === "webp" ? webpSize(bytes) :
    avifSize(bytes);
  if (!size) return null;
  const [width, height] = size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) return null;
  return { kind, ...MEDIA[kind], width, height };
}
