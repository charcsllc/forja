/**
 * Server-Sent Events parser (WHATWG "event stream" rules, the subset LLM APIs use).
 *
 * What this file protects:
 * - Network chunks may split anywhere: inside a line, inside `\r\n`, inside a multi-byte
 *   UTF-8 character. Bytes are decoded in streaming mode and lines are only parsed once
 *   complete, so the events are identical whatever the chunking.
 * - Comments (`: keep-alive`) are ignored, multi-line `data:` fields are joined with `\n`,
 *   and a final event without its blank line is still delivered at end of stream.
 * - The parser knows nothing about `[DONE]` or JSON: that belongs to the adapter.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8");
  private buffer = "";
  private dataLines: string[] = [];
  private eventName = "";
  private lastId: string | undefined;
  private sawCr = false;

  /** Feeds raw bytes (or text); returns the events completed by this chunk. */
  push(chunk: Uint8Array | string): SseEvent[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    return this.consume(text, false);
  }

  /** Flushes the decoder and any pending event at end of stream. */
  end(): SseEvent[] {
    const tail = this.decoder.decode();
    return this.consume(tail, true);
  }

  private consume(text: string, final: boolean): SseEvent[] {
    const out: SseEvent[] = [];
    let s = text;
    // A `\r` ending the previous chunk may be the first half of `\r\n`.
    if (this.sawCr && s.startsWith("\n")) s = s.slice(1);
    this.sawCr = false;
    this.buffer += s;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const c = this.buffer[i];
      if (c !== "\n" && c !== "\r") continue;
      const line = this.buffer.slice(start, i);
      if (c === "\r") {
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === "\n") i++;
        } else {
          this.sawCr = true;
        }
      }
      start = i + 1;
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    this.buffer = this.buffer.slice(start);

    if (final) {
      if (this.buffer !== "") {
        const ev = this.line(this.buffer);
        if (ev) out.push(ev);
        this.buffer = "";
      }
      const ev = this.dispatch();
      if (ev) out.push(ev);
    }
    return out;
  }

  private line(line: string): SseEvent | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.dataLines.push(value);
    else if (field === "event") this.eventName = value;
    else if (field === "id") this.lastId = value;
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (this.dataLines.length === 0) {
      this.eventName = "";
      return undefined;
    }
    const ev: SseEvent = { event: this.eventName || "message", data: this.dataLines.join("\n") };
    if (this.lastId !== undefined) ev.id = this.lastId;
    this.dataLines = [];
    this.eventName = "";
    return ev;
  }
}
