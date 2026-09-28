/**
 * SSE parser edge cases. Protects: identical events whatever the network chunking.
 */
import { describe, expect, it } from "vitest";
import { SseParser, type SseEvent } from "../src/adapters/sse.js";
import { chunkBytes, fixtureText } from "./helpers.js";

function parseAll(chunks: Array<string | Uint8Array>): SseEvent[] {
  const p = new SseParser();
  const out: SseEvent[] = [];
  for (const c of chunks) out.push(...p.push(c));
  out.push(...p.end());
  return out;
}

describe("SseParser", () => {
  it("parses data events and ignores comments", () => {
    expect(parseAll([": keep-alive\n\ndata: {\"a\":1}\n\ndata: [DONE]\n\n"])).toEqual([
      { event: "message", data: '{"a":1}' },
      { event: "message", data: "[DONE]" },
    ]);
  });

  it("joins multi-line data and keeps event names and ids", () => {
    expect(parseAll(["event: error\nid: 7\ndata: line1\ndata:line2\n\n"])).toEqual([{ event: "error", data: "line1\nline2", id: "7" }]);
  });

  it.each(["\n", "\r\n", "\r"])("accepts %j line endings", (eol) => {
    const text = `data: one${eol}${eol}data: two${eol}${eol}`;
    expect(parseAll([text]).map((e) => e.data)).toEqual(["one", "two"]);
  });

  it("handles \\r\\n split across chunks", () => {
    expect(parseAll(["data: one\r", "\n\r", "\ndata: two\r\n\r\n"]).map((e) => e.data)).toEqual(["one", "two"]);
  });

  it("delivers a final event without its blank line", () => {
    expect(parseAll(["data: tail"]).map((e) => e.data)).toEqual(["tail"]);
  });

  it("decodes multi-byte UTF-8 split across chunks", () => {
    const text = 'data: {"t":"héllo ✓ 你好"}\n\n';
    for (const size of [1, 2, 3, 5]) expect(parseAll(chunkBytes(text, size))).toEqual([{ event: "message", data: '{"t":"héllo ✓ 你好"}' }]);
  });

  it("gives the same events for the real NIM capture at every chunk size", () => {
    const text = fixtureText("tool-result.response.sse");
    const whole = parseAll([text]);
    expect(whole.length).toBeGreaterThan(10);
    for (const size of [1, 7, 64, 333]) expect(parseAll(chunkBytes(text, size))).toEqual(whole);
  });
});
