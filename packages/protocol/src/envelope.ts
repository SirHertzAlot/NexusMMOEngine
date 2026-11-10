import { MessageType } from "./types.js";

const VALID_TYPE_LUT = new Uint8Array(256);
for (const v of Object.values(MessageType)) {
  if (typeof v === "number" && v >= 0 && v < 256) {
    VALID_TYPE_LUT[v] = 1;
  }
}

const sharedEncoder = new TextEncoder();
const sharedDecoder = new TextDecoder();

/**
 * Binary envelope: `[u8 type][payload bytes]` (docs/MESSAGE-CATALOG.md).
 * One tiny, total function pair — the only place envelope framing lives (DRY).
 */
export function encodeEnvelope(type: MessageType, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.length);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

export function decodeEnvelope(buf: Uint8Array): {
  type: MessageType;
  payload: Uint8Array;
} {
  if (buf.length < 1) {
    throw new Error("envelope: empty buffer");
  }
  const type = buf[0] as MessageType;
  if (VALID_TYPE_LUT[type] === 0) {
    throw new Error(`envelope: unknown message type 0x${type.toString(16)}`);
  }
  return { type, payload: buf.subarray(1) };
}

/** Control plane = JSON (debuggable). Data plane stays FlatBuffers. */
export function encodeControl(obj: unknown): Uint8Array {
  return sharedEncoder.encode(JSON.stringify(obj));
}

export function decodeControl<T>(payload: Uint8Array): T {
  return JSON.parse(sharedDecoder.decode(payload)) as T;
}
