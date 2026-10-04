/**
 * Frame format: a 4-byte big-endian length, then that many bytes of UTF-8
 * JSON. One frame carries one packet.
 */
export const MAX_FRAME_BYTES = 8388608; // 8 MiB

/** A frame over the 8 MiB cap, sent or announced; `bytes` is its size. */
export class FrameTooLargeError extends Error {
  constructor(readonly bytes: number) { super("frame exceeds 8 MiB"); }
}

export function encodeFrame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (body.length > MAX_FRAME_BYTES) throw new FrameTooLargeError(body.length);
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

/**
 * Reassembles frames from a byte stream. `push` returns every frame the
 * chunk completed, buffering any partial frame for the next push. Throws
 * `invalid frame JSON` on a complete frame that does not parse (the caller
 * closes the socket), and on a declared length over 8 MiB.
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) throw new FrameTooLargeError(len);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new Error("invalid frame JSON");
      }
    }
    return out;
  }
}
