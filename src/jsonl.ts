import { StringDecoder } from "node:string_decoder";

/** LF-only framing, including split UTF-8 characters and literal Unicode separators. */
export class JsonLines {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(
    private maxBytes: number,
    private onLine: (line: string) => void,
  ) {}
  push(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.maxBytes)
        throw new Error("JSONL record too large");
      if (line.length) this.onLine(line);
    }
    if (Buffer.byteLength(this.buffer) > this.maxBytes)
      throw new Error("JSONL record too large");
  }
}
