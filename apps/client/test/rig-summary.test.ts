/**
 * The rig view's numbers: each vertex counts toward the bone with the most
 * weight, unweighted vertices are counted apart, and the rig's size comes through.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { summarizeRig, dominantBones } from "../src/render/animal/rig-summary.js";
import { BONE_BODY, BONE_HEAD, BONE_NAMES, type Segmentation } from "../src/render/animal/segment.js";

function seg(skin: Array<[number[], number[]]>): Segmentation {
  const skinIndex = new Uint16Array(skin.length * 4);
  const skinWeight = new Float32Array(skin.length * 4);
  skin.forEach(([idx, w], v) => {
    idx.forEach((b, k) => { skinIndex[v * 4 + k] = b; });
    w.forEach((x, k) => { skinWeight[v * 4 + k] = x; });
  });
  return {
    frame: { yaw: 0, dx: 0, dy: 0, dz: 0 } as Segmentation["frame"],
    length: 2, height: 1.2, width: 0.6, legLength: 0.5, kneeHeight: 0.2,
    pivots: [],
    skinIndex,
    skinWeight,
  };
}

describe("rig summary", () => {
  it("counts each vertex toward the bone with the most weight", () => {
    const s = seg([
      [[BONE_BODY, BONE_HEAD, 0, 0], [0.7, 0.3, 0, 0]], // body
      [[BONE_HEAD, BONE_BODY, 0, 0], [0.6, 0.4, 0, 0]], // head
      [[BONE_HEAD, 0, 0, 0], [1, 0, 0, 0]], // head
    ]);
    assert.deepEqual(Array.from(dominantBones(s, 3)), [BONE_BODY, BONE_HEAD, BONE_HEAD]);
    const r = summarizeRig(s, 3);
    assert.equal(r.bones.find((b) => b.name === BONE_NAMES[BONE_BODY])?.vertices, 1);
    assert.equal(r.bones.find((b) => b.name === BONE_NAMES[BONE_HEAD])?.vertices, 2);
    assert.equal(r.unweighted, 0);
  });

  it("counts a vertex with no weight apart, and keeps the rig's size and type", () => {
    const s = seg([[[0, 0, 0, 0], [0, 0, 0, 0]]]);
    const r = summarizeRig(s, 1);
    assert.equal(r.unweighted, 1);
    assert.equal(r.type, "quadruped");
    assert.equal(r.length, 2);
    assert.equal(r.legLength, 0.5);
  });
});
