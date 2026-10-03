import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, addEntity, addComponent } from "bitecs";
import {
  AssetRef,
  COMPONENT_IDS,
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
  // ids remain dense and unique
  const ids = Object.values(COMPONENT_IDS);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
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
