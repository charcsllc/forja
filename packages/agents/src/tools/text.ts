/**
 * Output shaping shared by the tools: line numbering, truncation with an explicit marker.
 *
 * What this protects: the model always knows when it saw only part of something (the
 * marker says how much was cut and how to see the rest), and no tool can flood the
 * context with a megabyte of output.
 */
export function truncateBytes(text: string, maxBytes: number, hint = ""): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  // Keep the head and the tail: errors are usually at the end of command output.
  const half = Math.floor(maxBytes / 2);
  const head = Buffer.from(text, "utf8").subarray(0, half).toString("utf8");
  const tail = Buffer.from(text, "utf8").subarray(bytes - half).toString("utf8");
  return { text: `${head}\n… [${bytes - maxBytes} bytes omitted${hint ? `; ${hint}` : ""}] …\n${tail}`, truncated: true };
}

export function lastLines(text: string, n: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - n)).join("\n");
}

export function numbered(lines: string[], firstLine: number): string {
  const width = String(firstLine + lines.length - 1).length;
  return lines.map((l, i) => `${String(firstLine + i).padStart(width, " ")}\t${l}`).join("\n");
}

export function looksBinary(bytes: Uint8Array): boolean {
  const sniff = bytes.subarray(0, 8192);
  if (sniff.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}
