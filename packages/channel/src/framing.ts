/**
 * Frame format: a 4-byte big-endian length, then that many body bytes. One
 * frame carries one packet. Two body kinds share the header:
 *
 *   JSON     the body is UTF-8 JSON, the packet itself. Used when the packet
 *            carries no bytes.
 *   binary   the body starts with a 0x00 byte (never the first byte of JSON
 *            text), then a 4-byte BE length L, then L bytes of JSON envelope
 *            `{"o": packet, "b": [len0, len1, ...]}`, then the blobs' bytes
 *            back to back. Every Uint8Array in the packet is one blob: the
 *            encoder replaces it with `{"$bin": i}` and the reader puts a
 *            Buffer back in its place.
 *
 * Bytes travel raw in binary frames instead of base64 inside JSON (E5a):
 * base64 costs a third more bytes and an encode and decode pass per frame.
 * `$bin` is reserved as the only key of a blob reference in binary frames.
 */
export const MAX_FRAME_BYTES = 8388608; // 8 MiB

/** The first body byte of a binary frame. */
const BINARY_MARK = 0x00;

/** A frame over the 8 MiB cap, sent or announced; `bytes` is its size. */
export class FrameTooLargeError extends Error {
  constructor(readonly bytes: number) { super("frame exceeds 8 MiB"); }
}

/**
 * Encode one packet. Uint8Array values (Buffers included) anywhere in it go
 * out as raw blobs; a packet with none is an ordinary JSON frame.
 */
export function encodeFrame(obj: unknown): Buffer {
  const blobs: Uint8Array[] = [];
  const tree = extractBlobs(obj, blobs);
  const json = JSON.stringify(tree);
  if (blobs.length === 0) {
    const len = Buffer.byteLength(json, "utf8");
    if (len > MAX_FRAME_BYTES) throw new FrameTooLargeError(len);
    const out = Buffer.allocUnsafe(4 + len);
    out.writeUInt32BE(len, 0);
    out.write(json, 4, "utf8");
    return out;
  }
  const env = `{"o":${json},"b":${JSON.stringify(blobs.map((b) => b.length))}}`;
  const envLen = Buffer.byteLength(env, "utf8");
  let blobBytes = 0;
  for (const b of blobs) blobBytes += b.length;
  // Body: mark, 4-byte envelope length, envelope, blobs. One allocation, one copy per part.
  const size = 5 + envLen + blobBytes;
  if (size > MAX_FRAME_BYTES) throw new FrameTooLargeError(size);
  const out = Buffer.allocUnsafe(4 + size);
  out.writeUInt32BE(size, 0);
  out[4] = BINARY_MARK;
  out.writeUInt32BE(envLen, 5);
  out.write(env, 9, "utf8");
  let at = 9 + envLen;
  for (const b of blobs) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/**
 * Returns `v` with every Uint8Array swapped for `{"$bin": i}` and its bytes
 * pushed onto `blobs`. Values with their own toJSON (Date, ...) pass through
 * untouched, so JSON.stringify serialises them as before. Doing this in one
 * walk instead of a JSON.stringify replacer skips the Buffer.toJSON detour
 * for every blob (a number array per 4 KiB blob).
 */
function extractBlobs(v: unknown, blobs: Uint8Array[]): unknown {
  if (v instanceof Uint8Array) {
    blobs.push(v);
    return { $bin: blobs.length - 1 };
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = extractBlobs(x, blobs);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (typeof v === "object" && v !== null && typeof (v as { toJSON?: unknown }).toJSON !== "function") {
    const src = v as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const k of Object.keys(src)) {
      const y = extractBlobs(src[k], blobs);
      if (y !== src[k]) {
        out ??= { ...src };
        out[k] = y;
      }
    }
    return out ?? v;
  }
  return v;
}

/** Reads a binary frame's body (the bytes after the 4-byte length) back into its packet. */
function decodeBinary(body: Buffer): unknown {
  if (body.length < 5) throw new Error("invalid frame");
  const envLen = body.readUInt32BE(1);
  if (5 + envLen > body.length) throw new Error("invalid frame");
  let env: { o?: unknown; b?: unknown };
  try {
    env = JSON.parse(body.toString("utf8", 5, 5 + envLen)) as { o?: unknown; b?: unknown };
  } catch {
    throw new Error("invalid frame JSON");
  }
  if (!Array.isArray(env.b)) throw new Error("invalid frame");
  const blobs: Buffer[] = [];
  let at = 5 + envLen;
  for (const len of env.b) {
    if (typeof len !== "number" || !Number.isInteger(len) || len < 0 || at + len > body.length) throw new Error("invalid frame");
    blobs.push(body.subarray(at, at + len));
    at += len;
  }
  if (at !== body.length) throw new Error("invalid frame");
  return restore(env.o, blobs);
}

/** Puts each `{"$bin": i}` back as blob i. */
function restore(v: unknown, blobs: Buffer[]): unknown {
  if (Array.isArray(v)) return v.map((x) => restore(x, blobs));
  if (typeof v !== "object" || v === null) return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0] === "$bin") {
    const i = o.$bin;
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= blobs.length) throw new Error("invalid frame blob");
    return blobs[i];
  }
  for (const k of keys) o[k] = restore(o[k], blobs);
  return o;
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
      if (body[0] === BINARY_MARK) {
        out.push(decodeBinary(body));
        continue;
      }
      try {
        out.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new Error("invalid frame JSON");
      }
    }
    return out;
  }
}
