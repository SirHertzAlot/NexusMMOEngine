/**
 * MirrorState: VfxEmitter rows fold in like every other component row —
 * present after a snapshot, updated by a delta that carries them,
 * untouched by deltas that don't, dropped when the entity despawns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeDelta,
  decodeSnapshot,
  encodeDelta,
  encodeSnapshot,
} from "@mmo-engine/protocol";
import { MirrorState } from "../src/state.js";
import { emptyState, transformRow } from "./fixtures.js";

const SHRINE = 0x2001n;
/** fnv1a32("shrine-fire"). */
const FIRE_TEMPLATE = 4098966889;

describe("MirrorState vfxEmitter rows", () => {
  it("stores the emitter row from a snapshot", () => {
    const s = emptyState(1);
    s.transforms = [transformRow(SHRINE, 216)];
    s.vfxEmitters = [{ wireId: SHRINE, template: FIRE_TEMPLATE, intensity: 1.5 }];
    const state = new MirrorState();
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s)));
    const e = state.get(SHRINE);
    assert.equal(e?.vfxEmitter?.template, FIRE_TEMPLATE);
    assert.equal(e?.vfxEmitter?.intensity, 1.5);
  });

  it("a delta updates intensity; an unrelated delta leaves the row alone; despawn drops it", () => {
    const state = new MirrorState();
    const s = emptyState(1);
    s.transforms = [transformRow(SHRINE, 216)];
    s.vfxEmitters = [{ wireId: SHRINE, template: FIRE_TEMPLATE, intensity: 1 }];
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s)));

    const d1 = emptyState(2);
    d1.vfxEmitters = [{ wireId: SHRINE, template: FIRE_TEMPLATE, intensity: 2.5 }];
    state.applyDelta(decodeDelta(encodeDelta(d1)));
    assert.equal(state.get(SHRINE)?.vfxEmitter?.intensity, 2.5);

    const d2 = emptyState(3);
    d2.transforms = [transformRow(SHRINE, 217)];
    state.applyDelta(decodeDelta(encodeDelta(d2)));
    assert.equal(state.get(SHRINE)?.vfxEmitter?.intensity, 2.5);

    const d3 = emptyState(4);
    d3.despawned = [SHRINE];
    state.applyDelta(decodeDelta(encodeDelta(d3)));
    assert.equal(state.get(SHRINE), undefined);
  });
});
