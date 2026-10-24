import test from "node:test";
import assert from "node:assert/strict";
import { decodeDeltaSet, DeltaSetKind, encodeDeltaSet } from "../src/deltaset.js";

test("DeltaSet round-trips entries byte for byte", () => {
  const set = {
    tick: 4242,
    replace: true,
    entries: [
      { kind: DeltaSetKind.Delta, sector: "g", bytes: new Uint8Array([1, 2, 3]) },
      { kind: DeltaSetKind.Full, sector: "3,-7", bytes: new Uint8Array(300).fill(9) },
      { kind: DeltaSetKind.Leave, sector: "-1,0", bytes: new Uint8Array(0) },
    ],
  };
  const back = decodeDeltaSet(encodeDeltaSet(set));
  assert.equal(back.tick, 4242);
  assert.equal(back.replace, true);
  assert.deepEqual(back.entries.map((e) => [e.kind, e.sector, [...e.bytes]]), set.entries.map((e) => [e.kind, e.sector, [...e.bytes]]));
  assert.throws(() => decodeDeltaSet(encodeDeltaSet(set).subarray(0, 20)), /truncated/);
});
