/**
 * Phase A1 regression test: Mesh2Motion clips must map >= the graded bone set
 * (66 bones) through the bake-side Retargeter using MANNEQUIN_MAP.
 *
 * The client-side retarget utility (apps/client/src/render/character/retarget.ts)
 * used fuzzy name matching and found only 16/66 bones. It has no live consumers
 * and is retired. The bake-side Retargeter with explicit bone maps is the single
 * source of truth. This test guards against regression: every canonical bone in
 * MANNEQUIN_MAP must have a source node, i.e. `retargeter.missing` is empty.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Retargeter } from "../src/convert/retarget.js";
import { MANNEQUIN_MAP } from "../src/convert/convert-animations.js";

function bone(name: string): THREE.Object3D {
  const b = new THREE.Object3D();
  b.name = name;
  return b;
}

describe("Retargeter bone mapping — Mesh2Motion regression", () => {
  it("maps every MANNEQUIN_MAP target bone to a source node (none missing)", () => {
    // Target rig: canonical bones from MANNEQUIN_MAP keys.
    const target = new THREE.Object3D();
    for (const name of Object.keys(MANNEQUIN_MAP)) {
      target.add(bone(name));
    }

    // Source rig: mannequin-style bones (Mesh2Motion skeleton convention).
    const source = new THREE.Object3D();
    const sourceBoneNames = new Set<string>(Object.values(MANNEQUIN_MAP));
    for (const name of sourceBoneNames) {
      source.add(bone(name));
    }

    const retargeter = new Retargeter(
      { scene: source, hips: "pelvis", map: MANNEQUIN_MAP },
      { scene: target, hips: "Hips" },
    );

    assert.equal(
      retargeter.missing.length,
      0,
      `Expected all MANNEQUIN_MAP bones to map; missing: ${retargeter.missing.join(", ")}`,
    );
  });
});
