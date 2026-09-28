import { MessageType } from "./types.js";

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
  if (!Object.values(MessageType).includes(type)) {
    throw new Error(`envelope: unknown message type 0x${type.toString(16)}`);
  }
  return { type, payload: buf.slice(1) };
}

/** Control plane = JSON (debuggable). Data plane stays FlatBuffers. */
export function encodeControl(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function decodeControl<T>(payload: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(payload)) as T;
}
