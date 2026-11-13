import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeControl,
  encodeControl,
  encodeEnvelope,
  decodeEnvelope,
  MessageType,
  PROTOCOL_VERSION,
  compareFxOrder,
  FxDedupe,
  fxSpawnAgeSeconds,
  isFxMessage,
} from "../src/index.js";

test("Fx = 0x28 registered, in a protocol at version 30 or later", () => {
  assert.equal(MessageType.Fx, 0x28);
  // Fx arrived in v30. Later versions keep it, so this must not pin the current version.
  assert.ok(PROTOCOL_VERSION >= 30, `protocol version ${PROTOCOL_VERSION}`);
});

test("envelope carries 0x28 with JSON control payload", () => {
  const spawn = {
    kind: "fx-spawn",
    fxId: "01934c2e-0000-4000-8000-000000000001",
    tick: 900,
    seq: 3,
    assetId: "fx.charged-shot",
    assetVersion: 1,
    seed: 12345,
    binding: { kind: "entity", entityId: "76561198000000001" },
    phase: "charge",
    params: { charge01: 0.5 },
  };
  const wire = encodeEnvelope(MessageType.Fx, encodeControl(spawn));
  assert.equal(wire[0], 0x28);
  const { type, payload } = decodeEnvelope(wire);
  assert.equal(type, MessageType.Fx);
  const back = decodeControl<Record<string, Record<string, unknown>>>(
    payload,
  ) as unknown as typeof spawn;
  assert.equal(back.fxId, spawn.fxId);
  // wire ids are strings (u64-as-string), preserved exactly.
  assert.equal(back.binding.entityId, "76561198000000001");
  assert.equal(typeof back.binding.entityId, "string");
});

test("isFxMessage guard accepts spawns/updates/kills only", () => {
  assert.equal(isFxMessage({ kind: "fx-spawn" }), true);
  assert.equal(isFxMessage({ kind: "fx-update" }), true);
  assert.equal(isFxMessage({ kind: "fx-kill" }), true);
  assert.equal(isFxMessage({ kind: "telegraph" }), false);
  assert.equal(isFxMessage(null), false);
});

test("(tick, seq) ordering: newer supersedes", () => {
  assert.ok(compareFxOrder({ tick: 10, seq: 1 }, { tick: 9, seq: 9 }) > 0);
  assert.ok(compareFxOrder({ tick: 10, seq: 2 }, { tick: 10, seq: 1 }) > 0);
  assert.equal(compareFxOrder({ tick: 10, seq: 1 }, { tick: 10, seq: 1 }), 0);
});

test("spawn age seeks late arrivals at 30 Hz", () => {
  assert.equal(fxSpawnAgeSeconds(900, 930), 1);
  assert.equal(fxSpawnAgeSeconds(930, 900), 0);
});

test("dedupe LRU bounds to cap and flags replays", () => {
  const dedupe = new FxDedupe(4);
  assert.equal(dedupe.check("a", 1), false);
  assert.equal(dedupe.check("a", 1), true);
  for (const id of ["b", "c", "d", "e"]) dedupe.check(id, 2);
  assert.ok(dedupe.size <= 4);
});
