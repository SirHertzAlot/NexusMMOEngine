/**
 * MirrorState: snapshot/delta folding (the mirror's core contract).
 *
 * - A snapshot fully replaces state (stale entities are dropped).
 * - A delta upserts only the rows it carries; untouched rows survive.
 * - Despawned ids are dropped; spawned ids arrive via the component
 *   blocks (server contract — no separate spawn handling needed).
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

const A = 0x1001n;
const B = 0x1002n;

describe("MirrorState.applySnapshot", () => {
  it("populates entities from a full snapshot and records the tick", () => {
    const s = emptyState(42);
    s.transforms = [transformRow(A, 1), transformRow(B, 2)];
    s.spawned = [A, B];
    const state = new MirrorState();
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s)));

    assert.equal(state.entityCount, 2);
    assert.equal(state.lastTick, 42);
    assert.equal(state.get(A)?.transform?.px, 1);
    assert.equal(state.get(B)?.transform?.px, 2);
  });

  it("replaces state: entities missing from the new snapshot are dropped", () => {
    const state = new MirrorState();
    const s1 = emptyState(1);
    s1.transforms = [transformRow(A, 1), transformRow(B, 2)];
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s1)));

    const s2 = emptyState(300);
    s2.transforms = [transformRow(B, 5)];
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s2)));

    assert.equal(state.entityCount, 1);
    assert.equal(state.get(A), undefined);
    assert.equal(state.get(B)?.transform?.px, 5);
    assert.equal(state.lastTick, 300);
  });
});

describe("MirrorState.applyDelta", () => {
  it("upserts changed rows and keeps untouched rows", () => {
    const state = new MirrorState();
    const s = emptyState(1);
    s.transforms = [transformRow(A, 1), transformRow(B, 2)];
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s)));

    const d = emptyState(2, 1);
    d.transforms = [transformRow(A, 10)]; // only A moved
    state.applyDelta(decodeDelta(encodeDelta(d)));

    assert.equal(state.entityCount, 2);
    assert.equal(state.get(A)?.transform?.px, 10);
    assert.equal(state.get(B)?.transform?.px, 2); // untouched row survives
    assert.equal(state.lastTick, 2);
  });

  it("drops despawned entities", () => {
    const state = new MirrorState();
    const s = emptyState(1);
    s.transforms = [transformRow(A, 1), transformRow(B, 2)];
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s)));

    const d = emptyState(2, 1);
    d.despawned = [A];
    state.applyDelta(decodeDelta(encodeDelta(d)));

    assert.equal(state.entityCount, 1);
    assert.equal(state.get(A), undefined);
    assert.equal(state.get(B)?.transform?.px, 2);
  });

  it("adds newly spawned entities via the component blocks", () => {
    const state = new MirrorState();
    const s = emptyState(1);
    s.transforms = [transformRow(A, 1)];
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s)));

    const d = emptyState(2, 1);
    d.transforms = [transformRow(B, 7)];
    d.spawned = [B];
    state.applyDelta(decodeDelta(encodeDelta(d)));

    assert.equal(state.entityCount, 2);
    assert.equal(state.get(B)?.transform?.px, 7);
  });

  it("carries AssetRef rows through snapshot and delta", () => {
    const state = new MirrorState();
    const s = emptyState(1);
    s.transforms = [transformRow(A, 1)];
    s.assets = [{ wireId: A, assetHash: 0xdeadbeef, variant: 3 }];
    state.applySnapshot(decodeSnapshot(encodeSnapshot(s)));
    assert.equal(state.get(A)?.asset?.assetHash, 0xdeadbeef);
    assert.equal(state.get(A)?.asset?.variant, 3);

    // Delta without asset rows leaves the existing ref untouched.
    const d = emptyState(2, 1);
    d.transforms = [transformRow(A, 9)];
    state.applyDelta(decodeDelta(encodeDelta(d)));
    assert.equal(state.get(A)?.asset?.assetHash, 0xdeadbeef);
  });
});
