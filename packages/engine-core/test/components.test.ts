import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, addEntity, addComponent } from "bitecs";
import {
  AssetRef,
  AudioEmitter,
  COMPONENT_IDS,
  StructuralIntegrity,
  FlowRef,
  Transform,
  VfxEmitter,
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
  // ids remain unique; 18/19/20 are the viewport branch's markers
  // (FlowRef/VfxEmitter/AudioEmitter) — with all branches merged the
  // registry is dense 0–21
  const ids = Object.values(COMPONENT_IDS);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...ids].sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21],
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

test("FlowRef is registered as component id 18, VfxEmitter as 19, AudioEmitter as 20", () => {
  assert.equal(COMPONENT_IDS.FlowRef, 18);
  assert.equal(COMPONENT_IDS.VfxEmitter, 19);
  assert.equal(COMPONENT_IDS.AudioEmitter, 20);
});

test("FlowRef stores graph (u32 hash) + enabled (u8) on an entity", () => {
  const world = createWorld();
  const eid = addEntity(world);
  addComponent(world, FlowRef, eid);
  FlowRef.graph[eid] = 0xdeadbeef;
  FlowRef.enabled[eid] = 1;
  assert.equal(FlowRef.graph[eid], 0xdeadbeef);
  assert.equal(FlowRef.enabled[eid], 1);
  // zero-initialized: unbound graph id, disabled by default
  const eid2 = addEntity(world);
  addComponent(world, FlowRef, eid2);
  assert.equal(FlowRef.graph[eid2], 0);
  assert.equal(FlowRef.enabled[eid2], 0);
});

test("VfxEmitter stores template (u32 hash) + intensity (f32) on an entity", () => {
  const world = createWorld();
  const eid = addEntity(world);
  addComponent(world, VfxEmitter, eid);
  addComponent(world, Transform, eid);
  VfxEmitter.template[eid] = 0x12345678;
  VfxEmitter.intensity[eid] = 1.5;
  assert.equal(VfxEmitter.template[eid], 0x12345678);
  assert.equal(VfxEmitter.intensity[eid], 1.5);
});

test("AudioEmitter stores clip (u32 hash) + radius (f32) on an entity", () => {
  const world = createWorld();
  const eid = addEntity(world);
  addComponent(world, AudioEmitter, eid);
  addComponent(world, Transform, eid);
  AudioEmitter.clip[eid] = 0x9abcdef0;
  AudioEmitter.radius[eid] = 12.25;
  assert.equal(AudioEmitter.clip[eid], 0x9abcdef0);
  assert.equal(AudioEmitter.radius[eid], 12.25);
});
