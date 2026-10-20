import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, addEntity, addComponent } from "bitecs";
import {
  AssetRef,
  COMPONENT_IDS,
  StructuralIntegrity,
  Transform,
} from "../src/components.js";

test("AssetRef is registered as component id 8, Locomotion as 9, Appearance as 10", () => {
  assert.equal(COMPONENT_IDS.AssetRef, 8);
  assert.equal(COMPONENT_IDS.Locomotion, 9);
  assert.equal(COMPONENT_IDS.Appearance, 10);
  assert.equal(COMPONENT_IDS.Action, 11);
  assert.equal(COMPONENT_IDS.Stamina, 12);
  assert.equal(COMPONENT_IDS.CharacterRef, 13);
  assert.equal(COMPONENT_IDS.Needs, 14);
  assert.equal(COMPONENT_IDS.God, 15);
  assert.equal(COMPONENT_IDS.Noclip, 16);
  assert.equal(COMPONENT_IDS.Animation, 17);
  assert.equal(COMPONENT_IDS.StructuralIntegrity, 21);
  // ids remain unique; 18/19/20 are held by the viewport branch's markers
  // (FlowRef/VfxEmitter/AudioEmitter) and fill in when the branches merge
  const ids = Object.values(COMPONENT_IDS);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 21],
  );
});

test("AssetRef stores assetHash (u32) + variant (u16) on an entity", () => {
  const world = createWorld();
  const eid = addEntity(world);
  addComponent(world, AssetRef, eid);
  addComponent(world, Transform, eid);
  AssetRef.assetHash[eid] = 2823540338; // fnv1a32("oak")
  AssetRef.variant[eid] = 7;
  assert.equal(AssetRef.assetHash[eid], 2823540338);
  assert.equal(AssetRef.variant[eid], 7);
});

test("StructuralIntegrity stores current/max (f32) on an entity, SAB-backed like its siblings", () => {
  const world = createWorld();
  const eid = addEntity(world);
  addComponent(world, StructuralIntegrity, eid);
  StructuralIntegrity.current[eid] = 120;
  StructuralIntegrity.max[eid] = 200;
  assert.equal(StructuralIntegrity.current[eid], 120);
  assert.equal(StructuralIntegrity.max[eid], 200);
  // SAB-backed: the field stores are SharedArrayBuffer views.
  assert.ok(StructuralIntegrity.current.buffer instanceof SharedArrayBuffer);
  assert.ok(StructuralIntegrity.max.buffer instanceof SharedArrayBuffer);
});
