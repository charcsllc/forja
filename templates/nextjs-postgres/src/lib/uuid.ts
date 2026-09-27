/**
 * UUID v7 (RFC 9562): 48-bit Unix milliseconds + 74 random bits. Time-ordered, so primary
 * keys stay index-friendly. Monotonic within a process for ids created in the same ms.
 */
let lastMs = 0;
let lastSeq = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  // 12-bit sequence in rand_a keeps ids monotonic inside the same millisecond.
  if (now <= lastMs) {
    lastSeq = (lastSeq + 1) & 0xfff;
    if (lastSeq === 0) lastMs += 1;
    now = lastMs;
  } else {
    lastMs = now;
    lastSeq = (((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)) & 0x7ff;
  }

  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = 0x70 | ((lastSeq >> 8) & 0x0f);
  bytes[7] = lastSeq & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value);
}
