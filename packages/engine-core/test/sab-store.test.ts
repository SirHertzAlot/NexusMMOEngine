/**
 * SAB-backed component storage (Phase 1): the real engine components
 * defined via defineSABComponent must behave identically to plain bitECS
 * components, with field stores living in a SharedArrayBuffer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addEntity,
  addComponent,
  createWorld,
  defineQuery,
  hasComponent,
  removeComponent,
} from "bitecs";
import { Transform, Needs, God } from "../src/components.js";
import { Body, Injury } from "../src/body.js";
import { Mana } from "../src/magic.js";

describe("sab-store (Phase 1)", () => {
  it("scalar field stores live in a SharedArrayBuffer", () => {
    assert.ok(
      Transform.px.buffer instanceof SharedArrayBuffer,
      "Transform.px should be SAB-backed",
    );
    assert.ok(
      Needs.hunger.buffer instanceof SharedArrayBuffer,
      "Needs.hunger should be SAB-backed",
    );
    assert.ok(
      Mana.current.buffer instanceof SharedArrayBuffer,
      "Mana.current should be SAB-backed",
    );
  });

  it("array-field per-eid views live in a SharedArrayBuffer", () => {
    const world = createWorld();
    const e = addEntity(world);
    addComponent(world, Body, e);
    // Per-eid subarray views into the SAB-backed parent.
    assert.ok(
      Body.hp[e].buffer instanceof SharedArrayBuffer,
      "Body.hp[e] should be SAB-backed",
    );
    assert.ok(
      Body.clot[e].buffer instanceof SharedArrayBuffer,
      "Body.clot[e] should be SAB-backed",
    );
  });

  it("values round-trip through SAB-backed stores, queries see them", () => {
    const world = createWorld();
    const q = defineQuery([Transform, Needs]);
    const e = addEntity(world);
    addComponent(world, Transform, e);
    addComponent(world, Needs, e);
    Transform.px[e] = 12.5;
    Transform.pz[e] = -3.25;
    Needs.hunger[e] = 42;
    Needs.thirst[e] = 7.5;
    assert.equal(Transform.px[e], 12.5);
    assert.equal(Transform.pz[e], -3.25);
    assert.equal(Needs.hunger[e], 42);
    assert.equal(Needs.thirst[e], 7.5);
    assert.ok(q(world).includes(e));
    assert.ok(hasComponent(world, Transform, e));
  });

  it("array fields round-trip; reset zeroes the SAB store", () => {
    const world = createWorld();
    const e = addEntity(world);
    addComponent(world, Body, e);
    addComponent(world, Injury, e);
    Body.hp[e][3] = 0.5;
    Body.wound[e][3] = 2;
    Body.blood[e] = 88.5;
    Injury.bits[e] = 0x1234;
    assert.equal(Body.hp[e][3], 0.5);
    assert.equal(Body.wound[e][3], 2);
    assert.equal(Body.blood[e], 88.5);
    assert.equal(Injury.bits[e], 0x1234);

    // Reset (remove then re-add with reset=true) zeroes the SAB store.
    // Note: re-adding an already-present component is a bitECS no-op,
    // so the remove step is required for reset to fire.
    removeComponent(world, Body, e);
    addComponent(world, Body, e, true);
    assert.equal(Body.hp[e][3], 0);
    assert.equal(Body.blood[e], 0);
    assert.ok(Body.hp[e].every((v) => v === 0));
  });

  it("tag components carry no data and are untouched", () => {
    const world = createWorld();
    const e = addEntity(world);
    addComponent(world, God, e);
    assert.ok(hasComponent(world, God, e));
    // No field stores on a tag component.
    assert.equal(Object.keys(God).length, 0);
  });
});
