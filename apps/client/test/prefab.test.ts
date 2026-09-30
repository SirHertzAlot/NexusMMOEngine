/**
 * The prefab builder: a composed entity's signals applied to its base and
 * undone again; materials cloned (never the shared originals), including
 * patched subclasses that can't clone themselves.
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { composeCreature, composeItem, type EntityBundle } from "@mmo-engine/compose/browser";
import { cloneMaterial, PrefabBuilder } from "../src/render/prefab/prefab-builder.js";
import { QuarksFx } from "../src/render/vfx/quarks-fx.js";
import { CharacterMaterial } from "../src/render/character/character-material.js";

before(() => {
  (globalThis as { window?: unknown }).window ??= globalThis;
});

const base = (material: THREE.Material = new THREE.MeshStandardMaterial({ color: 0x808080 })): THREE.Mesh => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), material);
  m.position.y = 1;
  return m;
};

describe("PrefabBuilder", () => {
  it("wears every signal of a legendary, and takes it all off again", () => {
    const fx = new QuarksFx();
    const bundle = composeCreature({ id: "fiend", name: "Fiend", tags: ["demon", "fire"] }, "legendary", { seed: 7 }).bundle;
    const shared = new THREE.MeshStandardMaterial({ color: 0x808080 });
    const body = base(shared);
    const inst = new PrefabBuilder(fx).build(bundle, body);
    const kinds = bundle.Prefab.attach.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["aura", "particles", "runes", "tint", "transform"]);
    assert.equal(fx.systems, 2, "particles and an aura");
    assert.ok(inst.root.getObjectByName("runes"), "a rune ring at the feet");
    assert.notEqual(body.material, shared, "a clone, never the shared material");
    assert.notEqual((body.material as THREE.MeshStandardMaterial).color.getHex(), 0x808080, "tinted");
    assert.equal(shared.color.getHex(), 0x808080, "the original untouched");
    const t = bundle.Prefab.attach.find((a) => a.kind === "transform")!;
    if (typeof t.params.scale === "number") assert.ok(Math.abs(body.parent!.scale.y - t.params.scale) < 1e-9, "the body transformed");
    inst.update(0.1, 1);
    inst.dispose();
    assert.equal(fx.systems, 0, "effects gone");
    assert.equal(body.material, shared, "the original back");
    assert.equal(body.parent, null, "the base released");
  });

  it("colours an item by its material, and a common item wears nothing", () => {
    const epic = composeItem("sword", "rare", { seed: 1 }).bundle;
    const sword = base();
    const inst = new PrefabBuilder(null).build(epic, sword);
    assert.ok(epic.Prefab.color);
    assert.notEqual((sword.material as THREE.MeshStandardMaterial).color.getHex(), 0x808080, "the material's colour");
    inst.dispose();
    const common = composeItem("sword", "common", { seed: 1 }).bundle as EntityBundle;
    const plain = base();
    const inst2 = new PrefabBuilder(null).build({ ...common, Prefab: { ...common.Prefab, color: null } }, plain);
    assert.equal(common.Prefab.attach.length, 0);
    assert.equal(inst2.root.children.length, 1, "just the body");
    inst2.dispose();
  });

  it("clones patched subclasses through their built-in class, keeping the patch", () => {
    const tex = { base: new THREE.Texture(), masks: [0, 1, 2, 3].map(() => new THREE.Texture()) };
    const cm = new CharacterMaterial(tex);
    const c = cloneMaterial(cm) as THREE.MeshStandardMaterial;
    assert.ok(c.isMeshStandardMaterial && !(c instanceof CharacterMaterial));
    assert.equal(c.map, tex.base);
    assert.equal(c.onBeforeCompile, cm.onBeforeCompile);
    assert.equal(c.customProgramCacheKey(), cm.customProgramCacheKey());
  });
});
