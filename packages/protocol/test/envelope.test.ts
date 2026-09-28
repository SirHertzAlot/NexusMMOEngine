import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  decodeEnvelope,
  encodeControl,
  encodeEnvelope,
  MessageType,
  PROTOCOL_VERSION,
} from "../src/index.js";
import type { HelloMessage } from "../src/index.js";

test("envelope round-trips type + payload bytes", () => {
  const payload = new Uint8Array([9, 8, 7, 6]);
  const wire = encodeEnvelope(MessageType.Delta, payload);
  assert.equal(wire[0], 0x04);
  assert.equal(wire.length, 5);
  const { type, payload: back } = decodeEnvelope(wire);
  assert.equal(type, MessageType.Delta);
  assert.deepEqual(back, payload);
});

test("envelope rejects empty buffers and unknown types", () => {
  assert.throws(() => decodeEnvelope(new Uint8Array(0)), /empty buffer/);
  assert.throws(
    () => decodeEnvelope(new Uint8Array([0xff, 1, 2])),
    /unknown message type/,
  );
});

test("control plane JSON round-trips the auth hello variants", () => {
  const creds: HelloMessage = {
    protocol: PROTOCOL_VERSION,
    client: "test-client",
    username: "alice",
    password: "s3cret!!",
    want_snapshot: true,
  };
  const token: HelloMessage = {
    protocol: PROTOCOL_VERSION,
    client: "test-client",
    token: "a".repeat(64),
    want_snapshot: true,
  };
  for (const hello of [creds, token]) {
    const wire = encodeEnvelope(MessageType.Hello, encodeControl(hello));
    const { type, payload } = decodeEnvelope(wire);
    assert.equal(type, MessageType.Hello);
    assert.deepEqual(decodeControl<HelloMessage>(payload), hello);
  }
});

test("control plane carries u64 ids as strings (JS precision)", () => {
  const big = "18446744073709551615"; // 2^64 - 1 — not representable as f64
  const back = decodeControl<{ player_entity: string }>(
    encodeControl({ player_entity: big }),
  );
  assert.equal(back.player_entity, big);
});
