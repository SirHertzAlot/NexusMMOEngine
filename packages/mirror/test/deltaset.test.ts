/** MirrorState.applyDeltaSet: leave, despawn-before-upsert, re-homing, left vs despawned. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { decodeDelta, encodeDelta, type CollectedState } from "@mmo-engine/protocol";
import { MirrorState } from "../src/state.js";
import { emptyState, transformRow } from "./fixtures.js";

const A = 1n, B = 2n, C = 3n;
const wire = (s: CollectedState) => decodeDelta(encodeDelta(s));
function entry(sector: string, tick: number, f: (s: CollectedState) => void) {
  const s = emptyState(tick);
  f(s);
  return { sector, leave: false, delta: wire(s) };
}

it("crossing between two visible sectors never flickers; leaving view is not a despawn", () => {
  const m = new MirrorState();
  m.applyDeltaSet(1, true, [
    entry("0,0", 1, (s) => { s.transforms = [transformRow(A, 1), transformRow(B, 2)]; }),
    entry("1,0", 1, (s) => { s.transforms = [transformRow(C, 70)]; }),
  ]);
  assert.equal(m.home.get(A), "0,0");
  // A crosses 0,0 -> 1,0: out of one entry, in full in the other.
  let r = m.applyDeltaSet(2, false, [
    entry("0,0", 2, (s) => { s.despawned = [A]; }),
    entry("1,0", 2, (s) => { s.transforms = [transformRow(A, 65)]; s.spawned = [A]; }),
  ]);
  assert.ok(m.entities.has(A));
  assert.equal(m.home.get(A), "1,0");
  assert.deepEqual([r.left, r.despawned, r.entered], [[], [], []]);
  // Sector 1,0 leaves view; B really despawns (global entry).
  r = m.applyDeltaSet(3, false, [
    { sector: "1,0", leave: true, delta: null },
    entry("g", 3, (s) => { s.despawned = [B]; }),
  ]);
  assert.deepEqual(r.left.sort(), [A, C]);
  assert.deepEqual(r.despawned, [B]);
  assert.equal(m.entities.size, 0);
  // C comes back into view (no global spawn): entered, not spawned.
  r = m.applyDeltaSet(4, false, [entry("1,0", 4, (s) => { s.transforms = [transformRow(C, 70)]; s.spawned = [C]; })]);
  assert.deepEqual(r.entered, [C]);
  assert.ok(m.entered.has(C));
});
