/**
 * IntentMessage FlatBuffers codec tests (slice 1.3).
 *
 * Covers the data-plane encode/decode contract: the gateway decodes
 * these on the wire and hands the plain QueuedIntent to
 * SimWorld.queueIntent() — the codec must round-trip exactly.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeIntentMessage,
  encodeIntentMessage,
} from "../../src/net/intent.js";

describe("intent codec", () => {
  it("round-trips client_tick, entity, and all intent fields", () => {
    const bytes = encodeIntentMessage(
      42n,
      0x0000_0001_0000_0002n,
      { mx: 1, my: -1, mz: 0.25, lookYaw: 0.5, lookPitch: -0.5, jump: true, buttons: 7 },
    );
    const d = decodeIntentMessage(bytes);
    assert.equal(d.clientTick, 42n);
    assert.equal(d.entity, 0x0000_0001_0000_0002n);
    // f32-exact values: deep-equal is safe here.
    assert.deepEqual(d.intent, {
      mx: 1, my: -1, mz: 0.25, lookYaw: 0.5, lookPitch: -0.5, jump: true, buttons: 7,
    });
  });

  it("distinguishes entities across generations (u64 wire ids)", () => {
    const a = decodeIntentMessage(
      encodeIntentMessage(1n, 0x0000_0003_0000_0009n, { mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 }),
    );
    const b = decodeIntentMessage(
      encodeIntentMessage(1n, 0x0000_0004_0000_0009n, { mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 }),
    );
    assert.notEqual(a.entity, b.entity, "same slot, different generation");
  });

  it("rejects malformed buffers instead of decoding garbage", () => {
    const good = encodeIntentMessage(
      1n, 1n, { mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 },
    );
    assert.throws(() => decodeIntentMessage(new Uint8Array(0)));
    assert.throws(() => decodeIntentMessage(new Uint8Array([1, 2, 3])));
    assert.throws(() => decodeIntentMessage(good.slice(0, 10)));
  });

  it("produces a fresh buffer per call (no shared mutable state)", () => {
    const a = encodeIntentMessage(1n, 1n, { mx: 1, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 });
    const b = encodeIntentMessage(1n, 1n, { mx: 1, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 });
    assert.notEqual(a, b);
    assert.deepEqual([...a], [...b]);
  });
});
