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
  sanitizeIntent,
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

describe("sanitizeIntent (trust boundary)", () => {
  const base = { mx: 0, my: 0, mz: 0, lookYaw: 0, lookPitch: 0, jump: false, buttons: 0 };

  it("passes a normal intent through unchanged", () => {
    const i = { ...base, mx: Math.SQRT1_2, mz: -Math.SQRT1_2, lookYaw: 3, lookPitch: -0.4, jump: true, buttons: 5 };
    assert.equal(sanitizeIntent(i), i);
  });

  it("caps the move vector at length 1, keeping its direction", () => {
    const out = sanitizeIntent({ ...base, mx: 300, mz: 400 })!;
    assert.ok(Math.abs(out.mx - 0.6) < 1e-12 && Math.abs(out.mz - 0.8) < 1e-12, `${out.mx},${out.mz}`);
  });

  it("caps vertical on its own: rising while moving keeps full horizontal speed", () => {
    const up = { ...base, mx: 0.6, my: 1, mz: 0.8 };
    assert.equal(sanitizeIntent(up), up, "a unit horizontal move plus full climb is fine");
    const out = sanitizeIntent({ ...base, mx: 0, my: -50, mz: 0 })!;
    assert.equal(out.my, -1);
  });

  it("rejects any non-finite number", () => {
    for (const k of ["mx", "my", "mz", "lookYaw", "lookPitch"] as const) {
      for (const v of [Number.NaN, Infinity, -Infinity]) {
        assert.equal(sanitizeIntent({ ...base, [k]: v }), null, `${k}=${v}`);
      }
    }
  });
});
